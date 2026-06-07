// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { MockSecureChatCrypto } from "@agora-sdk/secure-chat-crypto/testing";
import { SecureChatProvider } from "../context/secure-chat-context.js";
import { useSecureMessages } from "./useSecureMessages.js";
import { MemoryStore } from "../persistence/memory-store.js";
import { SecureChatRepository } from "../persistence/repository.js";
import { SecureChatRestClient } from "../transport/rest.js";
import { SecureChatSocketClient } from "../transport/socket.js";
import type { SecureDeviceModel, SecureMessageModel } from "../contract/index.js";

const row: SecureDeviceModel = {
  id: "row-1", projectId: "p", userId: "u", deviceId: "me", displayName: null,
  signaturePublicKey: "", credential: "", ciphersuite: 1,
  revokedAt: null, lastSeenAt: null, createdAt: "", updatedAt: "",
};

function wrap(crypto: MockSecureChatCrypto, store: MemoryStore) {
  return ({ children }: { children: React.ReactNode }) => (
    <SecureChatProvider crypto={crypto} projectId="p" store={store} accessToken="t">
      {children}
    </SecureChatProvider>
  );
}

beforeEach(() => {
  vi.spyOn(SecureChatSocketClient.prototype, "on").mockReturnValue(() => {});
  vi.spyOn(SecureChatSocketClient.prototype, "joinConversation").mockReturnValue(undefined);
  vi.spyOn(SecureChatRestClient.prototype, "listMessages").mockResolvedValue({
    messages: [], hasMore: false,
  });
});
afterEach(() => vi.restoreAllMocks());

describe("useSecureMessages", () => {
  it("auto-resolves the group + sender and sends encrypted with the persisted device id", async () => {
    const crypto = new MockSecureChatCrypto();
    await crypto.generateDeviceIdentity({ deviceId: "me" });
    const { group } = await crypto.createGroup({ initialMembers: [] });
    const store = new MemoryStore();
    const repo = new SecureChatRepository(store);
    await repo.saveGroupState("conv-1", await crypto.exportGroupState(group));
    await repo.saveDevice({ deviceId: "me", deviceState: await crypto.exportDeviceState(), device: row });

    let sentBody: { ciphertext: string; senderDeviceId: string } | undefined;
    vi.spyOn(SecureChatRestClient.prototype, "sendMessage").mockImplementation(
      async (_conv: string, body): Promise<SecureMessageModel> => {
        sentBody = body as { ciphertext: string; senderDeviceId: string };
        return {
          id: "m1", projectId: "p", conversationId: "conv-1", senderUserId: "u",
          senderDeviceId: "row-1", epoch: "0", ciphertext: body.ciphertext,
          contentType: "text/plain", createdAt: "",
        };
      }
    );

    const { result } = renderHook(() => useSecureMessages("conv-1"), { wrapper: wrap(crypto, store) });
    await waitFor(() => expect(result.current.loading).toBe(false));

    // The group handle + sender resolve in async effects. sendMessage throws (before any side
    // effect) until both are ready, so retrying inside waitFor is safe and deterministic — it stops
    // on the first success.
    await waitFor(async () => {
      await result.current.sendMessage("hi");
    });

    expect(sentBody?.senderDeviceId).toBe("row-1");
    expect(result.current.messages[0]?.plaintext).toBe("hi");
  });
});
