// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { MockSecureChatCrypto } from "@agora-sdk/secure-chat-crypto/testing";
import { SecureChatProvider } from "../context/secure-chat-context.js";
import { useSecureConversations } from "./useSecureConversations.js";
import { MemoryStore } from "../persistence/memory-store.js";
import { SecureChatRestClient } from "../transport/rest.js";
import { SecureChatSocketClient } from "../transport/socket.js";
import type { SecureConversationModel, SecureDeviceModel } from "../contract/index.js";

const deviceRow: SecureDeviceModel = {
  id: "peer-dev", projectId: "p", userId: "peer", deviceId: "peer-dev", displayName: null,
  signaturePublicKey: "", credential: "", ciphersuite: 1,
  revokedAt: null, lastSeenAt: null, createdAt: "", updatedAt: "",
};

const conversation: SecureConversationModel = {
  id: "conv-1", projectId: "p", type: "dm", mlsGroupId: "", spaceId: null,
  currentEpoch: "0", name: null, createdById: "u", lastMessageAt: null,
  createdAt: "", updatedAt: "",
};

function wrap(crypto: MockSecureChatCrypto, store: MemoryStore) {
  return ({ children }: { children: React.ReactNode }) => (
    <SecureChatProvider crypto={crypto} projectId="p" baseUrl="http://localhost:4000/v7" store={store} accessToken="t">
      {children}
    </SecureChatProvider>
  );
}

beforeEach(() => {
  vi.spyOn(SecureChatSocketClient.prototype, "on").mockReturnValue(() => {});
  vi.spyOn(SecureChatRestClient.prototype, "listConversations").mockResolvedValue({
    conversations: [], hasMore: false,
  });
});
afterEach(() => vi.restoreAllMocks());

describe("useSecureConversations", () => {
  it("createDirectConversation persists the created group", async () => {
    vi.spyOn(SecureChatRestClient.prototype, "listDevices").mockResolvedValue([deviceRow]);
    vi.spyOn(SecureChatRestClient.prototype, "claimKeyPackage").mockResolvedValue({
      deviceId: "peer-dev", keyPackageRef: "ref", keyPackage: "", ciphersuite: 1,
    });
    vi.spyOn(SecureChatRestClient.prototype, "createConversation").mockResolvedValue(conversation);

    const crypto = new MockSecureChatCrypto();
    await crypto.generateDeviceIdentity({ deviceId: "me" });
    const store = new MemoryStore();

    const { result } = renderHook(() => useSecureConversations(), { wrapper: wrap(crypto, store) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.createDirectConversation("peer");
    });

    expect(await store.get("group:conv-1")).not.toBeNull();
  });

  it("refreshes the list when a secure:welcome arrives (new conversation for the recipient)", async () => {
    // Capture the handlers the hook subscribes, keyed by event, so we can fire the welcome by hand.
    const handlers = new Map<string, (...args: any[]) => void>();
    vi.spyOn(SecureChatSocketClient.prototype, "on").mockImplementation((event: any, handler: any) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    });

    const listSpy = vi
      .spyOn(SecureChatRestClient.prototype, "listConversations")
      .mockResolvedValue({ conversations: [], hasMore: false }); // empty on initial mount

    const crypto = new MockSecureChatCrypto();
    const store = new MemoryStore();
    const { result } = renderHook(() => useSecureConversations(), { wrapper: wrap(crypto, store) });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.conversations).toHaveLength(0);
    expect(handlers.has("secure:welcome")).toBe(true);

    // A DM is now created for us: the server has the row, and pushes secure:welcome to our device room.
    listSpy.mockResolvedValue({ conversations: [conversation], hasMore: false });
    await act(async () => {
      handlers.get("secure:welcome")!();
    });

    await waitFor(() => expect(result.current.conversations).toHaveLength(1));
    expect(result.current.conversations[0].id).toBe("conv-1");
  });
});
