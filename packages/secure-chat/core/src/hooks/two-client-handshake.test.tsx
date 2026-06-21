// @vitest-environment jsdom
//
// Two-client hook-orchestration test — the missing layer above the transport/e2e harnesses.
//
// The transport e2e (`e2e/secure-chat.e2e.ts`) and the two-process `chat-diag` harness both prove the
// stack BELOW React: transport, wire contract, ts-mls crypto, server blindness, and the handshake
// inbox all work, even across two OS processes. Neither exercises the React hooks — they call
// crypto+transport by hand in a fixed, correct order. This test closes that gap: it drives BOTH peers
// through the real `useSecure*` hooks against one shared in-memory server, so the hooks decide the
// ordering at runtime (exactly what differs in a real browser).
//
// The symptom we reproduce is the app-level "waiting for key update": a recipient who can SEE a
// conversation (it's listed from server membership) but whose messages stay `status:"pending"` /
// `plaintext:null` because the MLS group was never joined. In SDK terms that is: `useSecureMessages`
// lists ciphertext it cannot decrypt until `useSecureHandshakes` processes the Welcome → `rememberGroup`
// → group-version bump → re-resolve → flush. These tests assert that chain works in composition (and
// characterize the symptom when the handshake hook is absent).
//
// Everything is mock crypto + a fake transport, per the repo's unit-test rules: no real MLS, no live
// server. The fake server is shared by both clients and routed per-caller via the bearer token each
// provider was given, so alice and bob see independent, consistent server state.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { MockSecureChatCrypto } from "@agora-sdk/secure-chat-crypto/testing";
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
  SecureConversationModel,
  SecureDeviceModel,
  SecureHandshakeModel,
  SecureKeyPackageClaim,
  SecureMessageModel,
  SendSecureMessageBody,
} from "../contract/index.js";

// ── Identities ──────────────────────────────────────────────────────────────
// deviceId (client text) ≠ device.id (server row uuid): Welcomes/messages route on the ROW id, so the
// inbox id bob drains and the Welcome's targetDeviceId are both "*-row", not "*-dev".
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
const bobRow = deviceRow("bob", "bob-row", "bob-dev");

// ── In-memory fake Delivery Service (shared by both clients) ───────────────────
/** A blind-DS stand-in: stores devices, conversations, the handshake inbox, and messages in memory. */
class FakeServer {
  private seq = 0;
  private clock = 1;
  private convCount = 0;
  private readonly devicesByUser = new Map<string, SecureDeviceModel[]>();
  private readonly deviceById = new Map<string, SecureDeviceModel>(); // row id -> device (for routing)
  private readonly members = new Map<string, Set<string>>(); // conversationId -> userIds
  private readonly conversations = new Map<string, SecureConversationModel>();
  private readonly handshakes: SecureHandshakeModel[] = [];
  private readonly messages = new Map<string, SecureMessageModel[]>();
  /** When true, the inbox returns nothing — simulates a Welcome that never reached the recipient. */
  suppressDelivery = false;
  /** Fan a stored message out to its other members' live sockets (set by the test). */
  onBroadcast: ((row: SecureMessageModel, recipientUserIds: string[]) => void) | null = null;
  /** Relay a targeted Welcome to its recipient's live socket (set by the test). */
  onWelcome: ((row: SecureHandshakeModel, recipientUserId: string) => void) | null = null;
  /** Signal new members (so their useSecureConversations refreshes), as the server does on create. */
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

  /** Register a caller's device (server assigns the row id) — the useSecureDevice path. */
  registerDevice(callerUserId: string, deviceId: string): SecureDeviceModel {
    const row = deviceRow(callerUserId, `${callerUserId}-row-${++this.seq}`, deviceId);
    this.addDevice(row);
    return row;
  }

  listDevices(userId: string): SecureDeviceModel[] {
    return [...(this.devicesByUser.get(userId) ?? [])];
  }

  /** A non-zero stock so deviceExists() reads as present and replenishment sees headroom. */
  keyPackageCount(): number {
    return 5;
  }

  /** Mock crypto ignores KeyPackage bytes for group creation, so any non-empty blob suffices. */
  claim(targetDeviceId: string): SecureKeyPackageClaim {
    return {
      deviceId: targetDeviceId,
      keyPackageRef: `kpref-${++this.seq}`,
      keyPackage: toBase64(new Uint8Array([1])),
      ciphersuite: 1,
    };
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
    // Signal every non-creator member that they were added (server emits secure:member:joined).
    this.onMemberJoined?.([...memberSet].filter((u) => u !== creatorUserId));
    // Relay each targeted Welcome into the inbox as a seq-ordered handshake row, and (if mounted) fan
    // it to the recipient's live socket — the durable inbox covers catch-up, the live event covers a
    // recipient already online when the DM is created.
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
    // Newest activity first (createdAt is strictly increasing via `clock`).
    mine.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return { conversations: mine, hasMore: false };
  }

  fetchHandshakes(deviceId: string, since?: string): { handshakes: SecureHandshakeModel[]; hasMore: boolean } {
    if (this.suppressDelivery) return { handshakes: [], hasMore: false };
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
    // Blind fan-out: notify every other member's live socket (the recipient decrypts client-side).
    const recipients = [...(this.members.get(conversationId) ?? [])].filter((u) => u !== callerUserId);
    this.onBroadcast?.(row, recipients);
    return row;
  }

  listMessages(conversationId: string): { messages: SecureMessageModel[]; hasMore: boolean } {
    const all = [...(this.messages.get(conversationId) ?? [])];
    all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // newest first
    return { messages: all, hasMore: false };
  }
}

// ── Test wiring: route the real clients at the fake server, keyed by caller token ──
let server: FakeServer;
/** Live socket handlers, keyed by token → event → handlers, so we can fan messages to one client. */
let socketHandlers: Map<string, Record<string, Array<(p: never) => void>>>;

/** The bearer token the calling rest/socket instance was configured with → which user is calling. */
function callerToken(self: unknown): string {
  return (self as { config: { getAccessToken: () => string } }).config.getAccessToken();
}
function callerUser(self: unknown): string {
  return TOKEN_USER[callerToken(self)]!;
}

beforeEach(() => {
  server = new FakeServer();
  // Alice (the initiator) is always pre-registered. Bob is added per-test: pre-seeded for the tests
  // that bypass useSecureDevice, or self-registered by the device-lifecycle test.
  server.addDevice(aliceRow);
  socketHandlers = new Map();
  // Server fan-out → each recipient's live socket (mirrors the blind DS relaying secure:message /
  // secure:welcome to a recipient that is already online).
  server.onBroadcast = (row, recipients) => {
    for (const u of recipients) emitTo(USER_TOKEN[u]!, "secure:message", row);
  };
  server.onWelcome = (row, recipientUserId) => {
    emitTo(USER_TOKEN[recipientUserId]!, "secure:welcome", row);
  };
  server.onMemberJoined = (recipients) => {
    for (const u of recipients) emitTo(USER_TOKEN[u]!, "secure:member:joined", {});
  };

  // REST → fake server (read the caller identity off `this.config` where the endpoint needs it).
  vi.spyOn(SecureChatRestClient.prototype, "listDevices").mockImplementation(async function (
    this: unknown, userId: string
  ) {
    return server.listDevices(userId);
  } as never);
  vi.spyOn(SecureChatRestClient.prototype, "claimKeyPackage").mockImplementation(async function (
    this: unknown, deviceId: string
  ) {
    return server.claim(deviceId);
  } as never);
  vi.spyOn(SecureChatRestClient.prototype, "createConversation").mockImplementation(async function (
    this: unknown, body: CreateSecureConversationBody
  ) {
    return server.createConversation(callerUser(this), body);
  } as never);
  vi.spyOn(SecureChatRestClient.prototype, "listConversations").mockImplementation(async function (
    this: unknown
  ) {
    return server.listConversations(callerUser(this));
  } as never);
  vi.spyOn(SecureChatRestClient.prototype, "fetchHandshakes").mockImplementation(async function (
    this: unknown, deviceId: string, params?: { since?: string }
  ) {
    return server.fetchHandshakes(deviceId, params?.since);
  } as never);
  vi.spyOn(SecureChatRestClient.prototype, "sendMessage").mockImplementation(async function (
    this: unknown, conversationId: string, body: SendSecureMessageBody
  ) {
    return server.sendMessage(callerUser(this), conversationId, body);
  } as never);
  vi.spyOn(SecureChatRestClient.prototype, "listMessages").mockImplementation(async function (
    this: unknown, conversationId: string
  ) {
    return server.listMessages(conversationId);
  } as never);
  // Device lifecycle (used only by the useSecureDevice test; harmless elsewhere).
  vi.spyOn(SecureChatRestClient.prototype, "registerDevice").mockImplementation(async function (
    this: unknown, body: { deviceId: string }
  ) {
    return server.registerDevice(callerUser(this), body.deviceId);
  } as never);
  vi.spyOn(SecureChatRestClient.prototype, "publishKeyPackages").mockImplementation(async function (
    this: unknown, _deviceId: string, body: { keyPackages: unknown[] }
  ) {
    return body.keyPackages.length;
  } as never);
  vi.spyOn(SecureChatRestClient.prototype, "keyPackageCount").mockImplementation(async function () {
    return server.keyPackageCount();
  } as never);
  vi.spyOn(SecureChatRestClient.prototype, "deviceExists").mockResolvedValue(true);

  // Socket: register handlers per caller token; everything else is inert (no real io).
  vi.spyOn(SecureChatSocketClient.prototype, "on").mockImplementation(function (
    this: unknown, event: string, handler: (p: never) => void
  ) {
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

/** Deliver a live socket event to exactly one client (by token). */
function emitTo(token: string, event: string, payload: unknown): void {
  socketHandlers.get(token)?.[event]?.forEach((h) => h(payload as never));
}

/** A provider bound to one client's crypto + store + bearer token, all pointed at the shared server. */
function wrap(crypto: MockSecureChatCrypto, store: MemoryStore, token: string) {
  return ({ children }: { children: React.ReactNode }) => (
    <SecureChatProvider crypto={crypto} projectId="p" baseUrl="http://localhost:4000/v7" store={store} accessToken={token}>
      {children}
    </SecureChatProvider>
  );
}

/** Persist a device row so `repo.loadDevice()` resolves the inbox id + senderDeviceId (no useSecureDevice). */
async function seedDevice(store: MemoryStore, row: SecureDeviceModel): Promise<void> {
  await new SecureChatRepository(store).saveDevice({
    deviceId: row.deviceId, deviceState: new Uint8Array([1]), device: row,
  });
}

/**
 * Drive alice (the initiator) fully through her hooks: start the DM with bob, then send `text`.
 * Returns the conversation id both clients share.
 */
async function aliceStartsDmAndSends(
  aliceCrypto: MockSecureChatCrypto,
  aliceStore: MemoryStore,
  text: string
): Promise<string> {
  const aliceWrap = wrap(aliceCrypto, aliceStore, ALICE_TOKEN);

  // 1. createDirectConversation: claim bob's KP → createGroup locally → POST /conversations (relays Welcome).
  const convs = renderHook(() => useSecureConversations(), { wrapper: aliceWrap });
  let conversationId = "";
  await act(async () => {
    const conv = await convs.result.current.createDirectConversation("bob");
    conversationId = conv.id;
  });
  convs.unmount();

  // 2. Send through useSecureMessages. Pass alice's just-persisted group handle + sender row id as
  //    overrides so the send is deterministic (no race against the async resolve effects).
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

/** Bob's full receive stack under ONE provider (shared group cache + version bus). */
function bobReceiveStack(conversationId: string, withHandshakes: boolean) {
  return () => ({
    hs: useSecureHandshakes({ deviceId: bobRow.id, enabled: withHandshakes }),
    convs: useSecureConversations(),
    msgs: useSecureMessages(conversationId),
  });
}

/**
 * Bob's FULL stack including the device-identity layer — the real wiring an app uses:
 * `useSecureHandshakes({ deviceId: device?.id })`. The handshake inbox is keyed off the device row id
 * that `useSecureDevice` resolves, so the inbox can't drain until registration completes. `convId` is a
 * render prop so the message hook can be pointed at the DM once its id is known (bob learns it after
 * registering). autoReplenish is off to keep the count/replenish path out of this test's scope.
 */
function bobFullStack({ convId }: { convId: string }) {
  const dev = useSecureDevice({ autoReplenish: false });
  const hs = useSecureHandshakes({ deviceId: dev.device?.id });
  const convs = useSecureConversations();
  const msgs = useSecureMessages(convId);
  return { dev, hs, convs, msgs };
}

describe("two-client handshake (hook orchestration)", () => {
  it("bob opens a pending DM: handshakes drains the Welcome → message decrypts (no 'waiting for key update')", async () => {
    const PLAINTEXT = "hello bob — does the hook layer resolve this?";
    server.addDevice(bobRow); // bob already registered server-side (this test bypasses useSecureDevice)
    const aliceCrypto = new MockSecureChatCrypto();
    await aliceCrypto.generateDeviceIdentity({ deviceId: aliceRow.deviceId });
    const aliceStore = new MemoryStore();
    await seedDevice(aliceStore, aliceRow);

    // Alice creates the DM and sends — all before bob ever mounts (the realistic "pending DM" case).
    const conversationId = await aliceStartsDmAndSends(aliceCrypto, aliceStore, PLAINTEXT);

    // Bob mounts fresh: handshakes + conversations + messages under one provider.
    const bobCrypto = new MockSecureChatCrypto();
    const bobStore = new MemoryStore();
    await seedDevice(bobStore, bobRow);
    const bob = renderHook(bobReceiveStack(conversationId, /* withHandshakes */ true), {
      wrapper: wrap(bobCrypto, bobStore, BOB_TOKEN),
    });

    // Bob lists the conversation from server membership immediately...
    await waitFor(() =>
      expect(bob.result.current.convs.conversations.map((c) => c.id)).toContain(conversationId)
    );
    // ...catch-up drains his inbox and joins the group...
    await waitFor(() => expect(bob.result.current.hs.ready).toBe(true));
    expect(await bobStore.get(`group:${conversationId}`)).not.toBeNull();

    // ...and the previously-undecryptable message flushes to decrypted text.
    await waitFor(() => {
      const m = bob.result.current.msgs.messages.find((x) => x.model.conversationId === conversationId);
      expect(m?.status).toBe("ok");
      expect(m?.content?.body).toBe(PLAINTEXT);
    });

    bob.unmount();
  });

  it("characterizes 'waiting for key update': without useSecureHandshakes, the DM lists but the message stays pending", async () => {
    const PLAINTEXT = "hello bob — but nothing drains my inbox";
    server.addDevice(bobRow); // bob already registered server-side (this test bypasses useSecureDevice)
    const aliceCrypto = new MockSecureChatCrypto();
    await aliceCrypto.generateDeviceIdentity({ deviceId: aliceRow.deviceId });
    const aliceStore = new MemoryStore();
    await seedDevice(aliceStore, aliceRow);
    const conversationId = await aliceStartsDmAndSends(aliceCrypto, aliceStore, PLAINTEXT);

    // Bob mounts WITHOUT draining handshakes (enabled:false) — the load-bearing hook is absent.
    const bobCrypto = new MockSecureChatCrypto();
    const bobStore = new MemoryStore();
    await seedDevice(bobStore, bobRow);
    const bob = renderHook(bobReceiveStack(conversationId, /* withHandshakes */ false), {
      wrapper: wrap(bobCrypto, bobStore, BOB_TOKEN),
    });

    // The conversation is visible (server membership)...
    await waitFor(() =>
      expect(bob.result.current.convs.conversations.map((c) => c.id)).toContain(conversationId)
    );
    // ...and the message is listed...
    await waitFor(() =>
      expect(
        bob.result.current.msgs.messages.find((x) => x.model.conversationId === conversationId)
      ).toBeDefined()
    );
    // ...but it can never decrypt: no group was joined → exactly the "waiting for key update" state.
    const m = bob.result.current.msgs.messages.find((x) => x.model.conversationId === conversationId);
    expect(m?.status).toBe("pending");
    expect(m?.content).toBeNull();
    expect(await bobStore.get(`group:${conversationId}`)).toBeNull();

    bob.unmount();
  });

  it("after bob has joined, a live message from alice decrypts over the socket", async () => {
    const FIRST = "first — delivered via catch-up";
    const SECOND = "second — delivered live over the socket";
    server.addDevice(bobRow); // bob already registered server-side (this test bypasses useSecureDevice)
    const aliceCrypto = new MockSecureChatCrypto();
    await aliceCrypto.generateDeviceIdentity({ deviceId: aliceRow.deviceId });
    const aliceStore = new MemoryStore();
    await seedDevice(aliceStore, aliceRow);
    const conversationId = await aliceStartsDmAndSends(aliceCrypto, aliceStore, FIRST);

    const bobCrypto = new MockSecureChatCrypto();
    const bobStore = new MemoryStore();
    await seedDevice(bobStore, bobRow);
    const bob = renderHook(bobReceiveStack(conversationId, true), {
      wrapper: wrap(bobCrypto, bobStore, BOB_TOKEN),
    });

    // Bob catches up + decrypts the first message.
    await waitFor(() => {
      const m = bob.result.current.msgs.messages.find((x) => x.content?.body === FIRST);
      expect(m?.status).toBe("ok");
    });

    // Alice sends a second message; the server fans it to bob's socket as a live secure:message
    // (server.onBroadcast → emitTo). Bob's useSecureMessages live handler decrypts it in place.
    const aliceGroup = await aliceCrypto.importGroupState((await aliceStore.get(`group:${conversationId}`))!);
    const aliceMsgs = renderHook(
      () => useSecureMessages(conversationId, { group: aliceGroup, senderDeviceId: aliceRow.id }),
      { wrapper: wrap(aliceCrypto, aliceStore, ALICE_TOKEN) }
    );
    await act(async () => {
      await aliceMsgs.result.current.sendMessage(SECOND);
    });
    aliceMsgs.unmount();

    await waitFor(() => {
      const m = bob.result.current.msgs.messages.find((x) => x.content?.body === SECOND);
      expect(m?.status).toBe("ok");
    });

    bob.unmount();
  });

  it("full stack: bob registers via useSecureDevice, then the device→handshakes handoff joins + decrypts", async () => {
    const PLAINTEXT = "hello bob — your device registered, did the inbox follow?";
    const aliceCrypto = new MockSecureChatCrypto();
    await aliceCrypto.generateDeviceIdentity({ deviceId: aliceRow.deviceId });
    const aliceStore = new MemoryStore();
    await seedDevice(aliceStore, aliceRow);

    // Bob mounts the FULL stack with an EMPTY store — no pre-seeded device, no server row yet. His
    // handshake inbox starts with deviceId=undefined, so it cannot drain until registration resolves.
    const bobCrypto = new MockSecureChatCrypto();
    const bobStore = new MemoryStore();
    const bob = renderHook(bobFullStack, {
      wrapper: wrap(bobCrypto, bobStore, BOB_TOKEN),
      initialProps: { convId: "" },
    });

    // App bootstrap: once the persisted-device load settles with no device, register one. This is the
    // device→handshakes handoff under test — useSecureHandshakes only learns its inbox id here.
    await waitFor(() => expect(bob.result.current.dev.loading).toBe(false));
    await act(async () => {
      await bob.result.current.dev.register();
    });
    await waitFor(() => expect(bob.result.current.dev.device).not.toBeNull());
    const bobRowId = bob.result.current.dev.device!.id;
    expect(bobRowId).toMatch(/^bob-row-/); // server-assigned row id (≠ the client deviceId)

    // Now bob exists server-side: alice can claim his KeyPackage and target the Welcome at his row id.
    // createConversation also fans the Welcome live to bob's (already-subscribed) socket.
    const conversationId = await aliceStartsDmAndSends(aliceCrypto, aliceStore, PLAINTEXT);

    // Bob learns the conversation (his list refreshes on the membership signal / next load) and opens it.
    await waitFor(() =>
      expect(bob.result.current.convs.conversations.map((c) => c.id)).toContain(conversationId)
    );
    bob.rerender({ convId: conversationId });

    // The Welcome — delivered to the inbox keyed by bob's just-registered row id — is processed, the
    // group joins, and the message decrypts. No "waiting for key update" despite the late device id.
    await waitFor(() => {
      const m = bob.result.current.msgs.messages.find((x) => x.model.conversationId === conversationId);
      expect(m?.status).toBe("ok");
      expect(m?.content?.body).toBe(PLAINTEXT);
    });
    expect(await bobStore.get(`group:${conversationId}`)).not.toBeNull();

    bob.unmount();
  });
});
