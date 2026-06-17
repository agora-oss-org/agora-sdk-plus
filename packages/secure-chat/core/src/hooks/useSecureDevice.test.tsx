// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { MockSecureChatCrypto } from "@agora-sdk/secure-chat-crypto/testing";
import { SecureChatProvider } from "../context/secure-chat-context.js";
import { useSecureDevice } from "./useSecureDevice.js";
import { MemoryStore } from "../persistence/memory-store.js";
import { SecureChatRepository } from "../persistence/repository.js";
import { SecureChatRestClient } from "../transport/rest.js";
import { SecureChatSocketClient } from "../transport/socket.js";
import type { SecureDeviceModel } from "../contract/index.js";

const row = (id: string, deviceId: string): SecureDeviceModel => ({
  id, projectId: "p", userId: "u", deviceId, displayName: null,
  signaturePublicKey: "", credential: "", ciphersuite: 1,
  revokedAt: null, lastSeenAt: null, createdAt: "", updatedAt: "",
});

function wrap(crypto: MockSecureChatCrypto, store: MemoryStore) {
  return ({ children }: { children: React.ReactNode }) => (
    <SecureChatProvider crypto={crypto} projectId="p" store={store} accessToken="t">
      {children}
    </SecureChatProvider>
  );
}

// Captured `secure:*` handlers so a test can fire the server's low-water signal by hand, plus default
// spies for the replenishment transport (overridden per-test). `publishKeyPackages` resolves to the
// number it was asked to publish, so asserting `mock.calls[i][1].keyPackages.length` checks the deficit.
let handlers: Record<string, (...a: unknown[]) => void>;
let countSpy: ReturnType<typeof vi.spyOn>;
let pubSpy: ReturnType<typeof vi.spyOn>;
let existsSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  handlers = {};
  vi.spyOn(SecureChatSocketClient.prototype, "on").mockImplementation((event, handler) => {
    handlers[event as string] = handler as (...a: unknown[]) => void;
    return () => { delete handlers[event as string]; };
  });
  // Default: well-stocked, so the proactive on-ready check no-ops unless a test lowers it.
  countSpy = vi.spyOn(SecureChatRestClient.prototype, "keyPackageCount").mockResolvedValue(100);
  pubSpy = vi
    .spyOn(SecureChatRestClient.prototype, "publishKeyPackages")
    .mockImplementation(async (_id, body) => body.keyPackages.length);
  // Default: the server still has the device, so verify-on-adopt adopts the persisted identity.
  // Split-brain tests override this to false (server lost the row) or reject (transient probe error).
  existsSpy = vi.spyOn(SecureChatRestClient.prototype, "deviceExists").mockResolvedValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe("useSecureDevice", () => {
  it("registers and persists the device", async () => {
    const reg = vi
      .spyOn(SecureChatRestClient.prototype, "registerDevice")
      .mockResolvedValue(row("row-1", "dev-x"));
    const crypto = new MockSecureChatCrypto();
    const store = new MemoryStore();

    const { result } = renderHook(() => useSecureDevice({ deviceId: "dev-x" }), {
      wrapper: wrap(crypto, store),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.register();
    });

    expect(reg).toHaveBeenCalledOnce();
    expect(result.current.device?.id).toBe("row-1");
    const persisted = await new SecureChatRepository(store).loadDevice();
    expect(persisted?.deviceId).toBe("dev-x");
    expect(persisted?.device?.id).toBe("row-1");
  });

  it("re-hydrates a persisted device on mount without re-registering", async () => {
    const reg = vi.spyOn(SecureChatRestClient.prototype, "registerDevice");
    const crypto = new MockSecureChatCrypto();
    const store = new MemoryStore();

    await crypto.generateDeviceIdentity({ deviceId: "dev-x" });
    const deviceState = await crypto.exportDeviceState();
    await new SecureChatRepository(store).saveDevice({
      deviceId: "dev-x",
      deviceState,
      device: row("row-1", "dev-x"),
    });

    const fresh = new MockSecureChatCrypto();
    const importSpy = vi.spyOn(fresh, "importDeviceState");
    const { result } = renderHook(() => useSecureDevice(), { wrapper: wrap(fresh, store) });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.device?.id).toBe("row-1");
    expect(reg).not.toHaveBeenCalled();
    // Re-hydration must replay the persisted private state through the crypto seam. Compare by
    // content: the bytes are base64 round-tripped on the way out of the store, so the array passed
    // is an equal-but-distinct instance (different backing buffer) than the one we seeded.
    expect(importSpy).toHaveBeenCalledOnce();
    expect(Array.from(importSpy.mock.calls[0][0])).toEqual(Array.from(deviceState));
  });

  // ── KeyPackage replenishment (task 3) ───────────────────────────────────────

  /** Register, returning the hook result once the device row is set. */
  async function renderRegistered(crypto: MockSecureChatCrypto, store: MemoryStore, opts = {}) {
    vi.spyOn(SecureChatRestClient.prototype, "registerDevice").mockResolvedValue(row("row-1", "dev-x"));
    const view = renderHook(() => useSecureDevice({ deviceId: "dev-x", ...opts }), {
      wrapper: wrap(crypto, store),
    });
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    await act(async () => {
      await view.result.current.register();
    });
    return view.result;
  }

  it("proactively tops up to target on device-ready when below low-water", async () => {
    countSpy.mockResolvedValue(3); // target 20, default low-water 10 ⇒ deficit 17
    const result = await renderRegistered(new MockSecureChatCrypto(), new MemoryStore());

    await waitFor(() => expect(pubSpy).toHaveBeenCalled());
    expect((pubSpy.mock.calls[0][1] as { keyPackages: unknown[] }).keyPackages).toHaveLength(17);
    await waitFor(() => expect(result.current.keyPackagesAvailable).toBe(20));
  });

  it("does not replenish on device-ready when already stocked", async () => {
    countSpy.mockResolvedValue(15); // ≥ low-water 10
    const result = await renderRegistered(new MockSecureChatCrypto(), new MemoryStore());

    await waitFor(() => expect(countSpy).toHaveBeenCalled());
    expect(pubSpy).not.toHaveBeenCalled();
    expect(result.current.keyPackagesAvailable).toBe(15);
  });

  it("tops up to target from signal.available on the secure:key-packages-low event", async () => {
    const result = await renderRegistered(new MockSecureChatCrypto(), new MemoryStore());
    await waitFor(() => expect(handlers["secure:key-packages-low"]).toBeDefined());

    await act(async () => {
      handlers["secure:key-packages-low"]({ deviceId: "row-1", available: 4 });
    });

    await waitFor(() => expect(pubSpy).toHaveBeenCalled());
    expect((pubSpy.mock.calls[0][1] as { keyPackages: unknown[] }).keyPackages).toHaveLength(16); // 20 − 4
    await waitFor(() => expect(result.current.keyPackagesAvailable).toBe(20));
  });

  it("ignores a low-water signal for a different device", async () => {
    await renderRegistered(new MockSecureChatCrypto(), new MemoryStore());
    await waitFor(() => expect(handlers["secure:key-packages-low"]).toBeDefined());

    await act(async () => {
      handlers["secure:key-packages-low"]({ deviceId: "someone-else", available: 0 });
    });

    expect(pubSpy).not.toHaveBeenCalled();
  });

  it("checkAndReplenish() no-ops to 0 before register (no throw)", async () => {
    const { result } = renderHook(() => useSecureDevice({ deviceId: "dev-x" }), {
      wrapper: wrap(new MockSecureChatCrypto(), new MemoryStore()),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let published: number | undefined;
    await act(async () => {
      published = await result.current.checkAndReplenish();
    });
    expect(published).toBe(0);
    expect(countSpy).not.toHaveBeenCalled();
  });

  it("respects a custom keyPackageTarget (and derived low-water)", async () => {
    countSpy.mockResolvedValue(3); // target 8, default low-water ceil(8/2)=4 ⇒ deficit 5
    await renderRegistered(new MockSecureChatCrypto(), new MemoryStore(), { keyPackageTarget: 8 });

    await waitFor(() => expect(pubSpy).toHaveBeenCalled());
    expect((pubSpy.mock.calls[0][1] as { keyPackages: unknown[] }).keyPackages).toHaveLength(5);
  });

  it("autoReplenish:false disables the automatic paths but keeps checkAndReplenish() working", async () => {
    const result = await renderRegistered(new MockSecureChatCrypto(), new MemoryStore(), {
      autoReplenish: false,
    });

    // No proactive count check, and no low-water subscription to fire.
    expect(countSpy).not.toHaveBeenCalled();
    expect(handlers["secure:key-packages-low"]).toBeUndefined();
    expect(pubSpy).not.toHaveBeenCalled();

    // Manual replenishment still works on demand.
    countSpy.mockResolvedValue(3); // target 20, low-water 10 ⇒ deficit 17
    let published: number | undefined;
    await act(async () => {
      published = await result.current.checkAndReplenish();
    });
    expect(published).toBe(17);
    expect((pubSpy.mock.calls[0][1] as { keyPackages: unknown[] }).keyPackages).toHaveLength(17);
  });

  // ── Device-churn guard ──────────────────────────────────────────────────────
  // Regression for the bug where every reload minted a NEW server device row (one per StrictMode
  // dev remount) instead of reusing the persisted one. Two layers are tested: register() idempotency
  // (adopt, don't mint) and the StrictMode mount-race that used to trigger the spurious register().

  /** Seed `store` with a persisted, importable device row-1 / dev-x. */
  async function seedPersistedDevice(store: MemoryStore) {
    const seed = new MockSecureChatCrypto();
    await seed.generateDeviceIdentity({ deviceId: "dev-x" });
    const deviceState = await seed.exportDeviceState();
    await new SecureChatRepository(store).saveDevice({
      deviceId: "dev-x",
      deviceState,
      device: row("row-1", "dev-x"),
    });
  }

  it("register() adopts an existing persisted device instead of minting a new one", async () => {
    const store = new MemoryStore();
    await seedPersistedDevice(store);
    const reg = vi.spyOn(SecureChatRestClient.prototype, "registerDevice");

    // A DIFFERENT deviceId option simulates a spurious register() that's unaware a device is stored.
    // It must still ADOPT the persisted device (one device per client) — never mint "fresh-id".
    const { result } = renderHook(() => useSecureDevice({ deviceId: "fresh-id" }), {
      wrapper: wrap(new MockSecureChatCrypto(), store),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.register();
    });

    expect(reg).not.toHaveBeenCalled(); // adopted — no server registration, no churn
    expect(result.current.device?.id).toBe("row-1");
  });

  it("does not churn a new device under StrictMode when one is persisted", async () => {
    const store = new MemoryStore();
    await seedPersistedDevice(store);
    const reg = vi.spyOn(SecureChatRestClient.prototype, "registerDevice");

    // StrictMode double-invokes effects (mount → cleanup → mount) in dev. Pre-fix, the dead first run
    // flipped loading→false with device still null, so the eager bootstrap below fired register() and
    // minted a churn device. Post-fix the dead run leaves loading alone and register() adopts — so the
    // persisted device is used and registerDevice is never called.
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <React.StrictMode>
        <SecureChatProvider crypto={new MockSecureChatCrypto()} projectId="p" store={store} accessToken="t">
          {children}
        </SecureChatProvider>
      </React.StrictMode>
    );
    const { result } = renderHook(
      () => {
        const d = useSecureDevice();
        // Mirror the app's typical bootstrap: register once the load settles with no device.
        React.useEffect(() => {
          if (!d.loading && !d.device) void d.register();
        }, [d.loading, d.device, d.register]);
        return d;
      },
      { wrapper }
    );

    await waitFor(() => expect(result.current.device?.id).toBe("row-1"));
    expect(reg).not.toHaveBeenCalled();
  });

  // ── Split-brain reconciliation ──────────────────────────────────────────────
  // The client can persist a device the server no longer has (DB wiped, or device revoked). Adopting
  // that ghost makes every device-scoped call 404 forever with no recovery. verify-on-adopt probes the
  // server (rest.deviceExists) before trusting local identity: a definitive 404 ⇒ clearAll() + fall
  // through to a fresh register; a transient probe error ⇒ keep the identity (don't nuke crypto state).

  it("mount does NOT adopt a persisted device the server has lost — it clears local state", async () => {
    const store = new MemoryStore();
    await seedPersistedDevice(store);
    existsSpy.mockResolvedValue(false); // server no longer has row-1

    const { result } = renderHook(() => useSecureDevice(), {
      wrapper: wrap(new MockSecureChatCrypto(), store),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Ghost not adopted, and persisted state wiped so the app's bootstrap can re-register clean.
    expect(result.current.device).toBeNull();
    expect(await new SecureChatRepository(store).loadDevice()).toBeNull();
  });

  it("register() reconciles a ghost device by clearing local state and registering fresh", async () => {
    const store = new MemoryStore();
    // Mount with an EMPTY store so the mount effect no-ops; this isolates register()'s own reconcile.
    const { result } = renderHook(() => useSecureDevice({ deviceId: "dev-new" }), {
      wrapper: wrap(new MockSecureChatCrypto(), store),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    // A ghost now sits in the store (left over from a prior session) but the server has lost it.
    await seedPersistedDevice(store);
    existsSpy.mockResolvedValue(false);
    const reg = vi
      .spyOn(SecureChatRestClient.prototype, "registerDevice")
      .mockResolvedValue(row("row-2", "dev-new"));

    await act(async () => {
      await result.current.register();
    });

    expect(reg).toHaveBeenCalledOnce(); // ghost NOT adopted — minted fresh
    expect(result.current.device?.id).toBe("row-2");
    // The fresh device replaced the ghost in the store (clearAll wiped it, then saveDevice persisted row-2).
    expect((await new SecureChatRepository(store).loadDevice())?.device?.id).toBe("row-2");
  });

  it("keeps and adopts the persisted device when the existence probe fails transiently", async () => {
    const store = new MemoryStore();
    await seedPersistedDevice(store);
    existsSpy.mockRejectedValue(new Error("network down")); // transient — NOT a definitive 404
    const reg = vi.spyOn(SecureChatRestClient.prototype, "registerDevice");

    const { result } = renderHook(() => useSecureDevice(), {
      wrapper: wrap(new MockSecureChatCrypto(), store),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    // A blip must never destroy a working local identity: adopt row-1, don't register fresh or clear.
    expect(result.current.device?.id).toBe("row-1");
    expect(reg).not.toHaveBeenCalled();
    expect(await new SecureChatRepository(store).loadDevice()).not.toBeNull();
  });
});
