// useSecureDevice — register this client as an MLS device (leaf), persist its identity, and keep its
// KeyPackages topped up.
//
// On mount it re-hydrates a persisted device (stable deviceId + private state via
// crypto.importDeviceState) so a reload does NOT mint a new identity. register() generates, registers
// on the server, and persists.
//
// KeyPackages are single-use (the server consumes one per group-add), so running dry means peers can't
// add this device. The hook keeps the stock topped up to `keyPackageTarget` from three triggers: the
// server's `secure:key-packages-low` realtime signal, a one-shot proactive count check once the device
// is ready (self-heals a client that missed the signal while offline), and an app-callable
// `checkAndReplenish()` (e.g. on window focus). Each top-up publishes only the DEFICIT to the target
// (using the actual available count), not a blind full batch.

import { useCallback, useEffect, useRef, useState } from "react";
import { SecureDeviceModel } from "../contract/index.js";
import { toBase64 } from "../util/base64.js";
import { createDebugLogger } from "../util/debug.js";
import { useSecureChat } from "../context/secure-chat-context.js";

const log = createDebugLogger("device");

/**
 * Mint a device id when the caller doesn't supply one — `crypto.randomUUID()` when available, else a
 * non-cryptographic timestamp+random fallback.
 *
 * @returns A fresh device id string.
 */
function newDeviceId(): string {
  const g = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (g?.randomUUID) return g.randomUUID();
  return `dev-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/** Options for {@link useSecureDevice}. */
export interface UseSecureDeviceOptions {
  /** Stable, persisted client device id. Generated (and persisted) if omitted. A previously
   *  persisted device's id takes precedence over this value when one exists on mount. */
  deviceId?: string;
  /** MLS ciphersuite to register under. Defaults to the crypto implementation's preferred suite. */
  ciphersuite?: number;
  /** How many KeyPackages to publish on registration and replenish toward. Default 20. */
  keyPackageTarget?: number;
  /**
   * Low-water mark: when the server's available count drops **below** this, a top-up refills to
   * {@link UseSecureDeviceOptions.keyPackageTarget}. KeyPackages are single-use, so this guards
   * against exhaustion (peers unable to add this device). Default `ceil(keyPackageTarget / 2)` (10 for
   * the default target of 20). Only governs the proactive/manual path — the server's
   * `secure:key-packages-low` signal always tops up, since the server already judged the stock low.
   */
  keyPackageLowWater?: number;
  /**
   * Auto-replenish without app involvement. Default true. When true the hook subscribes to
   * `secure:key-packages-low` and runs a one-shot proactive count check once the device is ready. When
   * false, both automatic paths are disabled but {@link UseSecureDeviceValues.checkAndReplenish}
   * still works on demand.
   */
  autoReplenish?: boolean;
}

/** The state and actions returned by {@link useSecureDevice}. */
export interface UseSecureDeviceValues {
  /** The registered device row (its `.id` is the uuid used as targetDeviceId everywhere). */
  device: SecureDeviceModel | null;
  /** True until the initial persisted-device load settles. */
  loading: boolean;
  /** True while {@link UseSecureDeviceValues.register} is in flight. */
  registering: boolean;
  /** The last error thrown by load, registration, or replenishment, or `null`. */
  error: unknown;
  /** Last known count of unconsumed KeyPackages, or `null` until refreshed. */
  keyPackagesAvailable: number | null;
  /** Generate identity + register (idempotent server-side on (userId, deviceId)) and persist it. */
  register: () => Promise<SecureDeviceModel>;
  /** Generate + publish `count` fresh KeyPackages (default = keyPackageTarget). */
  publishKeyPackages: (count?: number) => Promise<number>;
  /** Re-query the server for the available KeyPackage count and update `keyPackagesAvailable`. */
  refreshKeyPackageCount: () => Promise<number>;
  /**
   * Refresh the server count and, if it's below the low-water mark, top up to `keyPackageTarget`
   * (publishing only the deficit). Safe to call before {@link UseSecureDeviceValues.register} — it
   * no-ops to 0 when there's no device and never throws for that case — so an app can wire it to a
   * window-focus / app-foreground handler.
   */
  checkAndReplenish: () => Promise<number>;
}

/**
 * Register this client as an MLS device, persist its identity, and keep KeyPackages stocked.
 *
 * On mount it loads any persisted device and re-hydrates the crypto identity (stable id, no
 * re-register). When none exists, await {@link UseSecureDeviceValues.register}.
 *
 * @param options - {@link UseSecureDeviceOptions}.
 * @returns {@link UseSecureDeviceValues}.
 *
 * @example
 * ```tsx
 * const { device, loading, register } = useSecureDevice();
 * useEffect(() => { if (!loading && !device) register(); }, [loading, device, register]);
 * ```
 */
export function useSecureDevice(options: UseSecureDeviceOptions = {}): UseSecureDeviceValues {
  const { crypto, rest, socket, repo } = useSecureChat();
  const { ciphersuite, keyPackageTarget = 20, autoReplenish = true } = options;
  const keyPackageLowWater = options.keyPackageLowWater ?? Math.ceil(keyPackageTarget / 2);

  const [device, setDevice] = useState<SecureDeviceModel | null>(null);
  const [loading, setLoading] = useState(true);
  const [registering, setRegistering] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [keyPackagesAvailable, setKeyPackagesAvailable] = useState<number | null>(null);

  const deviceIdRef = useRef<string>(options.deviceId ?? newDeviceId());
  const registerStartedRef = useRef(false);
  // Guards the one-shot proactive count check so it runs once per device-ready, not on every render.
  const proactiveCheckedRef = useRef(false);

  // On mount: re-hydrate a persisted device (stable id + private state). No persisted device ⇒
  // first-run; the app calls register().
  useEffect(() => {
    let alive = true;
    (async () => {
      const persisted = await repo.loadDevice();
      // DEAD CLOSURE — this effect run was superseded. React StrictMode (dev) mounts every effect
      // twice: run → cleanup → run, and the cleanup flips this closure's `alive` to false. A superseded
      // run MUST NOT touch React state. The critical line is that it must NOT call setLoading(false):
      // doing so flips loading→false while `device` is still null, which makes the app's typical
      // `if (!loading && !device) register()` bootstrap fire a SPURIOUS registration BEFORE the live
      // remount can rehydrate the persisted device. That premature register() is the root cause of
      // device churn — a brand-new server device row on every reload. So a dead run just returns and
      // leaves all state (loading included) to the live run. (Was: `if (!alive || registerStarted)
      // setLoading(false)` — folding `!alive` into the loading-settle was the bug.)
      if (!alive) return;
      // LIVE run, but register() already started (the app called it eagerly). Don't clobber its
      // identity — but loading IS this run's to settle, so flip it off.
      if (registerStartedRef.current) {
        setLoading(false);
        return;
      }
      if (persisted && persisted.device) {
        // SPLIT-BRAIN RECONCILE. A device can be persisted locally while the server no longer has its
        // row (DB wiped, or the device was revoked). Adopting that ghost is fatal: every device-scoped
        // call (handshake catch-up, key-package count, conversation create) then 404s forever, and the
        // app never recovers because `device` looks set so the `!device ⇒ register()` bootstrap never
        // fires. So verify server-side BEFORE adopting. A definitive 404 ⇒ wipe ALL local secure-chat
        // state (device + every ghost group + cursor) and fall through to the no-device path, so the app
        // re-registers clean. A transient probe error keeps the identity (offline tolerance — see
        // deviceExists). Skip the probe entirely if register() already started; it does its own verify.
        let serverHasDevice = true;
        try {
          serverHasDevice = await rest.deviceExists(persisted.device.id);
        } catch (probeErr) {
          log.debug("device existence probe failed (transient) — keeping persisted identity", {
            error: String(probeErr),
          });
        }
        if (!alive) return;
        if (registerStartedRef.current) {
          setLoading(false);
          return;
        }
        if (!serverHasDevice) {
          log.debug("persisted device missing server-side — clearing local state, will re-register", {
            deviceId: persisted.deviceId,
          });
          await repo.clearAll();
          if (!alive) return;
          log.debug("no persisted device — awaiting register()");
        } else {
          await crypto.importDeviceState(persisted.deviceState);
          // We awaited importDeviceState — re-check the same way. Dead closure ⇒ bail without touching
          // state; register-started ⇒ settle loading but keep register()'s identity.
          if (!alive) return;
          if (registerStartedRef.current) {
            setLoading(false);
            return;
          }
          deviceIdRef.current = persisted.deviceId;
          setDevice(persisted.device);
          log.debug("re-hydrated persisted device", { deviceId: persisted.deviceId });
        }
      } else {
        log.debug("no persisted device — awaiting register()");
      }
      setLoading(false);
    })().catch((err) => {
      if (!alive) return;
      setError(err);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [repo, crypto, rest]);

  const publishKeyPackages = useCallback(
    async (count: number = keyPackageTarget): Promise<number> => {
      if (!device) throw new Error("Register the device before publishing KeyPackages.");
      const bundles = await crypto.generateKeyPackages(count);
      const published = await rest.publishKeyPackages(device.id, {
        keyPackages: bundles.map((b) => ({
          keyPackageRef: b.keyPackageRef,
          keyPackage: toBase64(b.keyPackage),
          ciphersuite: b.ciphersuite,
          expiresAt: b.expiresAt,
        })),
      });
      return published;
    },
    [crypto, rest, device, keyPackageTarget]
  );

  const refreshKeyPackageCount = useCallback(async (): Promise<number> => {
    if (!device) throw new Error("Register the device before checking KeyPackage count.");
    const available = await rest.keyPackageCount(device.id);
    setKeyPackagesAvailable(available);
    return available;
  }, [rest, device]);

  // Publish only the shortfall (target − available) to refill to the target; nothing if already
  // at/above it. Optimistically bumps the local count so the UI reflects the refill without a re-query.
  // Callers guarantee `device` exists (publishKeyPackages throws otherwise).
  const replenishToTarget = useCallback(
    async (available: number): Promise<number> => {
      const deficit = keyPackageTarget - available;
      if (deficit <= 0) {
        log.trace("key-packages at/above target — no top-up", { available, target: keyPackageTarget });
        return 0;
      }
      const published = await publishKeyPackages(deficit);
      setKeyPackagesAvailable(available + published);
      log.debug("replenished key-packages", {
        available,
        target: keyPackageTarget,
        deficit,
        published,
      });
      return published;
    },
    [keyPackageTarget, publishKeyPackages]
  );

  const checkAndReplenish = useCallback(async (): Promise<number> => {
    if (!device) return 0; // not registered yet — no-op (app may call this eagerly on focus)
    const available = await refreshKeyPackageCount();
    if (available >= keyPackageLowWater) return 0;
    return replenishToTarget(available);
  }, [device, refreshKeyPackageCount, keyPackageLowWater, replenishToTarget]);

  const register = useCallback(async (): Promise<SecureDeviceModel> => {
    registerStartedRef.current = true;
    setRegistering(true);
    setError(null);
    try {
      // IDEMPOTENCY GUARD (defense-in-depth against device churn). register() can be invoked
      // spuriously — the app's `if (!loading && !device) register()` can fire during a mount race, a
      // re-render, or a double-tap — and a naive register() mints a NEW identity + server device row
      // every time. So first re-check persistence: if a device is already stored AND its private crypto
      // state still imports, ADOPT it (re-import + set state) and return WITHOUT minting. Re-importing
      // is cheap and idempotent, so this makes register() safe to call repeatedly: one persisted device
      // per client, not one per call. This complements the StrictMode mount-effect fix above — that
      // prevents the spurious trigger; this neutralises it if it happens anyway.
      // If the persisted state is unusable (corrupt, crypto-version skew, or importDeviceState throws),
      // fall through to a fresh registration. SPLIT-BRAIN: a device can be persisted locally while the
      // server no longer has its row (DB wiped / device revoked). Adopting that ghost makes every
      // device-scoped call 404 forever, so verify server-side first — a definitive 404 ⇒ wipe ALL local
      // state (device + ghost groups + cursor) and register fresh; a transient probe error keeps the
      // identity and adopts (offline tolerance — see deviceExists).
      const persisted = await repo.loadDevice();
      if (persisted && persisted.device) {
        let serverHasDevice = true;
        try {
          serverHasDevice = await rest.deviceExists(persisted.device.id);
        } catch (probeErr) {
          log.debug("device existence probe failed (transient) — adopting persisted device", {
            error: String(probeErr),
          });
        }
        if (serverHasDevice) {
          try {
            await crypto.importDeviceState(persisted.deviceState);
            deviceIdRef.current = persisted.deviceId;
            setDevice(persisted.device);
            log.debug("adopted persisted device (skipped re-register)", { deviceId: persisted.deviceId });
            return persisted.device;
          } catch (importErr) {
            log.debug("persisted device unusable — registering fresh", { error: String(importErr) });
          }
        } else {
          log.debug("persisted device missing server-side — clearing local state, registering fresh", {
            deviceId: persisted.deviceId,
          });
          await repo.clearAll();
        }
      }
      const { identity } = await crypto.generateDeviceIdentity({
        deviceId: deviceIdRef.current,
        ciphersuite,
      });
      const registered = await rest.registerDevice({
        deviceId: identity.deviceId,
        signaturePublicKey: toBase64(identity.signaturePublicKey),
        credential: toBase64(identity.credential),
        ciphersuite: identity.ciphersuite,
      });
      const deviceState = await crypto.exportDeviceState();
      await repo.saveDevice({ deviceId: identity.deviceId, deviceState, device: registered });
      deviceIdRef.current = identity.deviceId;
      setDevice(registered);
      log.debug("registered device", { deviceId: identity.deviceId, ciphersuite: identity.ciphersuite });
      return registered;
    } catch (err) {
      setError(err);
      throw err;
    } finally {
      setRegistering(false);
    }
  }, [crypto, rest, repo, ciphersuite]);

  // Auto-replenish on the server's low-water signal for this device. We top up to the target using the
  // count the signal reports (not a blind full batch), and trust the server's "low" verdict — the
  // client `keyPackageLowWater` only gates the proactive path below.
  useEffect(() => {
    if (!autoReplenish || !device) return;
    const off = socket.on("secure:key-packages-low", (signal) => {
      if (signal.deviceId !== device.id) return; // device.id is the server ROW id, not the deviceId
      log.debug("server signalled key-packages low", { deviceId: device.id, available: signal.available });
      setKeyPackagesAvailable(signal.available);
      replenishToTarget(signal.available).catch(setError);
    });
    return off;
  }, [autoReplenish, device, socket, replenishToTarget]);

  // One-shot proactive top-up once the device is ready (covers both register and rehydrate-on-mount),
  // so a client that missed the realtime signal while offline self-heals on next load.
  useEffect(() => {
    if (!autoReplenish || !device || proactiveCheckedRef.current) return;
    proactiveCheckedRef.current = true;
    checkAndReplenish().catch(setError);
  }, [autoReplenish, device, checkAndReplenish]);

  return {
    device,
    loading,
    registering,
    error,
    keyPackagesAvailable,
    register,
    publishKeyPackages,
    refreshKeyPackageCount,
    checkAndReplenish,
  };
}
