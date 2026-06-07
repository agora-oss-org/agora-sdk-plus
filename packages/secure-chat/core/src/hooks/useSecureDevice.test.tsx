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

beforeEach(() => {
  vi.spyOn(SecureChatSocketClient.prototype, "on").mockReturnValue(() => {});
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
    await new SecureChatRepository(store).saveDevice({
      deviceId: "dev-x",
      deviceState: await crypto.exportDeviceState(),
      device: row("row-1", "dev-x"),
    });

    const fresh = new MockSecureChatCrypto();
    const { result } = renderHook(() => useSecureDevice(), { wrapper: wrap(fresh, store) });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.device?.id).toBe("row-1");
    expect(reg).not.toHaveBeenCalled();
  });
});
