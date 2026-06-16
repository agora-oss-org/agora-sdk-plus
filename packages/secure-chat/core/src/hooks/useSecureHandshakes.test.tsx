// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { MockSecureChatCrypto } from "@agora-sdk/secure-chat-crypto/testing";
import { SecureChatProvider } from "../context/secure-chat-context.js";
import { useSecureHandshakes } from "./useSecureHandshakes.js";
import { useSecureMessages } from "./useSecureMessages.js";
import { MemoryStore } from "../persistence/memory-store.js";
import { SecureChatRepository } from "../persistence/repository.js";
import { SecureChatRestClient } from "../transport/rest.js";
import { SecureChatSocketClient } from "../transport/socket.js";
import { toBase64 } from "../util/base64.js";
import { padPlaintext } from "../util/padding.js";
import type { SecureDeviceModel, SecureHandshakeModel, SecureMessageModel } from "../contract/index.js";

const bobRow: SecureDeviceModel = {
  id: "bob-row", projectId: "p", userId: "bob", deviceId: "bob-dev", displayName: null,
  signaturePublicKey: "", credential: "", ciphersuite: 1,
  revokedAt: null, lastSeenAt: null, createdAt: "", updatedAt: "",
};

/** Captured live socket handlers, keyed by event name, so tests can fire welcome/handshake events. */
let handlers: Record<string, (h: SecureHandshakeModel) => void>;
let joinSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  handlers = {};
  vi.spyOn(SecureChatSocketClient.prototype, "on").mockImplementation(
    ((event: string, handler: (h: SecureHandshakeModel) => void) => {
      handlers[event] = handler;
      return () => {
        delete handlers[event];
      };
    }) as never
  );
  joinSpy = vi.spyOn(SecureChatSocketClient.prototype, "joinConversation").mockReturnValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

function wrap(crypto: MockSecureChatCrypto, store: MemoryStore) {
  return ({ children }: { children: React.ReactNode }) => (
    <SecureChatProvider crypto={crypto} projectId="p" store={store} accessToken="t">
      {children}
    </SecureChatProvider>
  );
}

/** Seed the recipient's persisted device so the hook can resolve its inbox id ("bob-row"). */
async function seedDevice(store: MemoryStore) {
  await new SecureChatRepository(store).saveDevice({
    deviceId: "bob-dev",
    deviceState: new Uint8Array([1]),
    device: bobRow,
  });
}

/** A creator instance + a Welcome targeted at `bob-row`, plus the group handle for later commits. */
async function makeGroupAndWelcome() {
  const creator = new MockSecureChatCrypto();
  await creator.generateDeviceIdentity({ deviceId: "alice-dev" });
  const { group, welcomes } = await creator.createGroup({
    initialMembers: [{ deviceId: "bob-row", keyPackage: new Uint8Array() }],
  });
  const welcome = welcomes.find((w) => w.targetDeviceId === "bob-row")!;
  return { creator, group, welcomePayload: welcome.payload };
}

function welcomeRow(seq: string, payload: Uint8Array): SecureHandshakeModel {
  return {
    id: `h-${seq}`, seq, kind: "welcome", conversationId: "conv-1", epoch: "0",
    payload: toBase64(payload), senderDeviceId: "alice-row", targetDeviceId: "bob-row",
  };
}

describe("useSecureHandshakes", () => {
  it("catch-up: processes a Welcome from the inbox, joins the group, persists the cursor", async () => {
    const { welcomePayload } = await makeGroupAndWelcome();
    vi.spyOn(SecureChatRestClient.prototype, "fetchHandshakes").mockResolvedValue({
      handshakes: [welcomeRow("1", welcomePayload)], hasMore: false,
    });

    const recipient = new MockSecureChatCrypto();
    const store = new MemoryStore();
    await seedDevice(store);

    const { result } = renderHook(() => useSecureHandshakes(), { wrapper: wrap(recipient, store) });
    await waitFor(() => expect(result.current.ready).toBe(true));

    expect(await store.get("group:conv-1")).not.toBeNull(); // joined + persisted
    expect(joinSpy).toHaveBeenCalledWith("conv-1");
    expect(result.current.cursor).toBe("1");
    expect(await new SecureChatRepository(store).loadHandshakeCursor()).toBe("1");
  });

  it("live: processes a Welcome that arrives after catch-up completes", async () => {
    const { welcomePayload } = await makeGroupAndWelcome();
    vi.spyOn(SecureChatRestClient.prototype, "fetchHandshakes").mockResolvedValue({
      handshakes: [], hasMore: false,
    });
    const recipient = new MockSecureChatCrypto();
    const store = new MemoryStore();
    await seedDevice(store);

    const { result } = renderHook(() => useSecureHandshakes(), { wrapper: wrap(recipient, store) });
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(async () => {
      handlers["secure:welcome"]!(welcomeRow("1", welcomePayload));
    });
    await waitFor(async () => expect(await store.get("group:conv-1")).not.toBeNull());
    expect(result.current.cursor).toBe("1");
  });

  it("processes a Commit that advances the group's epoch", async () => {
    const { creator, group } = await makeGroupAndWelcome();
    const recipient = new MockSecureChatCrypto();
    const store = new MemoryStore();
    await seedDevice(store);

    // Recipient already holds the group at epoch 0 (joined out-of-band): import the creator's state.
    const handle = await recipient.importGroupState(await creator.exportGroupState(group));
    await new SecureChatRepository(store).saveGroupState("conv-1", await recipient.exportGroupState(handle));

    // Creator publishes a membership Commit (advances epoch 0 → 1).
    const commit = await creator.addMember(group, { deviceId: "carol-row", keyPackage: new Uint8Array() });
    const commitRow: SecureHandshakeModel = {
      id: "h-2", seq: "2", kind: "commit", conversationId: "conv-1", epoch: "1",
      payload: toBase64(commit.commit), senderDeviceId: "alice-row", targetDeviceId: null,
    };
    vi.spyOn(SecureChatRestClient.prototype, "fetchHandshakes").mockResolvedValue({
      handshakes: [commitRow], hasMore: false,
    });

    const { result } = renderHook(() => useSecureHandshakes(), { wrapper: wrap(recipient, store) });
    await waitFor(() => expect(result.current.ready).toBe(true));

    expect(result.current.cursor).toBe("2");
    const advanced = await recipient.importGroupState((await store.get("group:conv-1"))!);
    expect(advanced.epoch).toBe(1n); // epoch advanced by the processed Commit
  });

  it("live flush: a message that arrived before the group resolves decrypts once the Welcome lands", async () => {
    const { creator, group, welcomePayload } = await makeGroupAndWelcome();
    const { ciphertext } = await creator.encryptMessage(group, padPlaintext(new TextEncoder().encode("hello bob")));
    const msgRow: SecureMessageModel = {
      id: "m1", projectId: "p", conversationId: "conv-1", senderUserId: "alice", senderDeviceId: "alice-row",
      epoch: "0", ciphertext: toBase64(ciphertext), contentType: "text/plain", createdAt: "",
    };
    vi.spyOn(SecureChatRestClient.prototype, "listMessages").mockResolvedValue({
      messages: [msgRow], hasMore: false,
    });
    vi.spyOn(SecureChatRestClient.prototype, "fetchHandshakes").mockResolvedValue({
      handshakes: [], hasMore: false,
    });

    const recipient = new MockSecureChatCrypto();
    const store = new MemoryStore();
    await seedDevice(store);

    const { result } = renderHook(
      () => ({ hs: useSecureHandshakes(), msgs: useSecureMessages("conv-1") }),
      { wrapper: wrap(recipient, store) }
    );
    // Before the Welcome, the message is listed but undecryptable (no group yet).
    await waitFor(() => expect(result.current.hs.ready).toBe(true));
    await waitFor(() =>
      expect(result.current.msgs.messages.find((m) => m.model.id === "m1")).toBeDefined()
    );
    expect(result.current.msgs.messages.find((m) => m.model.id === "m1")?.plaintext).toBeNull();

    // The Welcome lands live → join → group-version bump → useSecureMessages re-resolves + flushes.
    await act(async () => {
      handlers["secure:welcome"]!(welcomeRow("1", welcomePayload));
    });
    await waitFor(() =>
      expect(result.current.msgs.messages.find((m) => m.model.id === "m1")?.plaintext).toBe("hello bob")
    );
  });

  it("dedupes already-processed and stale handshakes (idempotent)", async () => {
    const { welcomePayload } = await makeGroupAndWelcome();
    vi.spyOn(SecureChatRestClient.prototype, "fetchHandshakes").mockResolvedValue({
      handshakes: [welcomeRow("5", welcomePayload)], hasMore: false,
    });
    const recipient = new MockSecureChatCrypto();
    const processWelcomeSpy = vi.spyOn(recipient, "processWelcome");
    const store = new MemoryStore();
    await seedDevice(store);

    const { result } = renderHook(() => useSecureHandshakes(), { wrapper: wrap(recipient, store) });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(processWelcomeSpy).toHaveBeenCalledTimes(1); // catch-up processed seq 5

    // Re-deliver seq 5 (duplicate) and a stale seq 3 — both must be skipped.
    await act(async () => {
      handlers["secure:welcome"]!(welcomeRow("5", welcomePayload));
      handlers["secure:welcome"]!(welcomeRow("3", welcomePayload));
    });
    await waitFor(() => expect(result.current.cursor).toBe("5"));
    expect(processWelcomeSpy).toHaveBeenCalledTimes(1); // no reprocessing
  });

  it("resumes from the persisted cursor on a fresh mount", async () => {
    const { welcomePayload } = await makeGroupAndWelcome();
    const store = new MemoryStore();
    await seedDevice(store);

    // First session processes up to seq 9.
    const fetch1 = vi.spyOn(SecureChatRestClient.prototype, "fetchHandshakes").mockResolvedValue({
      handshakes: [welcomeRow("9", welcomePayload)], hasMore: false,
    });
    const first = renderHook(() => useSecureHandshakes(), { wrapper: wrap(new MockSecureChatCrypto(), store) });
    await waitFor(() => expect(first.result.current.cursor).toBe("9"));
    first.unmount();
    fetch1.mockRestore();

    // Second session must resume from since="9".
    const fetch2 = vi.spyOn(SecureChatRestClient.prototype, "fetchHandshakes").mockResolvedValue({
      handshakes: [], hasMore: false,
    });
    const second = renderHook(() => useSecureHandshakes(), { wrapper: wrap(new MockSecureChatCrypto(), store) });
    await waitFor(() => expect(second.result.current.ready).toBe(true));
    expect(fetch2.mock.calls[0]?.[1]).toEqual({ since: "9", limit: 100 });
  });

  it("buffers a live handshake arriving during catch-up and replays it (not dropped)", async () => {
    const a = await makeGroupAndWelcome();
    const b = await makeGroupAndWelcome();
    // A deferred catch-up fetch lets us fire a live event WHILE catch-up is in flight.
    let resolveFetch!: (v: { handshakes: SecureHandshakeModel[]; hasMore: boolean }) => void;
    const fetchP = new Promise<{ handshakes: SecureHandshakeModel[]; hasMore: boolean }>((r) => {
      resolveFetch = r;
    });
    vi.spyOn(SecureChatRestClient.prototype, "fetchHandshakes").mockReturnValue(fetchP as never);

    const recipient = new MockSecureChatCrypto();
    const store = new MemoryStore();
    await seedDevice(store);
    const { result } = renderHook(() => useSecureHandshakes(), { wrapper: wrap(recipient, store) });

    // Live welcome (conv-2) arrives during catch-up → must be buffered, not applied yet.
    await waitFor(() => expect(handlers["secure:welcome"]).toBeDefined());
    await act(async () => {
      handlers["secure:welcome"]!({ ...welcomeRow("2", b.welcomePayload), conversationId: "conv-2" });
    });
    expect(await store.get("group:conv-2")).toBeNull();

    // Resolve catch-up (conv-1, seq 1); both the catch-up row and the buffered live row must apply.
    await act(async () => {
      resolveFetch({ handshakes: [welcomeRow("1", a.welcomePayload)], hasMore: false });
    });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(await store.get("group:conv-1")).not.toBeNull();
    expect(await store.get("group:conv-2")).not.toBeNull();
    expect(result.current.cursor).toBe("2");
  });

  it("skips a handshake whose processing throws and advances past it (no wedge)", async () => {
    const { welcomePayload } = await makeGroupAndWelcome();
    const recipient = new MockSecureChatCrypto();
    const processWelcomeSpy = vi
      .spyOn(recipient, "processWelcome")
      .mockRejectedValueOnce(new Error("bad blob")); // first row poisons; later calls run for real
    const store = new MemoryStore();
    await seedDevice(store);
    const errors: unknown[] = [];

    vi.spyOn(SecureChatRestClient.prototype, "fetchHandshakes").mockResolvedValue({
      handshakes: [
        welcomeRow("1", welcomePayload),
        { ...welcomeRow("2", welcomePayload), conversationId: "conv-2" },
      ],
      hasMore: false,
    });

    const { result } = renderHook(() => useSecureHandshakes({ onError: (e) => errors.push(e) }), {
      wrapper: wrap(recipient, store),
    });
    await waitFor(() => expect(result.current.ready).toBe(true));

    expect(errors).toHaveLength(1); // the poison row was reported
    expect(await store.get("group:conv-1")).toBeNull(); // seq 1 threw → not joined
    expect(await store.get("group:conv-2")).not.toBeNull(); // seq 2 still processed (no wedge)
    expect(result.current.cursor).toBe("2"); // cursor advanced past the poison row
    expect(processWelcomeSpy).toHaveBeenCalledTimes(2);
  });

  it("pages through the catch-up loop until hasMore is false", async () => {
    const a = await makeGroupAndWelcome();
    const b = await makeGroupAndWelcome();
    const fetchSpy = vi
      .spyOn(SecureChatRestClient.prototype, "fetchHandshakes")
      .mockResolvedValueOnce({ handshakes: [welcomeRow("1", a.welcomePayload)], hasMore: true })
      .mockResolvedValueOnce({
        handshakes: [{ ...welcomeRow("2", b.welcomePayload), conversationId: "conv-2" }],
        hasMore: false,
      });
    const store = new MemoryStore();
    await seedDevice(store);

    const { result } = renderHook(() => useSecureHandshakes(), { wrapper: wrap(new MockSecureChatCrypto(), store) });
    await waitFor(() => expect(result.current.cursor).toBe("2"));

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0]?.[1]).toEqual({ since: undefined, limit: 100 });
    expect(fetchSpy.mock.calls[1]?.[1]).toEqual({ since: "1", limit: 100 });
    expect(await store.get("group:conv-1")).not.toBeNull();
    expect(await store.get("group:conv-2")).not.toBeNull();
  });
});
