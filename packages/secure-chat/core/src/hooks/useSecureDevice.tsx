// useSecureDevice — register this client as an MLS device (leaf), persist its identity, and keep its
// KeyPackages topped up.
//
// On mount it re-hydrates a persisted device (stable deviceId + private state via
// crypto.importDeviceState) so a reload does NOT mint a new identity. register() generates, registers
// on the server, and persists. Replenishes on the `secure:key-packages-low` realtime signal.

import { useCallback, useEffect, useRef, useState } from "react";
import { SecureDeviceModel } from "../contract/index.js";
import { toBase64 } from "../util/base64.js";
import { useSecureChat } from "../context/secure-chat-context.js";

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
  /** Stable, persisted client device id. Generated (and persisted) if omitted. */
  deviceId?: string;
  /** MLS ciphersuite to register under. Defaults to the crypto implementation's preferred suite. */
  ciphersuite?: number;
  /** How many KeyPackages to publish on registration and replenish toward. Default 20. */
  keyPackageTarget?: number;
  /** Auto-replenish when `secure:key-packages-low` fires. Default true. */
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
 * useEffect(() => { if (!loading && !device) register(); }, [loading, device]);
 * ```
 */
export function useSecureDevice(options: UseSecureDeviceOptions = {}): UseSecureDeviceValues {
  const { crypto, rest, socket, repo } = useSecureChat();
  const { ciphersuite, keyPackageTarget = 20, autoReplenish = true } = options;

  const [device, setDevice] = useState<SecureDeviceModel | null>(null);
  const [loading, setLoading] = useState(true);
  const [registering, setRegistering] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [keyPackagesAvailable, setKeyPackagesAvailable] = useState<number | null>(null);

  const deviceIdRef = useRef<string>(options.deviceId ?? newDeviceId());

  // On mount: re-hydrate a persisted device (stable id + private state). No persisted device ⇒
  // first-run; the app calls register().
  useEffect(() => {
    let alive = true;
    (async () => {
      const persisted = await repo.loadDevice();
      if (!alive) return;
      if (persisted) {
        await crypto.importDeviceState(persisted.deviceState);
        if (!alive) return;
        deviceIdRef.current = persisted.deviceId;
        setDevice(persisted.device);
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
  }, [repo, crypto]);

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

  const register = useCallback(async (): Promise<SecureDeviceModel> => {
    setRegistering(true);
    setError(null);
    try {
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
      return registered;
    } catch (err) {
      setError(err);
      throw err;
    } finally {
      setRegistering(false);
    }
  }, [crypto, rest, repo, ciphersuite]);

  // Auto-replenish on the server's low-water signal for this device.
  useEffect(() => {
    if (!autoReplenish || !device) return;
    const off = socket.on("secure:key-packages-low", (signal) => {
      if (signal.deviceId !== device.id) return;
      publishKeyPackages().catch(setError);
    });
    return off;
  }, [autoReplenish, device, socket, publishKeyPackages]);

  return {
    device,
    loading,
    registering,
    error,
    keyPackagesAvailable,
    register,
    publishKeyPackages,
    refreshKeyPackageCount,
  };
}
