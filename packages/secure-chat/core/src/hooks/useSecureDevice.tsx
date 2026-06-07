// useSecureDevice — register this client as an MLS device (leaf) and keep its KeyPackages topped up.
//
// Flow (server spec §14): generateDeviceIdentity → POST /devices → publish a batch of KeyPackages;
// replenish on the `secure:key-packages-low` realtime signal or via the count endpoint.
//
// NOTE: the device's PRIVATE state (`privateState` from generateDeviceIdentity, and MLS group
// state) must be persisted by the platform layer (IndexedDB on web, keystore on native — Phase 2/3).
// Core only performs registration + relay; it does not persist secrets.

import { useCallback, useEffect, useRef, useState } from "react";
import { SecureDeviceModel } from "../contract/index.js";
import { toBase64 } from "../util/base64.js";
import { useSecureChat } from "../context/secure-chat-context.js";

/**
 * Mint a device id when the caller doesn't supply one — `crypto.randomUUID()` when available, else a
 * non-cryptographic timestamp+random fallback. The platform layer should supply a persisted id.
 *
 * @returns A fresh device id string.
 */
function newDeviceId(): string {
  const g = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (g?.randomUUID) return g.randomUUID();
  // Platform layer should supply a persisted, stable device id; this is a non-crypto fallback.
  return `dev-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/** Options for {@link useSecureDevice}. */
export interface UseSecureDeviceOptions {
  /** Stable, persisted client device id. Generated if omitted (persist it in the platform layer). */
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
  /** True while {@link UseSecureDeviceValues.register} is in flight. */
  registering: boolean;
  /** The last error thrown by registration or replenishment, or `null`. */
  error: unknown;
  /** Last known count of unconsumed KeyPackages, or `null` until refreshed. */
  keyPackagesAvailable: number | null;
  /** Generate identity + register (idempotent server-side on (userId, deviceId)). */
  register: () => Promise<SecureDeviceModel>;
  /** Generate + publish `count` fresh KeyPackages (default = keyPackageTarget). */
  publishKeyPackages: (count?: number) => Promise<number>;
  /** Re-query the server for the available KeyPackage count and update `keyPackagesAvailable`. */
  refreshKeyPackageCount: () => Promise<number>;
}

/**
 * Register this client as an MLS device (one device = one leaf) and keep its KeyPackages stocked.
 *
 * On {@link UseSecureDeviceValues.register} it generates a device identity, POSTs it to `/devices`,
 * and (when `autoReplenish` is on) republishes KeyPackages whenever the server emits
 * `secure:key-packages-low` for this device. The device's private key material must be persisted by
 * the platform layer — this hook only handles registration and relay.
 *
 * @param options - {@link UseSecureDeviceOptions} — device id, ciphersuite, and replenishment tuning.
 * @returns {@link UseSecureDeviceValues} — the device row, status flags, and register/publish actions.
 *
 * @example
 * ```tsx
 * const { device, register } = useSecureDevice({ keyPackageTarget: 20 });
 * useEffect(() => { register(); }, []);
 * ```
 */
export function useSecureDevice(options: UseSecureDeviceOptions = {}): UseSecureDeviceValues {
  const { crypto, rest, socket } = useSecureChat();
  const { ciphersuite, keyPackageTarget = 20, autoReplenish = true } = options;

  const [device, setDevice] = useState<SecureDeviceModel | null>(null);
  const [registering, setRegistering] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [keyPackagesAvailable, setKeyPackagesAvailable] = useState<number | null>(null);

  const deviceIdRef = useRef<string>(options.deviceId ?? newDeviceId());

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
      setDevice(registered);
      return registered;
    } catch (err) {
      setError(err);
      throw err;
    } finally {
      setRegistering(false);
    }
  }, [crypto, rest, ciphersuite]);

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
    registering,
    error,
    keyPackagesAvailable,
    register,
    publishKeyPackages,
    refreshKeyPackageCount,
  };
}
