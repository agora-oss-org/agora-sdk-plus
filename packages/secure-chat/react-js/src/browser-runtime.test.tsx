// @vitest-environment jsdom
//
// The last rung of the fault-isolation ladder (see ../../../../TESTING.md): the REAL browser runtime.
//
// Every other harness leaves out something the browser does. The hook tests in core run the real hooks
// but with MemoryStore and NO StrictMode; the e2e/chat-diag run real ts-mls but no React at all. This
// file combines the three things only a browser does at once, using this package's ACTUAL web wiring:
//
//   • `createWebSecureChatCrypto()`  — the real ts-mls MLS core,
//   • `createIndexedDBStore()`       — the real durable store (over `fake-indexeddb`), with real async
//                                      transaction latency (MemoryStore resolves on the next microtask),
//   • `<React.StrictMode>`           — dev double-invokes every effect: mount → cleanup → mount.
//
// StrictMode is the sharp edge. `useSecureHandshakes` gives each effect run its own `cursorRef` and
// dispatches a Welcome (processWelcome + rememberGroup) regardless of its `alive` flag, so a double
// mount can race two catch-up loops over the same Welcome. With the mock that's harmless (idempotent);
// with real ts-mls a Welcome's KeyPackage private key is single-use, so a double-process is a genuine
// hazard. This test exists to prove the SDK survives it (or to surface it if it doesn't).
//
// If this passes, the SDK is exhausted — the "waiting for key update" bug then lives in the consuming
// app's own provider/hook wiring, not here.

import "fake-indexeddb/auto";
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { MockSecureChatCrypto } from "@agora-sdk/secure-chat-crypto/testing";
import { createWebSecureChatCrypto } from "./crypto-web.js";
import { createIndexedDBStore } from "./indexeddb-store.js";
import { SecureChatProvider } from "../../core/src/context/secure-chat-context.js";
import { useSecureDevice } from "../../core/src/hooks/useSecureDevice.js";
import { useSecureHandshakes } from "../../core/src/hooks/useSecureHandshakes.js";
import { useSecureConversations } from "../../core/src/hooks/useSecureConversations.js";
import { useSecureMessages } from "../../core/src/hooks/useSecureMessages.js";
import { MemoryStore } from "../../core/src/persistence/memory-store.js";
import { SecureChatRepository } from "../../core/src/persistence/repository.js";
import type { SecureChatStore } from "../../core/src/persistence/store.js";
import { SecureChatRestClient } from "../../core/src/transport/rest.js";
import { SecureChatSocketClient } from "../../core/src/transport/socket.js";
import { toBase64 } from "../../core/src/util/base64.js";
import type {
  CreateSecureConversationBody,
  PublishKeyPackagesBody,
  SecureConversationModel,
  SecureDeviceModel,
  SecureHandshakeModel,
  SecureKeyPackageClaim,
  SecureMessageModel,
  SendSecureMessageBody,
} from "../../core/src/contract/index.js";

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

// ── KeyPackage-faithful fake DS (real KeyPackages flow, so real ts-mls works) ──
class FakeServer {
  private seq = 0;
  private clock = 1;
  private convCount = 0;
  private readonly devicesByUser = new Map<string, SecureDeviceModel[]>();
  private readonly deviceById = new Map<string, SecureDeviceModel>();
  private readonly keyPackagesByDevice = new Map<string, string[]>();
  private readonly members = new Map<string, Set<string>>();
  private readonly conversations = new Map<string, SecureConversationModel>();
  private readonly handshakes: SecureHandshakeModel[] = [];
  private readonly messages = new Map<string, SecureMessageModel[]>();
  onBroadcast: ((row: SecureMessageModel, recipientUserIds: string[]) => void) | null = null;
  onWelcome: ((row: SecureHandshakeModel, recipientUserId: string) => void) | null = null;
  onMemberJoined: ((recipientUserIds: string[]) => void) | null = null;

  private ts(): string { return new Date(this.clock++ * 1000).toISOString(); }

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
  listDevices(userId: string): SecureDeviceModel[] { return [...(this.devicesByUser.get(userId) ?? [])]; }
  publishKeyPackages(deviceId: string, body: PublishKeyPackagesBody): number {
    const list = this.keyPackagesByDevice.get(deviceId) ?? [];
    for (const kp of body.keyPackages) list.push(kp.keyPackage);
    this.keyPackagesByDevice.set(deviceId, list);
    return body.keyPackages.length;
  }
  keyPackageCount(deviceId: string): number { return (this.keyPackagesByDevice.get(deviceId) ?? []).length; }
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
      currentEpoch: "1", name: null, createdById: creatorUserId, lastMessageAt: null, createdAt: now, updatedAt: now,
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
      id: `m-${++this.seq}`, projectId: "p", conversationId, senderUserId: callerUserId,
      senderDeviceId: body.senderDeviceId, epoch: body.epoch, ciphertext: body.ciphertext,
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
let dbCounter = 0;
let fetchHandshakesSpy: ReturnType<typeof vi.spyOn>;

function callerToken(self: unknown): string {
  return (self as { config: { getAccessToken: () => string } }).config.getAccessToken();
}
function callerUser(self: unknown): string { return TOKEN_USER[callerToken(self)]!; }
function emitTo(token: string, event: string, payload: unknown): void {
  socketHandlers.get(token)?.[event]?.forEach((h) => h(payload as never));
}

beforeEach(() => {
  server = new FakeServer();
  server.addDevice(aliceRow);
  socketHandlers = new Map();
  server.onBroadcast = (row, recipients) => {
    for (const u of recipients) emitTo(USER_TOKEN[u]!, "secure:message", row);
  };
  server.onWelcome = (row, recipientUserId) => emitTo(USER_TOKEN[recipientUserId]!, "secure:welcome", row);
  server.onMemberJoined = (recipients) => {
    for (const u of recipients) emitTo(USER_TOKEN[u]!, "secure:member:joined", {});
  };

  vi.spyOn(SecureChatRestClient.prototype, "listDevices").mockImplementation(async function (this: unknown, userId: string) { return server.listDevices(userId); } as never);
  vi.spyOn(SecureChatRestClient.prototype, "registerDevice").mockImplementation(async function (this: unknown, body: { deviceId: string }) { return server.registerDevice(callerUser(this), body.deviceId); } as never);
  vi.spyOn(SecureChatRestClient.prototype, "publishKeyPackages").mockImplementation(async function (this: unknown, deviceId: string, body: PublishKeyPackagesBody) { return server.publishKeyPackages(deviceId, body); } as never);
  vi.spyOn(SecureChatRestClient.prototype, "keyPackageCount").mockImplementation(async function (this: unknown, deviceId: string) { return server.keyPackageCount(deviceId); } as never);
  vi.spyOn(SecureChatRestClient.prototype, "deviceExists").mockResolvedValue(true);
  vi.spyOn(SecureChatRestClient.prototype, "claimKeyPackage").mockImplementation(async function (this: unknown, deviceId: string) { return server.claim(deviceId); } as never);
  vi.spyOn(SecureChatRestClient.prototype, "createConversation").mockImplementation(async function (this: unknown, body: CreateSecureConversationBody) { return server.createConversation(callerUser(this), body); } as never);
  vi.spyOn(SecureChatRestClient.prototype, "listConversations").mockImplementation(async function (this: unknown) { return server.listConversations(callerUser(this)); } as never);
  fetchHandshakesSpy = vi.spyOn(SecureChatRestClient.prototype, "fetchHandshakes").mockImplementation(async function (this: unknown, deviceId: string, params?: { since?: string }) { return server.fetchHandshakes(deviceId, params?.since); } as never);
  vi.spyOn(SecureChatRestClient.prototype, "sendMessage").mockImplementation(async function (this: unknown, conversationId: string, body: SendSecureMessageBody) { return server.sendMessage(callerUser(this), conversationId, body); } as never);
  vi.spyOn(SecureChatRestClient.prototype, "listMessages").mockImplementation(async function (this: unknown, conversationId: string) { return server.listMessages(conversationId); } as never);

  vi.spyOn(SecureChatSocketClient.prototype, "on").mockImplementation(function (this: unknown, event: string, handler: (p: never) => void) {
    const token = callerToken(this);
    const reg = socketHandlers.get(token) ?? {};
    (reg[event] ??= []).push(handler);
    socketHandlers.set(token, reg);
    return () => { const list = reg[event]; if (list) reg[event] = list.filter((h) => h !== handler); };
  } as never);
  vi.spyOn(SecureChatSocketClient.prototype, "joinConversation").mockReturnValue(undefined);
  vi.spyOn(SecureChatSocketClient.prototype, "disconnect").mockReturnValue(undefined);
  vi.spyOn(SecureChatSocketClient.prototype, "connect").mockReturnValue({
    emit: () => undefined, on: () => undefined, disconnect: () => undefined,
  } as never);
});
afterEach(() => vi.restoreAllMocks());

/** A fresh IndexedDB-backed store on a unique db (so tests don't share persisted state). */
function freshIdbStore(): SecureChatStore {
  return createIndexedDBStore({ dbName: `browser-runtime-${++dbCounter}` });
}

/** Bob's provider wrapped in StrictMode — the dev double-invoke the browser applies. */
function strictWrap(crypto: ReturnType<typeof createWebSecureChatCrypto>, store: SecureChatStore, token: string) {
  return ({ children }: { children: React.ReactNode }) => (
    <React.StrictMode>
      <SecureChatProvider crypto={crypto} projectId="p" baseUrl="http://localhost:4000/v7" store={store} accessToken={token}>
        {children}
      </SecureChatProvider>
    </React.StrictMode>
  );
}

/** Alice's provider (no StrictMode needed; she's the initiator, driven imperatively). */
function plainWrap(crypto: MockSecureChatCrypto | ReturnType<typeof createWebSecureChatCrypto>, store: SecureChatStore, token: string) {
  return ({ children }: { children: React.ReactNode }) => (
    <SecureChatProvider crypto={crypto} projectId="p" baseUrl="http://localhost:4000/v7" store={store} accessToken={token}>
      {children}
    </SecureChatProvider>
  );
}

async function seedDevice(store: SecureChatStore, row: SecureDeviceModel, deviceState: Uint8Array): Promise<void> {
  await new SecureChatRepository(store).saveDevice({ deviceId: row.deviceId, deviceState, device: row });
}

/** Alice starts the DM and sends `text`, all through her hooks; returns the shared conversation id. */
async function aliceStartsDmAndSends(
  aliceCrypto: ReturnType<typeof createWebSecureChatCrypto>,
  aliceStore: SecureChatStore,
  text: string
): Promise<string> {
  const aliceWrap = plainWrap(aliceCrypto, aliceStore, ALICE_TOKEN);
  const convs = renderHook(() => useSecureConversations(), { wrapper: aliceWrap });
  let conversationId = "";
  await act(async () => {
    conversationId = (await convs.result.current.createDirectConversation("bob")).id;
  });
  convs.unmount();

  const aliceGroup = await aliceCrypto.importGroupState((await aliceStore.get(`group:${conversationId}`))!);
  const msgs = renderHook(
    () => useSecureMessages(conversationId, { group: aliceGroup, senderDeviceId: aliceRow.id }),
    { wrapper: aliceWrap }
  );
  await act(async () => { await msgs.result.current.sendMessage(text); });
  msgs.unmount();
  return conversationId;
}

function bobFullStack({ convId }: { convId: string }) {
  const dev = useSecureDevice({ autoReplenish: false });
  const hs = useSecureHandshakes({ deviceId: dev.device?.id });
  const convs = useSecureConversations();
  const msgs = useSecureMessages(convId);
  return { dev, hs, convs, msgs };
}

describe("browser runtime: StrictMode + IndexedDB + real ts-mls under the hooks", () => {
  it("sanity: the StrictMode wrapper genuinely double-invokes mount effects in this harness", () => {
    // Guards against a hollow test — if React's dev double-invoke weren't active, the runtime cases
    // below would prove nothing about StrictMode. A bare mount effect must fire twice (mount→cleanup→
    // mount) under <React.StrictMode>.
    let mounts = 0;
    const store = new MemoryStore();
    const crypto = new MockSecureChatCrypto();
    renderHook(
      () => {
        React.useEffect(() => {
          mounts += 1;
        }, []);
      },
      { wrapper: strictWrap(crypto as never, store, BOB_TOKEN) }
    );
    expect(mounts).toBe(2);
  });

  it("bob (StrictMode double-mount, IndexedDB, ts-mls) registers, joins, and decrypts a real message", async () => {
    const PLAINTEXT = "hello bob — StrictMode + IndexedDB + real MLS 💜";

    const aliceCrypto = createWebSecureChatCrypto();
    await aliceCrypto.generateDeviceIdentity({ deviceId: aliceRow.deviceId });
    const aliceStore = new MemoryStore();
    await seedDevice(aliceStore, aliceRow, await aliceCrypto.exportDeviceState());

    const bobCrypto = createWebSecureChatCrypto();
    const processWelcomeSpy = vi.spyOn(bobCrypto, "processWelcome");
    const bobStore = freshIdbStore();
    const bob = renderHook(bobFullStack, {
      wrapper: strictWrap(bobCrypto, bobStore, BOB_TOKEN),
      initialProps: { convId: "" },
    });

    await waitFor(() => expect(bob.result.current.dev.loading).toBe(false), WAIT);
    await act(async () => { await bob.result.current.dev.register(); });
    await waitFor(() => expect(bob.result.current.dev.device).not.toBeNull(), WAIT);
    await act(async () => { await bob.result.current.dev.publishKeyPackages(3); });

    const conversationId = await aliceStartsDmAndSends(aliceCrypto, aliceStore, PLAINTEXT);

    await waitFor(
      () => expect(bob.result.current.convs.conversations.map((c) => c.id)).toContain(conversationId),
      WAIT
    );
    bob.rerender({ convId: conversationId });

    // The decisive assertion: despite StrictMode double-mounting the handshakes effect and the real
    // single-use ts-mls KeyPackage, bob joins and the message decrypts — no "waiting for key update".
    await waitFor(() => {
      const m = bob.result.current.msgs.messages.find((x) => x.model.conversationId === conversationId);
      expect(m?.status).toBe("ok");
      expect(m?.content?.body).toBe(PLAINTEXT);
    }, WAIT);
    expect(await bobStore.get(`group:${conversationId}`)).not.toBeNull();

    // The Welcome was processed exactly once. Note WHY this is safe under StrictMode's doubled mount:
    // `useSecureHandshakes` gates catch-up on a resolved device id, which is still undefined on the
    // initial (doubled) mount — registration resolves it later, so the real catch-up runs as a single
    // dep-change re-run, NOT a doubled mount effect. The double-process-a-Welcome hazard therefore never
    // coincides with an active catch-up. (A dedicated probe test below proves StrictMode IS doubling.)
    const bobFetches = fetchHandshakesSpy.mock.calls.filter((c: unknown[]) => String(c[0]).startsWith("bob-row")).length;
    expect(processWelcomeSpy.mock.calls.length).toBe(1);
    // eslint-disable-next-line no-console
    console.log(`[browser-runtime] StrictMode → ${bobFetches} bob catch-up fetch(es), processWelcome ×${processWelcomeSpy.mock.calls.length}`);

    bob.unmount();
  }, SLOW);

  it("survives a reload: a second StrictMode mount on the same IndexedDB rehydrates without re-registering", async () => {
    const PLAINTEXT = "hello bob — now reload me";

    const aliceCrypto = createWebSecureChatCrypto();
    await aliceCrypto.generateDeviceIdentity({ deviceId: aliceRow.deviceId });
    const aliceStore = new MemoryStore();
    await seedDevice(aliceStore, aliceRow, await aliceCrypto.exportDeviceState());

    const bobCrypto = createWebSecureChatCrypto();
    const bobStore = freshIdbStore(); // shared across both "page loads"
    const bob1 = renderHook(bobFullStack, {
      wrapper: strictWrap(bobCrypto, bobStore, BOB_TOKEN),
      initialProps: { convId: "" },
    });
    await waitFor(() => expect(bob1.result.current.dev.loading).toBe(false), WAIT);
    await act(async () => { await bob1.result.current.dev.register(); });
    await waitFor(() => expect(bob1.result.current.dev.device).not.toBeNull(), WAIT);
    await act(async () => { await bob1.result.current.dev.publishKeyPackages(3); });
    const bobRowId = bob1.result.current.dev.device!.id;

    const conversationId = await aliceStartsDmAndSends(aliceCrypto, aliceStore, PLAINTEXT);
    await waitFor(
      () => expect(bob1.result.current.convs.conversations.map((c) => c.id)).toContain(conversationId),
      WAIT
    );
    bob1.rerender({ convId: conversationId });
    await waitFor(() => {
      const m = bob1.result.current.msgs.messages.find((x) => x.content?.body ===PLAINTEXT);
      expect(m?.status).toBe("ok");
    }, WAIT);
    bob1.unmount(); // "close the tab"

    // "Reload": a fresh crypto instance + a fresh StrictMode mount over the SAME IndexedDB. The device
    // must rehydrate from persistence (NOT mint a new row), and history must still decrypt.
    const bobCrypto2 = createWebSecureChatCrypto();
    const bob2 = renderHook(bobFullStack, {
      wrapper: strictWrap(bobCrypto2, bobStore, BOB_TOKEN),
      initialProps: { convId: conversationId },
    });
    await waitFor(() => expect(bob2.result.current.dev.device?.id).toBe(bobRowId), WAIT); // same row, no churn
    await waitFor(() => {
      const m = bob2.result.current.msgs.messages.find((x) => x.content?.body ===PLAINTEXT);
      expect(m?.status).toBe("ok");
    }, WAIT);

    bob2.unmount();
  }, SLOW);

  it("resend after Alice reloads is NOT rejected as replay; her own history restores from the store", async () => {
    // THE forward-secrecy bug, end to end (image: B shows "⚠️ couldn't be verified (replay)" after A
    // reloads and sends again). Root cause: an application message advances the SINGLE-USE send ratchet
    // in memory, but the SDK only persisted group state on join/Commit — so a reload re-imported the
    // pre-send state, rewound the send ratchet to a consumed generation, and the next message reused a
    // gen the peer had already seen → ts-mls "Desired gen in the past" → rejected as a replay.
    //
    // The fix persists group state after every send/receive AND decrypts each message once into a local
    // plaintext store. This test proves BOTH: (A) Bob decrypts Alice's post-reload message, and (B)
    // Alice's own history (which she can't re-decrypt — single-use keys) restores from the store without
    // ever re-running the MLS decrypt.
    const M1 = "hi my bad bitch!";
    const M2 = "please work";

    // Bob: full stack on IndexedDB; registers, publishes, will join + receive.
    const bobCrypto = createWebSecureChatCrypto();
    const bobStore = freshIdbStore();
    const bob = renderHook(bobFullStack, {
      wrapper: strictWrap(bobCrypto, bobStore, BOB_TOKEN),
      initialProps: { convId: "" },
    });
    await waitFor(() => expect(bob.result.current.dev.loading).toBe(false), WAIT);
    await act(async () => { await bob.result.current.dev.register(); });
    await waitFor(() => expect(bob.result.current.dev.device).not.toBeNull(), WAIT);
    await act(async () => { await bob.result.current.dev.publishKeyPackages(3); });

    // Alice: on a DURABLE store, so a "reload" re-imports the ratchet as it stood AFTER she sent M1.
    const aliceCrypto = createWebSecureChatCrypto();
    await aliceCrypto.generateDeviceIdentity({ deviceId: aliceRow.deviceId });
    const aliceStore = freshIdbStore();
    await seedDevice(aliceStore, aliceRow, await aliceCrypto.exportDeviceState());

    // Alice starts the DM and sends M1 through her hooks (the send now persists the advanced ratchet).
    const aliceWrap = plainWrap(aliceCrypto, aliceStore, ALICE_TOKEN);
    const convs = renderHook(() => useSecureConversations(), { wrapper: aliceWrap });
    let conversationId = "";
    await act(async () => { conversationId = (await convs.result.current.createDirectConversation("bob")).id; });
    convs.unmount();

    const aliceGroup1 = await aliceCrypto.importGroupState((await aliceStore.get(`group:${conversationId}`))!);
    const msgs1 = renderHook(
      () => useSecureMessages(conversationId, { group: aliceGroup1, senderDeviceId: aliceRow.id }),
      { wrapper: aliceWrap }
    );
    await act(async () => { await msgs1.result.current.sendMessage(M1); });
    msgs1.unmount();

    // Bob joins and decrypts M1.
    await waitFor(() => expect(bob.result.current.convs.conversations.map((c) => c.id)).toContain(conversationId), WAIT);
    bob.rerender({ convId: conversationId });
    await waitFor(() => {
      const m = bob.result.current.msgs.messages.find((x) => x.content?.body ===M1);
      expect(m?.status).toBe("ok");
    }, WAIT);

    // ── Alice "reloads": a FRESH crypto instance over the SAME store. Re-import the persisted group
    // state (which, thanks to the fix, reflects the post-M1 ratchet — NOT the rewound pre-send state). ──
    const aliceCrypto2 = createWebSecureChatCrypto();
    const decryptSpy2 = vi.spyOn(aliceCrypto2, "decryptMessage");
    const aliceGroup2 = await aliceCrypto2.importGroupState((await aliceStore.get(`group:${conversationId}`))!);
    const aliceWrap2 = plainWrap(aliceCrypto2, aliceStore, ALICE_TOKEN);
    const msgs2 = renderHook(
      () => useSecureMessages(conversationId, { group: aliceGroup2, senderDeviceId: aliceRow.id }),
      { wrapper: aliceWrap2 }
    );

    // (B) Alice's own M1 renders `ok` AFTER reload — she can't decrypt her own single-use message, so it
    // can only come from the local plaintext store. Prove the ratchet was never touched for it.
    await waitFor(() => {
      const m = msgs2.result.current.messages.find((x) => x.model.conversationId === conversationId && x.content?.body === M1);
      expect(m?.status).toBe("ok");
    }, WAIT);
    expect(decryptSpy2).not.toHaveBeenCalled(); // served from store, ratchet untouched

    // (A) Alice sends M2 after the reload. Before the fix this reused M1's consumed generation.
    await act(async () => { await msgs2.result.current.sendMessage(M2); });

    // The decisive assertion: Bob decrypts M2 as `ok` — NOT rejected as a replay.
    await waitFor(() => {
      const m = bob.result.current.msgs.messages.find((x) => x.content?.body ===M2);
      expect(m?.status).toBe("ok");
    }, WAIT);
    // And Bob never marked M2 (or anything) as a replay/rejected.
    expect(bob.result.current.msgs.messages.some((m) => m.status === "rejected")).toBe(false);

    msgs2.unmount();
    bob.unmount();
  }, SLOW);

  it("recipient who registered+published, then RELOADED before any DM, still joins a NEW Welcome", async () => {
    // THE reported two-browser bug, end to end. Bob registers + publishes KeyPackages, then reloads
    // BEFORE any DM arrives. A fresh crypto instance must rehydrate those KeyPackages' PRIVATE keys from
    // IndexedDB so it can processWelcome a NEW Welcome alice builds from one of them. Before the
    // persist-on-publish fix, bob2's in-memory `pending` was empty after reload → processWelcome
    // "no matching KeyPackage" → the handshake drain skipped it → stuck on "⏳ waiting for key update"
    // forever across reloads. (The reload test above only re-reads ALREADY-joined history, so the
    // published-but-unused KeyPackage private keys are never exercised — which is why it passed even
    // with the bug present.)
    const PLAINTEXT = "hello bob — you reloaded before I even messaged you";
    const aliceCrypto = createWebSecureChatCrypto();
    await aliceCrypto.generateDeviceIdentity({ deviceId: aliceRow.deviceId });
    const aliceStore = new MemoryStore();
    await seedDevice(aliceStore, aliceRow, await aliceCrypto.exportDeviceState());

    // First load: bob registers + publishes KeyPackages, receives NOTHING, then "closes the tab".
    const bobCrypto1 = createWebSecureChatCrypto();
    const bobStore = freshIdbStore();
    const bob1 = renderHook(bobFullStack, {
      wrapper: strictWrap(bobCrypto1, bobStore, BOB_TOKEN),
      initialProps: { convId: "" },
    });
    await waitFor(() => expect(bob1.result.current.dev.loading).toBe(false), WAIT);
    await act(async () => { await bob1.result.current.dev.register(); });
    await waitFor(() => expect(bob1.result.current.dev.device).not.toBeNull(), WAIT);
    await act(async () => { await bob1.result.current.dev.publishKeyPackages(3); });
    const bobRowId = bob1.result.current.dev.device!.id;
    bob1.unmount(); // reload, BEFORE receiving any Welcome

    // Second load: a FRESH crypto instance over the same IndexedDB, NO re-publish. Now alice starts the
    // DM, so bob2 must process a brand-new Welcome built from a KeyPackage bob1 published last session.
    const bobCrypto2 = createWebSecureChatCrypto();
    const bob2 = renderHook(bobFullStack, {
      wrapper: strictWrap(bobCrypto2, bobStore, BOB_TOKEN),
      initialProps: { convId: "" },
    });
    await waitFor(() => expect(bob2.result.current.dev.device?.id).toBe(bobRowId), WAIT); // rehydrated, no churn

    const conversationId = await aliceStartsDmAndSends(aliceCrypto, aliceStore, PLAINTEXT);
    await waitFor(
      () => expect(bob2.result.current.convs.conversations.map((c) => c.id)).toContain(conversationId),
      WAIT
    );
    bob2.rerender({ convId: conversationId });

    await waitFor(() => {
      const m = bob2.result.current.msgs.messages.find((x) => x.model.conversationId === conversationId);
      expect(m?.status).toBe("ok");
      expect(m?.content?.body).toBe(PLAINTEXT);
    }, WAIT);
    expect(await bobStore.get(`group:${conversationId}`)).not.toBeNull();

    bob2.unmount();
  }, SLOW);
});
