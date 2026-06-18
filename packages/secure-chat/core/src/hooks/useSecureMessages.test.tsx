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
import { padPlaintext, unpadPlaintext } from "../util/padding.js";
import type { SecureDeviceModel, SecureMessageModel } from "../contract/index.js";

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
    expect(result.current.messages[0]?.plaintext).toBe("hi");
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
    const { ciphertext, epoch } = await creator.encryptMessage(
      cgroup,
      padPlaintext(new TextEncoder().encode("hello"))
    );

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
      expect(m?.plaintext).toBe("hello");
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
    const { ciphertext, epoch } = await creator.encryptMessage(
      cgroup,
      padPlaintext(new TextEncoder().encode("hello"))
    );

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
      expect(m?.plaintext).toBe("hello");
    });
  });

  it("survives a reload end-to-end: a fresh crypto re-hydrates identity + group from the store", async () => {
    // ── Session 1 (before reload): create identity + group, encrypt a message, persist the bytes.
    const before = new MockSecureChatCrypto();
    await before.generateDeviceIdentity({ deviceId: "me" });
    const { group } = await before.createGroup({ initialMembers: [] });
    // A real prior message is padded by the send path before encryption, so encrypt the padded frame.
    const { ciphertext: priorCt } = await before.encryptMessage(
      group,
      padPlaintext(new TextEncoder().encode("before reload"))
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
    // The send path padded the plaintext; strip the frame to recover the text.
    expect(new TextDecoder().decode(unpadPlaintext(decoded.plaintext))).toBe("after reload");
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
      // decryptMessage returns the padded frame; the hook strips it back to "hello".
      if (g.epoch >= 1n) return { plaintext: padPlaintext(enc("hello")), senderDeviceId: "peer", epoch: g.epoch };
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
    expect(matches[0].plaintext).toBe("hi");
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

  it("persists the advanced send ratchet AND our own plaintext after sendMessage", async () => {
    const { crypto, store, repo } = await seed();
    // Spy the provider's saveGroupState (persistGroupState writes through it) and the plaintext store.
    const saveGroup = vi.spyOn(SecureChatRepository.prototype, "saveGroupState");
    const savePlain = vi.spyOn(SecureChatRepository.prototype, "saveMessagePlaintext");
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
    // Our own plaintext was persisted under the sent message's id so reload renders it.
    expect(savePlain).toHaveBeenCalledWith("conv-1", "m-sent", "please work");
    expect(await repo.loadMessagePlaintext("conv-1", "m-sent")).toBe("please work");
  });

  it("serves an already-stored message from the plaintext store WITHOUT touching the ratchet", async () => {
    const { crypto, store, repo } = await seed();
    // Pre-seed the durable store as if this message was decoded in a prior session.
    await repo.saveMessagePlaintext("conv-1", "m-old", "decoded last session");
    const decryptSpy = vi.spyOn(crypto, "decryptMessage");
    vi.spyOn(SecureChatRestClient.prototype, "listMessages").mockResolvedValue({
      messages: [{
        id: "m-old", projectId: "p", conversationId: "conv-1", senderUserId: "u", senderDeviceId: "peer",
        epoch: "0", ciphertext: toBase64(enc("opaque")), contentType: "text/plain", createdAt: "",
      }],
      hasMore: false,
    });

    const { result } = renderHook(() => useSecureMessages("conv-1"), { wrapper: wrap(crypto, store) });
    await waitFor(() => expect(result.current.messages[0]?.plaintext).toBe("decoded last session"));
    // Forward secrecy: re-decrypting a consumed key would throw — so the store hit MUST avoid it.
    expect(decryptSpy).not.toHaveBeenCalled();
  });

  it("write-throughs plaintext and persists the receive ratchet on a fresh decrypt", async () => {
    const { crypto, store, repo } = await seed();
    vi.spyOn(crypto, "decryptMessage").mockResolvedValue({
      plaintext: padPlaintext(enc("fresh decode")), senderDeviceId: "peer", epoch: 0n,
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
    await waitFor(() => expect(result.current.messages[0]?.plaintext).toBe("fresh decode"));
    // Plaintext written through for next-reload history.
    expect(await repo.loadMessagePlaintext("conv-1", "m-new")).toBe("fresh decode");
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

  it("pads outbound plaintext to a size bucket before encryption", async () => {
    const { crypto, store } = await seed();
    // Capture what the crypto layer is asked to encrypt — it must be the padded frame, not raw text.
    const encSpy = vi.spyOn(crypto, "encryptMessage");
    vi.spyOn(SecureChatRestClient.prototype, "sendMessage").mockImplementation(
      async (_c, body): Promise<SecureMessageModel> => ({
        id: "m1", projectId: "p", conversationId: "conv-1", senderUserId: "u", senderDeviceId: "row-1",
        epoch: "0", ciphertext: body.ciphertext, contentType: "text/plain", createdAt: "",
      })
    );

    const { result } = renderHook(() => useSecureMessages("conv-1"), { wrapper: wrap(crypto, store) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(async () => {
      await result.current.sendMessage("hi");
    });

    const framed = encSpy.mock.calls[0][1] as Uint8Array;
    expect(framed.length).toBe(32); // "hi" → 2 + 5-byte header → bucket 32, not 2 bytes
    expect(result.current.messages[0]?.plaintext).toBe("hi"); // optimistic text preserved
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
    expect(result.current.messages[0]?.plaintext).toBeNull();
  });
});
