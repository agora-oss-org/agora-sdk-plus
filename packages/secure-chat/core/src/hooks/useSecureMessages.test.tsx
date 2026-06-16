// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { MockSecureChatCrypto } from "@agora-sdk/secure-chat-crypto/testing";
import { SecureChatDecryptError } from "@agora-sdk/secure-chat-crypto";
import { SecureChatProvider, useSecureChat } from "../context/secure-chat-context.js";
import { useSecureMessages } from "./useSecureMessages.js";
import { useSecureDevice } from "./useSecureDevice.js";
import { MemoryStore } from "../persistence/memory-store.js";
import { SecureChatRepository } from "../persistence/repository.js";
import { SecureChatRestClient } from "../transport/rest.js";
import { SecureChatSocketClient } from "../transport/socket.js";
import { toBase64, fromBase64 } from "../util/base64.js";
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

  it("survives a reload end-to-end: a fresh crypto re-hydrates identity + group from the store", async () => {
    // ── Session 1 (before reload): create identity + group, encrypt a message, persist the bytes.
    const before = new MockSecureChatCrypto();
    await before.generateDeviceIdentity({ deviceId: "me" });
    const { group } = await before.createGroup({ initialMembers: [] });
    const { ciphertext: priorCt } = await before.encryptMessage(
      group,
      new TextEncoder().encode("before reload")
    );

    const store = new MemoryStore();
    const repo = new SecureChatRepository(store);
    await repo.saveDevice({ deviceId: "me", deviceState: await before.exportDeviceState(), device: row });
    await repo.saveGroupState("conv-1", await before.exportGroupState(group));

    // The server returns the prior (still-encrypted) message on load.
    const priorMsg: SecureMessageModel = {
      id: "m0", projectId: "p", conversationId: "conv-1", senderUserId: "u", senderDeviceId: "row-1",
      epoch: "0", ciphertext: toBase64(priorCt), contentType: "text/plain", createdAt: "",
    };
    vi.spyOn(SecureChatRestClient.prototype, "listMessages").mockResolvedValue({
      messages: [priorMsg], hasMore: false,
    });

    let sentCiphertext = "";
    let sentSenderDeviceId = "";
    vi.spyOn(SecureChatRestClient.prototype, "sendMessage").mockImplementation(
      async (_conv: string, body): Promise<SecureMessageModel> => {
        sentCiphertext = body.ciphertext;
        sentSenderDeviceId = body.senderDeviceId;
        return {
          id: "m1", projectId: "p", conversationId: "conv-1", senderUserId: "u",
          senderDeviceId: "row-1", epoch: "0", ciphertext: body.ciphertext,
          contentType: "text/plain", createdAt: "",
        };
      }
    );

    // ── Session 2 (after reload): a FRESH crypto holding nothing in memory; only the store has state.
    const after = new MockSecureChatCrypto();
    const { result } = renderHook(
      () => ({ device: useSecureDevice(), messages: useSecureMessages("conv-1") }),
      { wrapper: wrap(after, store) }
    );

    // useSecureDevice re-hydrates the identity from persisted device-state (importDeviceState).
    await waitFor(() => expect(result.current.device.device?.id).toBe("row-1"));

    // useSecureMessages resolves the group from persisted group-state (importGroupState) and decrypts
    // the prior message — proving the group secret round-tripped through the store on a cold crypto.
    await waitFor(() =>
      expect(result.current.messages.messages.find((m) => m.model.id === "m0")?.plaintext).toBe(
        "before reload"
      )
    );

    // A send after reload is tagged with the re-hydrated identity — proving importDeviceState actually
    // drove the crypto, not just the persisted device row. Decrypt the wire bytes to read the tag.
    await waitFor(async () => {
      await result.current.messages.sendMessage("after reload");
    });
    expect(sentSenderDeviceId).toBe("row-1");
    const decoded = await before.decryptMessage(group, fromBase64(sentCiphertext));
    expect(decoded.senderDeviceId).toBe("me");
    expect(new TextDecoder().decode(decoded.plaintext)).toBe("after reload");
  });
});

describe("useSecureMessages — generation-counter rejection (fail closed)", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const msgRow = (id: string, epoch: string): SecureMessageModel => ({
    id, projectId: "p", conversationId: "conv-1", senderUserId: "u", senderDeviceId: "peer",
    epoch, ciphertext: toBase64(enc("cipher")), contentType: "text/plain", createdAt: "",
  });

  // Persist a group (mock epoch 0) + device so the hook resolves a handle; return the live crypto.
  async function seed() {
    const crypto = new MockSecureChatCrypto();
    await crypto.generateDeviceIdentity({ deviceId: "me" });
    const { group } = await crypto.createGroup({ initialMembers: [] }); // epoch 0n
    const store = new MemoryStore();
    const repo = new SecureChatRepository(store);
    await repo.saveGroupState("conv-1", await crypto.exportGroupState(group));
    await repo.saveDevice({ deviceId: "me", deviceState: await crypto.exportDeviceState(), device: row });
    return { crypto, store, group };
  }

  it("marks a core-rejected message as 'rejected' with its reason, never as plaintext", async () => {
    const { crypto, store } = await seed();
    vi.spyOn(crypto, "decryptMessage").mockRejectedValue(new SecureChatDecryptError("replay", "x"));
    vi.spyOn(SecureChatRestClient.prototype, "listMessages").mockResolvedValue({
      messages: [msgRow("m1", "0")], hasMore: false, // epoch 0 == our epoch → not "ahead" → terminal
    });

    const { result } = renderHook(() => useSecureMessages("conv-1"), { wrapper: wrap(crypto, store) });
    await waitFor(() => expect(result.current.messages[0]?.status).toBe("rejected"));
    expect(result.current.messages[0]?.rejectedReason).toBe("replay");
    expect(result.current.messages[0]?.plaintext).toBeNull();
  });

  it("buffers a future-epoch message as 'pending' and decrypts it once the group advances", async () => {
    const { crypto, store, group } = await seed();
    // Spy keys off the group epoch it's called with: succeed only once we've advanced to epoch ≥ 1.
    vi.spyOn(crypto, "decryptMessage").mockImplementation(async (g: { epoch: bigint }) => {
      if (g.epoch >= 1n) return { plaintext: enc("hello"), senderDeviceId: "peer", epoch: g.epoch };
      throw new SecureChatDecryptError("malformed", "not at this epoch yet");
    });
    vi.spyOn(SecureChatRestClient.prototype, "listMessages").mockResolvedValue({
      messages: [msgRow("m1", "1")], hasMore: false, // epoch 1 > our epoch 0 → buffer, don't reject
    });

    const { result } = renderHook(
      () => ({ chat: useSecureChat(), msgs: useSecureMessages("conv-1") }),
      { wrapper: wrap(crypto, store) }
    );
    await waitFor(() => expect(result.current.msgs.messages[0]?.status).toBe("pending"));

    // A processed Commit advances the group handle to epoch 1 → the buffered row re-decrypts.
    await act(async () => {
      await result.current.chat.rememberGroup("conv-1", { mlsGroupId: group.mlsGroupId, epoch: 1n });
    });
    await waitFor(() => expect(result.current.msgs.messages[0]?.status).toBe("ok"));
    expect(result.current.msgs.messages[0]?.plaintext).toBe("hello");
  });

  it("never retries a rejected message when the group advances", async () => {
    const { crypto, store, group } = await seed();
    const spy = vi
      .spyOn(crypto, "decryptMessage")
      .mockRejectedValue(new SecureChatDecryptError("replay", "x"));
    vi.spyOn(SecureChatRestClient.prototype, "listMessages").mockResolvedValue({
      messages: [msgRow("m1", "0")], hasMore: false,
    });

    const { result } = renderHook(
      () => ({ chat: useSecureChat(), msgs: useSecureMessages("conv-1") }),
      { wrapper: wrap(crypto, store) }
    );
    await waitFor(() => expect(result.current.msgs.messages[0]?.status).toBe("rejected"));
    const callsWhenRejected = spy.mock.calls.length;

    // Advance the group — the retry effect runs, but a rejected row must be excluded.
    await act(async () => {
      await result.current.chat.rememberGroup("conv-1", { mlsGroupId: group.mlsGroupId, epoch: 1n });
    });
    await waitFor(() => expect(result.current.chat.getGroupVersion("conv-1")).toBeGreaterThan(0));
    expect(spy.mock.calls.length).toBe(callsWhenRejected); // not re-decrypted
    expect(result.current.msgs.messages[0]?.status).toBe("rejected");
  });
});
