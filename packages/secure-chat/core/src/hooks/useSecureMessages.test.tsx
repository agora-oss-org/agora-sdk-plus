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
import { padPlaintext, unpadPlaintext, nextBucket } from "../util/padding.js";
import { buildPost, buildReaction } from "../content/builders.js";
import { encodeMimiContent, decodeMimiContent, contentHash } from "../content/mimi-content.js";
import { frameContent, unframe, ContentKind } from "../content/frame.js";
import type { SecureDeviceModel, SecureMessageModel } from "../contract/index.js";

// A real outbound message is MimiContent → content frame → padding frame. Use this anywhere a test
// previously did `padPlaintext(enc("hello"))` — the hook decrypts → unpad → unframe → decodeMimiContent.
function mimiFrame(text: string) {
  return padPlaintext(frameContent(ContentKind.Mimi, encodeMimiContent(buildPost(text))));
}

const row: SecureDeviceModel = {
  id: "row-1", projectId: "p", userId: "u", deviceId: "me", displayName: null,
  signaturePublicKey: "", credential: "", ciphersuite: 1,
  revokedAt: null, lastSeenAt: null, createdAt: "", updatedAt: "",
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
    expect(result.current.messages[0]?.content?.body).toBe("hi");
  });

  it("a live message UPGRADES a row that resolved to rejected — never drops a successful decrypt", async () => {
    // Regression for the demo's "first message stuck on ⏳ waiting for key update". A message can be
    // loaded/retried into a NON-ok state (here `rejected`) before the one live delivery that actually
    // decrypts it arrives. MLS application keys are single-use (forward secrecy), so that live decode
    // is the ONLY one that will ever succeed — the old live-receive dedup ("id already present → keep
    // the existing row") threw it away, stranding the message. The retry effect can't help: it only
    // re-tries `pending` rows, never `rejected`. So this is deterministic — only the live upgrade can
    // rescue it.
    const creator = new MockSecureChatCrypto();
    await creator.generateDeviceIdentity({ deviceId: "alice" });
    const { group: cgroup, welcomes } = await creator.createGroup({
      initialMembers: [{ deviceId: "row-1", keyPackage: new Uint8Array() }],
    });
    const { ciphertext, epoch } = await creator.encryptMessage(cgroup, mimiFrame("hello"));

    // The recipient crypto: decryptMessage throws while `armed` (simulating the row first resolving to
    // rejected), then succeeds once disarmed (the live delivery that actually decodes).
    class ArmableCrypto extends MockSecureChatCrypto {
      armed = true;
      override async decryptMessage(g: Parameters<MockSecureChatCrypto["decryptMessage"]>[0], ct: Uint8Array) {
        if (this.armed) throw new Error("decrypt failed (armed)");
        return super.decryptMessage(g, ct);
      }
    }
    const crypto = new ArmableCrypto();
    const recipientGroup = await crypto.processWelcome(welcomes.find((w) => w.targetDeviceId === "row-1")!.payload);
    const store = new MemoryStore();
    const repo = new SecureChatRepository(store);
    await repo.saveGroupState("conv-1", await crypto.exportGroupState(recipientGroup));
    // Dummy device-state bytes: this test only RECEIVES, so senderDeviceId is irrelevant and the
    // recipient crypto never minted an identity to export.
    await repo.saveDevice({ deviceId: "me", deviceState: new Uint8Array([1]), device: row });

    const msg: SecureMessageModel = {
      id: "m1", projectId: "p", conversationId: "conv-1", senderUserId: "alice", senderDeviceId: "alice-row",
      epoch: epoch.toString(), ciphertext: toBase64(ciphertext), contentType: "text/plain", createdAt: "",
    };
    vi.spyOn(SecureChatRestClient.prototype, "listMessages").mockResolvedValue({ messages: [msg], hasMore: false });
    const handlers: Record<string, (m: SecureMessageModel) => void> = {};
    vi.spyOn(SecureChatSocketClient.prototype, "on").mockImplementation(((event: string, h: (m: SecureMessageModel) => void) => {
      handlers[event] = h;
      return () => { delete handlers[event]; };
    }) as never);

    const { result } = renderHook(() => useSecureMessages("conv-1"), { wrapper: wrap(crypto, store) });
    // Settles to `rejected` (load — or its retry — decrypts while armed). The retry won't touch it again.
    await waitFor(() => expect(result.current.messages.find((m) => m.model.id === "m1")?.status).toBe("rejected"));

    // The single live delivery that actually decodes arrives.
    crypto.armed = false;
    await act(async () => {
      handlers["secure:message"]!(msg);
    });

    // It must UPGRADE the rejected row to ok — not be discarded as a duplicate.
    await waitFor(() => {
      const m = result.current.messages.find((x) => x.model.id === "m1");
      expect(m?.status).toBe("ok");
      expect(m?.content?.body).toBe("hello");
    });
    // Still exactly one row for that id (the upgrade replaced in place, no duplicate React key).
    expect(result.current.messages.filter((x) => x.model.id === "m1")).toHaveLength(1);
  });

  it("decrypts a message whose load finishes AFTER the group resolves (live group, not a stale closure)", async () => {
    // The exact demo bug: on a fresh page load the message fetch is in flight while resolveGroup is
    // still running, so the load's `decrypt` closure captured `group = null`. If the fetch then
    // finishes AFTER the group resolved, the old code left the row `pending` forever — the retry effect
    // had already fired (on the group change, while the list was empty) and nothing re-triggered it.
    // `decrypt` now reads the LIVE group via a ref, so a late-finishing load still decrypts.
    const creator = new MockSecureChatCrypto();
    await creator.generateDeviceIdentity({ deviceId: "alice" });
    const { group: cgroup, welcomes } = await creator.createGroup({
      initialMembers: [{ deviceId: "row-1", keyPackage: new Uint8Array() }],
    });
    const { ciphertext, epoch } = await creator.encryptMessage(cgroup, mimiFrame("hello"));

    const crypto = new MockSecureChatCrypto();
    const recipientGroup = await crypto.processWelcome(welcomes.find((w) => w.targetDeviceId === "row-1")!.payload);
    const store = new MemoryStore();
    const repo = new SecureChatRepository(store);
    await repo.saveGroupState("conv-1", await crypto.exportGroupState(recipientGroup));
    await repo.saveDevice({ deviceId: "me", deviceState: new Uint8Array([1]), device: row });

    const msg: SecureMessageModel = {
      id: "m1", projectId: "p", conversationId: "conv-1", senderUserId: "alice", senderDeviceId: "alice-row",
      epoch: epoch.toString(), ciphertext: toBase64(ciphertext), contentType: "text/plain", createdAt: "",
    };
    // Delay the message fetch so the (fast) resolveGroup wins the race — the load's decrypt then runs
    // with the group ALREADY set, the scenario the stale-closure bug mishandled.
    vi.spyOn(SecureChatRestClient.prototype, "listMessages").mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 25));
      return { messages: [msg], hasMore: false };
    });

    const { result } = renderHook(() => useSecureMessages("conv-1"), { wrapper: wrap(crypto, store) });

    await waitFor(() => {
      const m = result.current.messages.find((x) => x.model.id === "m1");
      expect(m?.status).toBe("ok");
      expect(m?.content?.body).toBe("hello");
    });
  });

  it("survives a reload end-to-end: a fresh crypto re-hydrates identity + group from the store", async () => {
    // ── Session 1 (before reload): create identity + group, encrypt a message, persist the bytes.
    const before = new MockSecureChatCrypto();
    await before.generateDeviceIdentity({ deviceId: "me" });
    const { group } = await before.createGroup({ initialMembers: [] });
    // A real prior message is a MIMI content frame, padded by the send path before encryption.
    const { ciphertext: priorCt } = await before.encryptMessage(group, mimiFrame("before reload"));

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
      expect(result.current.messages.messages.find((m) => m.model.id === "m0")?.content?.body).toBe(
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
    // The send path framed + padded the plaintext; strip the padding, unframe, decode the MIMI content
    // and read its text body to recover "after reload".
    const { kind, payload } = unframe(unpadPlaintext(decoded.plaintext));
    expect(kind).toBe(ContentKind.Mimi);
    const part = decodeMimiContent(payload).nestedPart;
    expect(part.cardinality === 1 ? new TextDecoder().decode(part.content) : null).toBe("after reload");
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
    expect(result.current.messages[0]?.content).toBeNull();
  });

  it("buffers a future-epoch message as 'pending' and decrypts it once the group advances", async () => {
    const { crypto, store, group } = await seed();
    // Spy keys off the group epoch it's called with: succeed only once we've advanced to epoch ≥ 1.
    vi.spyOn(crypto, "decryptMessage").mockImplementation(async (g: { epoch: bigint }) => {
      // decryptMessage returns the padded MIMI content frame; the hook decodes it back to "hello".
      if (g.epoch >= 1n) return { plaintext: mimiFrame("hello"), senderDeviceId: "peer", epoch: g.epoch };
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
    expect(result.current.msgs.messages[0]?.content?.body).toBe("hello");
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

describe("useSecureMessages — own-message echo de-dup", () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  async function seed() {
    const crypto = new MockSecureChatCrypto();
    await crypto.generateDeviceIdentity({ deviceId: "me" });
    const { group } = await crypto.createGroup({ initialMembers: [] });
    const store = new MemoryStore();
    const repo = new SecureChatRepository(store);
    await repo.saveGroupState("conv-1", await crypto.exportGroupState(group));
    await repo.saveDevice({ deviceId: "me", deviceState: await crypto.exportDeviceState(), device: row });
    return { crypto, store };
  }

  // The server stores a sent message once and echoes that SAME row back over `secure:message` — and a
  // sender can't decrypt their own MLS application message, so the echo decrypts as `rejected`. When the
  // echo wins the race against the HTTP send response (common on localhost), the rejected echo is added
  // first; the optimistic add must NOT then prepend a second copy of the same id (React duplicate-key).
  it("does not duplicate a sent message when its own live echo arrives first", async () => {
    const { crypto, store } = await seed();
    vi.spyOn(crypto, "decryptMessage").mockRejectedValue(
      new SecureChatDecryptError("unauthenticated", "cannot decrypt own message")
    );

    // Capture the live secure:message handler so we can deliver the server's echo on demand.
    let onMessage: ((m: SecureMessageModel) => void) | undefined;
    vi.spyOn(SecureChatSocketClient.prototype, "on").mockImplementation((event, handler) => {
      if (event === "secure:message") onMessage = handler as (m: SecureMessageModel) => void;
      return () => {};
    });

    const stored: SecureMessageModel = {
      id: "m1", projectId: "p", conversationId: "conv-1", senderUserId: "u", senderDeviceId: "row-1",
      epoch: "0", ciphertext: toBase64(enc("ct")), contentType: "text/plain", createdAt: "",
    };
    vi.spyOn(SecureChatRestClient.prototype, "sendMessage").mockResolvedValue(stored);

    const { result } = renderHook(() => useSecureMessages("conv-1"), { wrapper: wrap(crypto, store) });
    await waitFor(() => expect(result.current.loading).toBe(false));

    // 1) The live echo of our own message lands FIRST and decrypts to `rejected`.
    await act(async () => {
      onMessage!(stored);
    });
    await waitFor(() => expect(result.current.messages.some((m) => m.model.id === "m1")).toBe(true));

    // 2) Then our optimistic send completes for the SAME id.
    await waitFor(async () => {
      await result.current.sendMessage("hi");
    });

    // Exactly ONE row for that id — and it must be our authoritative "ok" copy, not the rejected echo.
    const matches = result.current.messages.filter((m) => m.model.id === "m1");
    expect(matches).toHaveLength(1);
    expect(matches[0].status).toBe("ok");
    expect(matches[0].content?.body).toBe("hi");
  });
});

describe("useSecureMessages — durable decrypt-once store + persist-after-mutation", () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  async function seed() {
    const crypto = new MockSecureChatCrypto();
    await crypto.generateDeviceIdentity({ deviceId: "me" });
    const { group } = await crypto.createGroup({ initialMembers: [] });
    const store = new MemoryStore();
    const repo = new SecureChatRepository(store);
    await repo.saveGroupState("conv-1", await crypto.exportGroupState(group));
    await repo.saveDevice({ deviceId: "me", deviceState: await crypto.exportDeviceState(), device: row });
    return { crypto, store, repo, group };
  }

  // Decode the content frame a prior session would have stored (so a store hit re-decodes to text).
  function storedFrame(text: string): Uint8Array {
    return frameContent(ContentKind.Mimi, encodeMimiContent(buildPost(text)));
  }
  function bodyOfFrame(frame: Uint8Array): string | null {
    const { payload } = unframe(frame);
    const part = decodeMimiContent(payload).nestedPart;
    return part.cardinality === 1 ? new TextDecoder().decode(part.content) : null;
  }

  it("persists the advanced send ratchet AND our own content frame after sendMessage", async () => {
    const { crypto, store, repo } = await seed();
    // Spy the provider's saveGroupState (persistGroupState writes through it) and the content store.
    const saveGroup = vi.spyOn(SecureChatRepository.prototype, "saveGroupState");
    const saveContent = vi.spyOn(SecureChatRepository.prototype, "saveMessageContent");
    vi.spyOn(SecureChatRestClient.prototype, "sendMessage").mockImplementation(
      async (_c, body): Promise<SecureMessageModel> => ({
        id: "m-sent", projectId: "p", conversationId: "conv-1", senderUserId: "u", senderDeviceId: "row-1",
        epoch: "0", ciphertext: body.ciphertext, contentType: "text/plain", createdAt: "",
      })
    );

    const { result } = renderHook(() => useSecureMessages("conv-1"), { wrapper: wrap(crypto, store) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    saveGroup.mockClear();
    await waitFor(async () => {
      await result.current.sendMessage("please work");
    });

    // The send ratchet advanced and was persisted (no rewind → no resend-replay on reload). Match on
    // the conversation id + a non-empty byte payload — NOT expect.any(Uint8Array), which compares
    // `instanceof` across realms (the crypto package's Node Uint8Array vs. this jsdom file's global).
    expect(saveGroup.mock.calls.some((c) => c[0] === "conv-1" && (c[1] as ArrayLike<number>).length > 0)).toBe(true);
    // Our own content frame was persisted under the sent message's id so reload re-decodes + renders it.
    const contentCall = saveContent.mock.calls.find((c) => c[0] === "conv-1" && c[1] === "m-sent");
    expect(contentCall).toBeDefined();
    expect(bodyOfFrame(contentCall![2] as Uint8Array)).toBe("please work");
    expect(bodyOfFrame((await repo.loadMessageContent("conv-1", "m-sent"))!)).toBe("please work");
  });

  it("serves an already-stored message from the content store WITHOUT touching the ratchet", async () => {
    const { crypto, store, repo } = await seed();
    // Pre-seed the durable store with the content frame a prior session would have decrypted + stored.
    await repo.saveMessageContent("conv-1", "m-old", storedFrame("decoded last session"));
    const decryptSpy = vi.spyOn(crypto, "decryptMessage");
    vi.spyOn(SecureChatRestClient.prototype, "listMessages").mockResolvedValue({
      messages: [{
        id: "m-old", projectId: "p", conversationId: "conv-1", senderUserId: "u", senderDeviceId: "peer",
        epoch: "0", ciphertext: toBase64(enc("opaque")), contentType: "text/plain", createdAt: "",
      }],
      hasMore: false,
    });

    const { result } = renderHook(() => useSecureMessages("conv-1"), { wrapper: wrap(crypto, store) });
    await waitFor(() => expect(result.current.messages[0]?.content?.body).toBe("decoded last session"));
    // Forward secrecy: re-decrypting a consumed key would throw — so the store hit MUST avoid it.
    expect(decryptSpy).not.toHaveBeenCalled();
  });

  it("write-throughs the content frame and persists the receive ratchet on a fresh decrypt", async () => {
    const { crypto, store, repo } = await seed();
    vi.spyOn(crypto, "decryptMessage").mockResolvedValue({
      plaintext: mimiFrame("fresh decode"), senderDeviceId: "peer", epoch: 0n,
    });
    const saveGroup = vi.spyOn(SecureChatRepository.prototype, "saveGroupState");
    vi.spyOn(SecureChatRestClient.prototype, "listMessages").mockResolvedValue({
      messages: [{
        id: "m-new", projectId: "p", conversationId: "conv-1", senderUserId: "u", senderDeviceId: "peer",
        epoch: "0", ciphertext: toBase64(enc("opaque")), contentType: "text/plain", createdAt: "",
      }],
      hasMore: false,
    });

    const { result } = renderHook(() => useSecureMessages("conv-1"), { wrapper: wrap(crypto, store) });
    await waitFor(() => expect(result.current.messages[0]?.content?.body).toBe("fresh decode"));
    // Content frame written through for next-reload history (re-decodes to the same body).
    expect(bodyOfFrame((await repo.loadMessageContent("conv-1", "m-new"))!)).toBe("fresh decode");
    // Advanced receive ratchet persisted (conversation id + non-empty payload; see note above re realms).
    expect(saveGroup.mock.calls.some((c) => c[0] === "conv-1" && (c[1] as ArrayLike<number>).length > 0)).toBe(true);
  });
});

describe("useSecureMessages — size-bucket padding (task 6a)", () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  async function seed() {
    const crypto = new MockSecureChatCrypto();
    await crypto.generateDeviceIdentity({ deviceId: "me" });
    const { group } = await crypto.createGroup({ initialMembers: [] });
    const store = new MemoryStore();
    const repo = new SecureChatRepository(store);
    await repo.saveGroupState("conv-1", await crypto.exportGroupState(group));
    await repo.saveDevice({ deviceId: "me", deviceState: await crypto.exportDeviceState(), device: row });
    return { crypto, store, group };
  }

  it("pads the outbound MIMI content frame to a size bucket and never wires the plaintext body", async () => {
    const { crypto, store } = await seed();
    // A distinctive body so the server-blindness subsequence scan can't false-negative on a 1-byte coincidence.
    const BODY = "nuclear-codes-0000";
    // Capture (a) what the crypto layer is asked to encrypt — the padded CONTENT frame (MimiContent
    // CBOR behind a [kind] byte) — and (b) the wire ciphertext the hook POSTs to the blind server.
    const encSpy = vi.spyOn(crypto, "encryptMessage");
    let wireCiphertext = "";
    vi.spyOn(SecureChatRestClient.prototype, "sendMessage").mockImplementation(
      async (_c, body): Promise<SecureMessageModel> => {
        wireCiphertext = body.ciphertext;
        return {
          id: "m1", projectId: "p", conversationId: "conv-1", senderUserId: "u", senderDeviceId: "row-1",
          epoch: "0", ciphertext: body.ciphertext, contentType: "text/plain", createdAt: "",
        };
      }
    );

    const { result } = renderHook(() => useSecureMessages("conv-1"), { wrapper: wrap(crypto, store) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(async () => {
      await result.current.sendMessage(BODY);
    });

    const framed = encSpy.mock.calls[0][1] as Uint8Array;
    // The padding frame's 5-byte header precedes the content frame, whose first byte is the routing
    // kind — assert it is MimiContent (a MimiContent post is > 32 bytes, so the bucket is no longer 32).
    expect(framed[5]).toBe(ContentKind.Mimi);
    const unpaddedLen = 5 /* padding header */ + 1 /* content-frame kind */ +
      encodeMimiContent(buildPost(BODY)).length;
    // Salts are random, but they don't change the encoded byte length; assert the size bucket matches.
    expect(framed.length).toBe(nextBucket(unpaddedLen));
    // Server-blindness (E2EE §1): the WIRE ciphertext must NOT contain the plaintext body bytes.
    expect(containsSubsequence(fromBase64(wireCiphertext), new TextEncoder().encode(BODY))).toBe(false);
    expect(result.current.messages[0]?.content?.body).toBe(BODY); // optimistic body preserved
  });

  it("fails closed when the decrypted frame is malformed (authenticated but bad padding)", async () => {
    const { crypto, store } = await seed();
    // Authentication succeeds but the bytes are not a valid padding frame → reject as malformed.
    vi.spyOn(crypto, "decryptMessage").mockResolvedValue({
      plaintext: enc("not a frame"), senderDeviceId: "peer", epoch: 0n,
    });
    vi.spyOn(SecureChatRestClient.prototype, "listMessages").mockResolvedValue({
      messages: [{
        id: "m1", projectId: "p", conversationId: "conv-1", senderUserId: "u", senderDeviceId: "peer",
        epoch: "0", ciphertext: toBase64(enc("x")), contentType: "text/plain", createdAt: "",
      }],
      hasMore: false,
    });

    const { result } = renderHook(() => useSecureMessages("conv-1"), { wrapper: wrap(crypto, store) });
    await waitFor(() => expect(result.current.messages[0]?.status).toBe("rejected"));
    expect(result.current.messages[0]?.rejectedReason).toBe("malformed");
    expect(result.current.messages[0]?.content).toBeNull();
  });

  it("fails closed when a valid padding frame wraps a non-CBOR MIMI payload", async () => {
    const { crypto, store } = await seed();
    // Authentication + padding both succeed, but the inner content-frame payload is not valid CBOR →
    // decodeMimiContent throws → reject as malformed (never render partial bytes).
    vi.spyOn(crypto, "decryptMessage").mockResolvedValue({
      plaintext: padPlaintext(frameContent(ContentKind.Mimi, enc("not-cbor"))),
      senderDeviceId: "peer", epoch: 0n,
    });
    vi.spyOn(SecureChatRestClient.prototype, "listMessages").mockResolvedValue({
      messages: [{
        id: "m1", projectId: "p", conversationId: "conv-1", senderUserId: "u", senderDeviceId: "peer",
        epoch: "0", ciphertext: toBase64(enc("x")), contentType: "text/plain", createdAt: "",
      }],
      hasMore: false,
    });

    const { result } = renderHook(() => useSecureMessages("conv-1"), { wrapper: wrap(crypto, store) });
    await waitFor(() => expect(result.current.messages[0]?.status).toBe("rejected"));
    expect(result.current.messages[0]?.rejectedReason).toBe("malformed");
    expect(result.current.messages[0]?.content).toBeNull();
  });
});

/** True if `needle` appears as a contiguous byte subsequence of `haystack` (server-blindness scan). */
function containsSubsequence(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) return true;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

describe("useSecureMessages — MIMI content actions", () => {
  // A single-client optimistic harness: the hook holds a real group + device so every action sends.
  // sendMessage returns a fresh server id per call (one row per content message). Because we can't
  // decrypt our own MLS message, each action's content rides the optimistic path — its contentHash is
  // available synchronously on the new row, so the next action can reference it.
  async function seedSender() {
    const crypto = new MockSecureChatCrypto();
    await crypto.generateDeviceIdentity({ deviceId: "me" });
    const { group } = await crypto.createGroup({ initialMembers: [] });
    const store = new MemoryStore();
    const repo = new SecureChatRepository(store);
    await repo.saveGroupState("conv-1", await crypto.exportGroupState(group));
    await repo.saveDevice({ deviceId: "me", deviceState: await crypto.exportDeviceState(), device: row });
    let n = 0;
    vi.spyOn(SecureChatRestClient.prototype, "sendMessage").mockImplementation(
      async (_c, body): Promise<SecureMessageModel> => ({
        id: `m${++n}`, projectId: "p", conversationId: "conv-1", senderUserId: "u", senderDeviceId: "row-1",
        epoch: "0", ciphertext: body.ciphertext, contentType: "text/plain",
        // Strictly-increasing createdAt so the newest-first ordering is deterministic across rows.
        createdAt: `2026-06-20T00:00:0${n}.000Z`,
      })
    );
    return { crypto, store };
  }

  it("reply sets content.replyTo to the target's contentHash", async () => {
    const { crypto, store } = await seedSender();
    const { result } = renderHook(() => useSecureMessages("conv-1"), { wrapper: wrap(crypto, store) });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await waitFor(async () => {
      await result.current.sendMessage("the post");
    });
    const postHash = result.current.messages.find((m) => m.content?.body === "the post")!.contentHash!;
    await act(async () => {
      await result.current.reply(postHash, "re");
    });

    const replyRow = result.current.messages.find((m) => m.content?.body === "re");
    expect(replyRow).toBeDefined();
    expect(replyRow!.content?.replyTo && Array.from(replyRow!.content.replyTo)).toEqual(Array.from(postHash));
    // The post and the reply are BOTH standalone rows (a reply renders).
    expect(result.current.messages.filter((m) => m.status === "ok")).toHaveLength(2);
  });

  it("react aggregates onto the target and unreact removes it; reactions are not their own rows", async () => {
    const { crypto, store } = await seedSender();
    const { result } = renderHook(() => useSecureMessages("conv-1"), { wrapper: wrap(crypto, store) });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await waitFor(async () => {
      await result.current.sendMessage("react to me");
    });
    const postHash = result.current.messages[0]!.contentHash!;
    await act(async () => {
      await result.current.react(postHash, "👍");
    });

    // The reaction folds ONTO the post; it is not a standalone row.
    expect(result.current.messages.filter((m) => m.status === "ok")).toHaveLength(1);
    expect(result.current.messages.find((m) => m.model.id === "m1")!.content?.reactions["👍"]).toBe(1);

    // We don't surface mutation rows, so recover the reaction's OWN content-hash from the content frame
    // the hook wrote through for m2 (the reaction send), then withdraw it.
    const repo = new SecureChatRepository(store);
    const reactionHash = contentHashOfFrame((await repo.loadMessageContent("conv-1", "m2"))!);
    await act(async () => {
      await result.current.unreact(reactionHash);
    });
    expect(result.current.messages.find((m) => m.model.id === "m1")!.content?.reactions["👍"]).toBeUndefined();
    // Still exactly one rendered row (post); the reaction + un-react never appeared as rows.
    expect(result.current.messages.filter((m) => m.status === "ok")).toHaveLength(1);
  });

  it("edit rewrites the target body and stamps editedAt; the edit is not a separate row", async () => {
    const { crypto, store } = await seedSender();
    const { result } = renderHook(() => useSecureMessages("conv-1"), { wrapper: wrap(crypto, store) });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await waitFor(async () => {
      await result.current.sendMessage("typo");
    });
    const postHash = result.current.messages[0]!.contentHash!;
    await act(async () => {
      await result.current.editMessage(postHash, "fixed");
    });

    const post = result.current.messages.find((m) => m.model.id === "m1")!;
    expect(post.content?.body).toBe("fixed");
    expect(post.content?.editedAt).not.toBeNull();
    // The edit folded in — exactly one rendered row remains.
    expect(result.current.messages.filter((m) => m.status === "ok")).toHaveLength(1);
  });

  it("delete tombstones the target (content.deleted true, body null)", async () => {
    const { crypto, store } = await seedSender();
    const { result } = renderHook(() => useSecureMessages("conv-1"), { wrapper: wrap(crypto, store) });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await waitFor(async () => {
      await result.current.sendMessage("oops");
    });
    const postHash = result.current.messages[0]!.contentHash!;
    await act(async () => {
      await result.current.deleteMessage(postHash);
    });

    const post = result.current.messages.find((m) => m.model.id === "m1")!;
    expect(post.content?.deleted).toBe(true);
    expect(post.content?.body).toBeNull();
    expect(result.current.messages.filter((m) => m.status === "ok")).toHaveLength(1);
  });

  it("a reaction received BEFORE its target folds in once the target arrives (out-of-order)", async () => {
    // A peer (creator) builds a post and a reaction to it, then we deliver the reaction FIRST over the
    // live handler. With the target unknown it buffers (no visible row); once the post lands the post
    // row shows the reaction. Exercises the fold's out-of-order buffering through the real hook.
    const creator = new MockSecureChatCrypto();
    await creator.generateDeviceIdentity({ deviceId: "alice" });
    const { group: cgroup, welcomes } = await creator.createGroup({
      initialMembers: [{ deviceId: "row-1", keyPackage: new Uint8Array() }],
    });

    // The peer builds the post + a reaction referencing the post's contentHash, and encrypts both.
    const postMimi = buildPost("hi from alice");
    const postHash = contentHash(postMimi);
    const reactionMimi = buildReaction(postHash, "🎉");
    const postFrame = padPlaintext(frameContent(ContentKind.Mimi, encodeMimiContent(postMimi)));
    const reactFrame = padPlaintext(frameContent(ContentKind.Mimi, encodeMimiContent(reactionMimi)));
    const { ciphertext: postCt, epoch } = await creator.encryptMessage(cgroup, postFrame);
    const { ciphertext: reactCt } = await creator.encryptMessage(cgroup, reactFrame);

    const crypto = new MockSecureChatCrypto();
    const recipientGroup = await crypto.processWelcome(welcomes.find((w) => w.targetDeviceId === "row-1")!.payload);
    const store = new MemoryStore();
    const repo = new SecureChatRepository(store);
    await repo.saveGroupState("conv-1", await crypto.exportGroupState(recipientGroup));
    await repo.saveDevice({ deviceId: "me", deviceState: new Uint8Array([1]), device: row });

    const handlers: Record<string, (m: SecureMessageModel) => void> = {};
    vi.spyOn(SecureChatSocketClient.prototype, "on").mockImplementation(((event: string, h: (m: SecureMessageModel) => void) => {
      handlers[event] = h;
      return () => { delete handlers[event]; };
    }) as never);

    const reactRow: SecureMessageModel = {
      id: "mr", projectId: "p", conversationId: "conv-1", senderUserId: "alice", senderDeviceId: "alice-row",
      epoch: epoch.toString(), ciphertext: toBase64(reactCt), contentType: "text/plain", createdAt: "2026-06-20T00:00:02.000Z",
    };
    const postRow: SecureMessageModel = {
      id: "mp", projectId: "p", conversationId: "conv-1", senderUserId: "alice", senderDeviceId: "alice-row",
      epoch: epoch.toString(), ciphertext: toBase64(postCt), contentType: "text/plain", createdAt: "2026-06-20T00:00:01.000Z",
    };

    const { result } = renderHook(() => useSecureMessages("conv-1"), { wrapper: wrap(crypto, store) });
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Deliver the reaction FIRST — target unknown → buffered, no visible row.
    await act(async () => {
      handlers["secure:message"]!(reactRow);
    });
    expect(result.current.messages.filter((m) => m.status === "ok")).toHaveLength(0);

    // Then the post — it renders AND the buffered reaction folds onto it.
    await act(async () => {
      handlers["secure:message"]!(postRow);
    });
    await waitFor(() => {
      const post = result.current.messages.find((m) => m.model.id === "mp");
      expect(post?.content?.body).toBe("hi from alice");
      expect(post?.content?.reactions["🎉"]).toBe(1);
    });
    // The reaction never became a standalone row.
    expect(result.current.messages.filter((m) => m.status === "ok")).toHaveLength(1);
  });
});

/** Recompute the 32-byte content-hash of a stored content frame (post-unframe, MimiContent payload). */
function contentHashOfFrame(frame: Uint8Array): Uint8Array {
  const { payload } = unframe(frame);
  return contentHash(decodeMimiContent(payload));
}
