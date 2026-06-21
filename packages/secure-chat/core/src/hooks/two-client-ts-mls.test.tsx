// @vitest-environment jsdom
//
// Capstone: REAL ts-mls crypto under the REAL React hooks, two clients, one shared fake server.
//
// This is the last rung of the fault-isolation ladder (see TESTING.md). The other harnesses each leave
// one thing mocked or hand-sequenced:
//   • the foundation e2e and chat-diag run real ts-mls but NO React (transport called by hand);
//   • two-client-handshake.test.tsx runs the real hooks but with MOCK crypto.
// Only here do real ts-mls AND the real `useSecure*` hooks run together for both peers — the exact
// combination a browser uses, and the only place left for the "waiting for key update" bug to hide.
//
// Because the crypto is real, KeyPackages must really flow: bob registers + publishes real KeyPackages,
// alice claims a real one to build the group, and the Welcome/ciphertext are genuine MLS blobs. The
// fake server therefore stores and dispenses real KeyPackages (the mock harness could hand back dummies).
//
// ts-mls is deliberately slow (real KDF/HPKE), so timeouts are generous and the suite is intentionally
// small — coverage of the hook ORCHESTRATION lives in the fast mock file; this proves it holds under
// real crypto.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { createTsMlsSecureChatCrypto } from "../../../crypto/src/ts-mls/index.js";
import { SecureChatProvider } from "../context/secure-chat-context.js";
import { useSecureDevice } from "./useSecureDevice.js";
import { useSecureHandshakes } from "./useSecureHandshakes.js";
import { useSecureConversations } from "./useSecureConversations.js";
import { useSecureMessages } from "./useSecureMessages.js";
import { MemoryStore } from "../persistence/memory-store.js";
import { SecureChatRepository } from "../persistence/repository.js";
import { SecureChatRestClient } from "../transport/rest.js";
import { SecureChatSocketClient } from "../transport/socket.js";
import { toBase64 } from "../util/base64.js";
import type {
  CreateSecureConversationBody,
  PublishKeyPackagesBody,
  SecureConversationModel,
  SecureDeviceModel,
  SecureHandshakeModel,
  SecureKeyPackageClaim,
  SecureMessageModel,
  SendSecureMessageBody,
} from "../contract/index.js";

// ts-mls operations (KDF/HPKE) are slow; give the crypto-heavy waits + tests plenty of room.
const SLOW = 60_000;
const WAIT = { timeout: 25_000 } as const;

const ALICE_TOKEN = "tok-alice";
const BOB_TOKEN = "tok-bob";
const TOKEN_USER: Record<string, string> = { [ALICE_TOKEN]: "alice", [BOB_TOKEN]: "bob" };
const USER_TOKEN: Record<string, string> = { alice: ALICE_TOKEN, bob: BOB_TOKEN };

function deviceRow(userId: string, rowId: string, deviceId: string): SecureDeviceModel {
  return {
    id: rowId, projectId: "p", userId, deviceId, displayName: null,
    signaturePublicKey: "", credential: "", ciphersuite: 1,
    revokedAt: null, lastSeenAt: null, createdAt: "", updatedAt: "",
  };
}
const aliceRow = deviceRow("alice", "alice-row", "alice-dev");

// ── Fake Delivery Service with a REAL KeyPackage store ─────────────────────────
/** In-memory blind-DS stand-in. Unlike the mock harness it stores/dispenses real KeyPackages. */
class FakeServer {
  private seq = 0;
  private clock = 1;
  private convCount = 0;
  private readonly devicesByUser = new Map<string, SecureDeviceModel[]>();
  private readonly deviceById = new Map<string, SecureDeviceModel>();
  private readonly keyPackagesByDevice = new Map<string, string[]>(); // row id -> base64 KeyPackages
  private readonly members = new Map<string, Set<string>>();
  private readonly conversations = new Map<string, SecureConversationModel>();
  private readonly handshakes: SecureHandshakeModel[] = [];
  private readonly messages = new Map<string, SecureMessageModel[]>();
  onBroadcast: ((row: SecureMessageModel, recipientUserIds: string[]) => void) | null = null;
  onWelcome: ((row: SecureHandshakeModel, recipientUserId: string) => void) | null = null;
  onMemberJoined: ((recipientUserIds: string[]) => void) | null = null;

  private ts(): string {
    return new Date(this.clock++ * 1000).toISOString();
  }

  addDevice(row: SecureDeviceModel): void {
    const list = this.devicesByUser.get(row.userId) ?? [];
    list.push(row);
    this.devicesByUser.set(row.userId, list);
    this.deviceById.set(row.id, row);
  }

  registerDevice(callerUserId: string, deviceId: string): SecureDeviceModel {
    const row = deviceRow(callerUserId, `${callerUserId}-row-${++this.seq}`, deviceId);
    this.addDevice(row);
    return row;
  }

  listDevices(userId: string): SecureDeviceModel[] {
    return [...(this.devicesByUser.get(userId) ?? [])];
  }

  publishKeyPackages(deviceId: string, body: PublishKeyPackagesBody): number {
    const list = this.keyPackagesByDevice.get(deviceId) ?? [];
    for (const kp of body.keyPackages) list.push(kp.keyPackage);
    this.keyPackagesByDevice.set(deviceId, list);
    return body.keyPackages.length;
  }

  keyPackageCount(deviceId: string): number {
    return (this.keyPackagesByDevice.get(deviceId) ?? []).length;
  }

  /** Atomically hand out one of the target device's REAL published KeyPackages. */
  claim(targetDeviceId: string): SecureKeyPackageClaim {
    const list = this.keyPackagesByDevice.get(targetDeviceId) ?? [];
    const keyPackage = list.shift();
    if (!keyPackage) throw new Error(`fake-server: no KeyPackages to claim for ${targetDeviceId}`);
    return { deviceId: targetDeviceId, keyPackageRef: `kpref-${++this.seq}`, keyPackage, ciphersuite: 1 };
  }

  createConversation(creatorUserId: string, body: CreateSecureConversationBody): SecureConversationModel {
    const id = `conv-${++this.convCount}`;
    const now = this.ts();
    const conversation: SecureConversationModel = {
      id, projectId: "p", type: body.type, mlsGroupId: body.mlsGroupId, spaceId: null,
      currentEpoch: "1", name: null, createdById: creatorUserId, lastMessageAt: null,
      createdAt: now, updatedAt: now,
    };
    this.conversations.set(id, conversation);
    const memberSet = new Set<string>([creatorUserId, ...(body.memberUserIds ?? [])]);
    this.members.set(id, memberSet);
    this.messages.set(id, []);
    this.onMemberJoined?.([...memberSet].filter((u) => u !== creatorUserId));
    for (const w of body.welcomes ?? []) {
      const row: SecureHandshakeModel = {
        id: `h-${++this.seq}`, seq: String(this.seq), kind: "welcome", conversationId: id,
        epoch: w.epoch, payload: w.payload, senderDeviceId: aliceRow.id, targetDeviceId: w.targetDeviceId,
      };
      this.handshakes.push(row);
      const recipientUserId = w.targetDeviceId ? this.deviceById.get(w.targetDeviceId)?.userId : undefined;
      if (recipientUserId) this.onWelcome?.(row, recipientUserId);
    }
    return conversation;
  }

  listConversations(callerUserId: string): { conversations: SecureConversationModel[]; hasMore: boolean } {
    const mine = [...this.conversations.values()].filter((c) => this.members.get(c.id)?.has(callerUserId));
    mine.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return { conversations: mine, hasMore: false };
  }

  fetchHandshakes(deviceId: string, since?: string): { handshakes: SecureHandshakeModel[]; hasMore: boolean } {
    const rows = this.handshakes
      .filter((h) => h.targetDeviceId === deviceId)
      .filter((h) => (since ? BigInt(h.seq) > BigInt(since) : true))
      .sort((a, b) => (BigInt(a.seq) > BigInt(b.seq) ? 1 : -1));
    return { handshakes: rows, hasMore: false };
  }

  sendMessage(callerUserId: string, conversationId: string, body: SendSecureMessageBody): SecureMessageModel {
    const row: SecureMessageModel = {
      id: `m-${++this.seq}`, projectId: "p", conversationId,
      senderUserId: callerUserId, senderDeviceId: body.senderDeviceId,
      epoch: body.epoch, ciphertext: body.ciphertext,
      contentType: body.contentType ?? "text/plain", createdAt: this.ts(),
    };
    (this.messages.get(conversationId) ?? []).push(row);
    const recipients = [...(this.members.get(conversationId) ?? [])].filter((u) => u !== callerUserId);
    this.onBroadcast?.(row, recipients);
    return row;
  }

  listMessages(conversationId: string): { messages: SecureMessageModel[]; hasMore: boolean } {
    const all = [...(this.messages.get(conversationId) ?? [])];
    all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return { messages: all, hasMore: false };
  }
}

let server: FakeServer;
let socketHandlers: Map<string, Record<string, Array<(p: never) => void>>>;

function callerToken(self: unknown): string {
  return (self as { config: { getAccessToken: () => string } }).config.getAccessToken();
}
function callerUser(self: unknown): string {
  return TOKEN_USER[callerToken(self)]!;
}
function emitTo(token: string, event: string, payload: unknown): void {
  socketHandlers.get(token)?.[event]?.forEach((h) => h(payload as never));
}

beforeEach(() => {
  server = new FakeServer();
  server.addDevice(aliceRow); // alice (initiator) is pre-registered; bob self-registers via the hook
  socketHandlers = new Map();
  server.onBroadcast = (row, recipients) => {
    for (const u of recipients) emitTo(USER_TOKEN[u]!, "secure:message", row);
  };
  server.onWelcome = (row, recipientUserId) => emitTo(USER_TOKEN[recipientUserId]!, "secure:welcome", row);
  server.onMemberJoined = (recipients) => {
    for (const u of recipients) emitTo(USER_TOKEN[u]!, "secure:member:joined", {});
  };

  vi.spyOn(SecureChatRestClient.prototype, "listDevices").mockImplementation(async function (this: unknown, userId: string) {
    return server.listDevices(userId);
  } as never);
  vi.spyOn(SecureChatRestClient.prototype, "registerDevice").mockImplementation(async function (this: unknown, body: { deviceId: string }) {
    return server.registerDevice(callerUser(this), body.deviceId);
  } as never);
  vi.spyOn(SecureChatRestClient.prototype, "publishKeyPackages").mockImplementation(async function (this: unknown, deviceId: string, body: PublishKeyPackagesBody) {
    return server.publishKeyPackages(deviceId, body);
  } as never);
  vi.spyOn(SecureChatRestClient.prototype, "keyPackageCount").mockImplementation(async function (this: unknown, deviceId: string) {
    return server.keyPackageCount(deviceId);
  } as never);
  vi.spyOn(SecureChatRestClient.prototype, "deviceExists").mockResolvedValue(true);
  vi.spyOn(SecureChatRestClient.prototype, "claimKeyPackage").mockImplementation(async function (this: unknown, deviceId: string) {
    return server.claim(deviceId);
  } as never);
  vi.spyOn(SecureChatRestClient.prototype, "createConversation").mockImplementation(async function (this: unknown, body: CreateSecureConversationBody) {
    return server.createConversation(callerUser(this), body);
  } as never);
  vi.spyOn(SecureChatRestClient.prototype, "listConversations").mockImplementation(async function (this: unknown) {
    return server.listConversations(callerUser(this));
  } as never);
  vi.spyOn(SecureChatRestClient.prototype, "fetchHandshakes").mockImplementation(async function (this: unknown, deviceId: string, params?: { since?: string }) {
    return server.fetchHandshakes(deviceId, params?.since);
  } as never);
  vi.spyOn(SecureChatRestClient.prototype, "sendMessage").mockImplementation(async function (this: unknown, conversationId: string, body: SendSecureMessageBody) {
    return server.sendMessage(callerUser(this), conversationId, body);
  } as never);
  vi.spyOn(SecureChatRestClient.prototype, "listMessages").mockImplementation(async function (this: unknown, conversationId: string) {
    return server.listMessages(conversationId);
  } as never);

  vi.spyOn(SecureChatSocketClient.prototype, "on").mockImplementation(function (this: unknown, event: string, handler: (p: never) => void) {
    const token = callerToken(this);
    const reg = socketHandlers.get(token) ?? {};
    (reg[event] ??= []).push(handler);
    socketHandlers.set(token, reg);
    return () => {
      const list = reg[event];
      if (list) reg[event] = list.filter((h) => h !== handler);
    };
  } as never);
  vi.spyOn(SecureChatSocketClient.prototype, "joinConversation").mockReturnValue(undefined);
  vi.spyOn(SecureChatSocketClient.prototype, "disconnect").mockReturnValue(undefined);
  vi.spyOn(SecureChatSocketClient.prototype, "connect").mockReturnValue({
    emit: () => undefined, on: () => undefined, disconnect: () => undefined,
  } as never);
});
afterEach(() => vi.restoreAllMocks());

type Crypto = ReturnType<typeof createTsMlsSecureChatCrypto>;

function wrap(crypto: Crypto, store: MemoryStore, token: string) {
  return ({ children }: { children: React.ReactNode }) => (
    <SecureChatProvider crypto={crypto} projectId="p" baseUrl="http://localhost:4000/v7" store={store} accessToken={token}>
      {children}
    </SecureChatProvider>
  );
}

async function seedDevice(store: MemoryStore, row: SecureDeviceModel, deviceState: Uint8Array): Promise<void> {
  await new SecureChatRepository(store).saveDevice({ deviceId: row.deviceId, deviceState, device: row });
}

/** Alice (initiator) drives her hooks: start the DM with bob, then send `text` — all real ts-mls. */
async function aliceStartsDmAndSends(aliceCrypto: Crypto, aliceStore: MemoryStore, text: string): Promise<string> {
  const aliceWrap = wrap(aliceCrypto, aliceStore, ALICE_TOKEN);
  const convs = renderHook(() => useSecureConversations(), { wrapper: aliceWrap });
  let conversationId = "";
  await act(async () => {
    const conv = await convs.result.current.createDirectConversation("bob");
    conversationId = conv.id;
  });
  convs.unmount();

  const aliceGroup = await aliceCrypto.importGroupState((await aliceStore.get(`group:${conversationId}`))!);
  const msgs = renderHook(
    () => useSecureMessages(conversationId, { group: aliceGroup, senderDeviceId: aliceRow.id }),
    { wrapper: aliceWrap }
  );
  await act(async () => {
    await msgs.result.current.sendMessage(text);
  });
  msgs.unmount();
  return conversationId;
}

/** Bob's full stack: the real device→handshakes→messages wiring an app uses. `convId` is a render prop. */
function bobFullStack({ convId }: { convId: string }) {
  const dev = useSecureDevice({ autoReplenish: false });
  const hs = useSecureHandshakes({ deviceId: dev.device?.id });
  const convs = useSecureConversations();
  const msgs = useSecureMessages(convId);
  return { dev, hs, convs, msgs };
}

describe("two-client secure chat under REAL ts-mls + the real hooks", () => {
  it("bob registers, publishes KeyPackages, then opens a pending DM and decrypts a real MLS message", async () => {
    const PLAINTEXT = "hello bob — real MLS, real hooks 💜";

    // Alice: real ts-mls identity, pre-seeded device row (she's the initiator, not the subject).
    const aliceCrypto = createTsMlsSecureChatCrypto();
    await aliceCrypto.generateDeviceIdentity({ deviceId: aliceRow.deviceId });
    const aliceStore = new MemoryStore();
    await seedDevice(aliceStore, aliceRow, await aliceCrypto.exportDeviceState());

    // Bob: real ts-mls, empty store, full stack — registers and publishes real KeyPackages via the hook.
    const bobCrypto = createTsMlsSecureChatCrypto();
    const bobStore = new MemoryStore();
    const bob = renderHook(bobFullStack, {
      wrapper: wrap(bobCrypto, bobStore, BOB_TOKEN),
      initialProps: { convId: "" },
    });

    await waitFor(() => expect(bob.result.current.dev.loading).toBe(false), WAIT);
    await act(async () => {
      await bob.result.current.dev.register();
    });
    // publishKeyPackages closes over `device`, so it must run from the post-register render (not the
    // same act, where the callback still sees device=null).
    await waitFor(() => expect(bob.result.current.dev.device).not.toBeNull(), WAIT);
    await act(async () => {
      await bob.result.current.dev.publishKeyPackages(3); // real KeyPackages bob holds the private keys for
    });
    const bobRowId = bob.result.current.dev.device!.id;
    expect(server.keyPackageCount(bobRowId)).toBe(3);

    // Alice claims one of bob's REAL KeyPackages, builds the group, relays the real Welcome, sends.
    const conversationId = await aliceStartsDmAndSends(aliceCrypto, aliceStore, PLAINTEXT);

    // Bob is signalled into the conversation, opens it, drains the real Welcome → joins → decrypts.
    await waitFor(
      () => expect(bob.result.current.convs.conversations.map((c) => c.id)).toContain(conversationId),
      WAIT
    );
    bob.rerender({ convId: conversationId });

    await waitFor(() => {
      const m = bob.result.current.msgs.messages.find((x) => x.model.conversationId === conversationId);
      expect(m?.status).toBe("ok");
      expect(m?.content?.body).toBe(PLAINTEXT);
    }, WAIT);
    expect(await bobStore.get(`group:${conversationId}`)).not.toBeNull();

    bob.unmount();
  }, SLOW);

  it("after joining, bob decrypts a real live message over the socket", async () => {
    const FIRST = "first — via catch-up";
    const SECOND = "second — live over the socket";

    const aliceCrypto = createTsMlsSecureChatCrypto();
    await aliceCrypto.generateDeviceIdentity({ deviceId: aliceRow.deviceId });
    const aliceStore = new MemoryStore();
    await seedDevice(aliceStore, aliceRow, await aliceCrypto.exportDeviceState());

    const bobCrypto = createTsMlsSecureChatCrypto();
    const bobStore = new MemoryStore();
    const bob = renderHook(bobFullStack, {
      wrapper: wrap(bobCrypto, bobStore, BOB_TOKEN),
      initialProps: { convId: "" },
    });
    await waitFor(() => expect(bob.result.current.dev.loading).toBe(false), WAIT);
    await act(async () => {
      await bob.result.current.dev.register();
    });
    await waitFor(() => expect(bob.result.current.dev.device).not.toBeNull(), WAIT);
    await act(async () => {
      await bob.result.current.dev.publishKeyPackages(3);
    });

    // Alice creates the DM. Bob (already online) gets the Welcome live → joins. Both messages are then
    // sent from ONE alice message hook, so its MLS encryption ratchet advances naturally between sends
    // (re-importing a stale handle per send would reuse a generation — a real-MLS replay, not a bug).
    const aliceWrap = wrap(aliceCrypto, aliceStore, ALICE_TOKEN);
    const aliceConvs = renderHook(() => useSecureConversations(), { wrapper: aliceWrap });
    let conversationId = "";
    await act(async () => {
      conversationId = (await aliceConvs.result.current.createDirectConversation("bob")).id;
    });
    aliceConvs.unmount();

    await waitFor(
      () => expect(bob.result.current.convs.conversations.map((c) => c.id)).toContain(conversationId),
      WAIT
    );
    bob.rerender({ convId: conversationId });

    const aliceGroup = await aliceCrypto.importGroupState((await aliceStore.get(`group:${conversationId}`))!);
    const aliceMsgs = renderHook(
      () => useSecureMessages(conversationId, { group: aliceGroup, senderDeviceId: aliceRow.id }),
      { wrapper: aliceWrap }
    );

    // FIRST then SECOND from the same handle (generations 0, 1); both fan to bob's socket live.
    await act(async () => {
      await aliceMsgs.result.current.sendMessage(FIRST);
    });
    await waitFor(() => {
      const m = bob.result.current.msgs.messages.find((x) => x.content?.body === FIRST);
      expect(m?.status).toBe("ok");
    }, WAIT);

    await act(async () => {
      await aliceMsgs.result.current.sendMessage(SECOND);
    });
    await waitFor(() => {
      const m = bob.result.current.msgs.messages.find((x) => x.content?.body === SECOND);
      expect(m?.status).toBe("ok");
    }, WAIT);
    aliceMsgs.unmount();

    bob.unmount();
  }, SLOW);
});
