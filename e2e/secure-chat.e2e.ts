// Foundation-validation e2e: the SDK's REAL transport vs a LOCALLY RUNNING agora-server.
//
// Every other test in this repo mocks the transport (`vi.spyOn(SecureChatRestClient.prototype, …)`),
// so until now nothing has proven the client actually speaks the server's wire — endpoints, auth, the
// `/secure` namespace, the handshake `seq`/cursor semantics, and the base64/decimal conventions. This
// suite drives the unmodified `SecureChatRestClient` + `SecureChatSocketClient` against a real server,
// using `MockSecureChatCrypto` for the MLS bits and two simulated devices in one Node process. It is
// the gate before investing in the real MLS core (Task 1).
//
// It is OPT-IN: skipped entirely unless `AGORA_E2E_TEST_DATABASE_URL` is set, so `pnpm test` / CI stay
// server-free. It runs under its own config (vitest.e2e.config.ts, glob `e2e/**/*.e2e.ts`) — never
// the unit glob. Imports reach the transport SOURCE directly (no @agora-sdk/core, no React, no stub)
// — which is also the empirical proof that the transport path loads under plain Node ESM.
//
// What it asserts, end to end: register → publish KeyPackages → start DM → recipient joins via the
// handshake inbox → send → receive+decrypt → the server only ever stored ciphertext → live realtime
// fan-out → a fresh client catches up from the cursor without reprocessing (reload-survives).

import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { SecureChatRestClient } from "../packages/secure-chat/core/src/transport/rest.js";
import { SecureChatSocketClient } from "../packages/secure-chat/core/src/transport/socket.js";
import {
  toBase64,
  fromBase64,
  utf8ToBytes,
  bytesToUtf8,
} from "../packages/secure-chat/core/src/util/base64.js";
import type { SecureChatCrypto } from "../packages/secure-chat/core/src/index.js";
import type { SecureMessageModel } from "../packages/secure-chat/core/src/contract/index.js";
import { readE2EEnv, seedScenario, type Seeded } from "./bootstrap.js";
import { CRYPTO_VARIANTS } from "./crypto-factory.js";

const env = readE2EEnv();

/** Resolve once a socket event arrives, or reject after `ms` (so a wire mismatch fails, not hangs). */
function onceEvent<T>(
  socket: SecureChatSocketClient,
  event: Parameters<SecureChatSocketClient["on"]>[0],
  ms = 5000
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    const off = socket.on(event, ((payload: T) => {
      clearTimeout(timer);
      off();
      resolve(payload);
    }) as never);
  });
}

// `describe.skipIf` keeps the suite inert without the env, so the default test run never touches a
// server. When the env IS present, `env` is non-null for the whole block (asserted via `env!`).
// The whole round-trip runs once per crypto variant: the deterministic mock, then the real ts-mls
// core (genuine MLS blobs through the blind server — the actual proof the foundation supports it).
for (const variant of CRYPTO_VARIANTS) {
describe.skipIf(!env)(`secure-chat foundation [${variant.name}] (real transport vs running agora-server)`, () => {
  let seeded: Seeded;
  let aliceRest: SecureChatRestClient;
  let bobRest: SecureChatRestClient;
  const sockets: SecureChatSocketClient[] = [];

  // One device (one MLS identity + crypto instance) per simulated participant.
  const aliceCrypto = variant.make();
  const bobCrypto = variant.make();
  let aliceRowId: string; // alice's server device-row id (sender id on messages)
  let bobRowId: string; // bob's server device-row id (Welcome target)
  let conversationId: string;
  let aliceGroup: Awaited<ReturnType<SecureChatCrypto["createGroup"]>>["group"];

  const PLAINTEXT_1 = "hello bob — first message";
  const PLAINTEXT_2 = "hello bob — live over the socket";

  beforeAll(async () => {
    seeded = await seedScenario(env!);
    const restFor = (token: string): SecureChatRestClient =>
      new SecureChatRestClient({
        projectId: seeded.projectId,
        getBaseUrl: () => env!.baseUrl,
        getAccessToken: () => token,
      });
    aliceRest = restFor(seeded.alice.token);
    bobRest = restFor(seeded.bob.token);
  });

  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    await seeded?.teardown();
  });

  it("registers both devices and publishes KeyPackages", async () => {
    // alice
    const aliceId = await aliceCrypto.generateDeviceIdentity({ deviceId: "alice-web" });
    const aliceDev = await aliceRest.registerDevice({
      deviceId: aliceId.identity.deviceId,
      signaturePublicKey: toBase64(aliceId.identity.signaturePublicKey),
      credential: toBase64(aliceId.identity.credential),
      ciphersuite: aliceId.identity.ciphersuite,
    });
    aliceRowId = aliceDev.id;
    const aliceKps = await aliceCrypto.generateKeyPackages(5);
    const alicePublished = await aliceRest.publishKeyPackages(aliceRowId, {
      keyPackages: aliceKps.map((k) => ({
        keyPackageRef: k.keyPackageRef,
        keyPackage: toBase64(k.keyPackage),
        ciphersuite: k.ciphersuite,
      })),
    });
    expect(alicePublished).toBe(5);

    // bob
    const bobId = await bobCrypto.generateDeviceIdentity({ deviceId: "bob-web" });
    const bobDev = await bobRest.registerDevice({
      deviceId: bobId.identity.deviceId,
      signaturePublicKey: toBase64(bobId.identity.signaturePublicKey),
      credential: toBase64(bobId.identity.credential),
      ciphersuite: bobId.identity.ciphersuite,
    });
    bobRowId = bobDev.id;
    const bobKps = await bobCrypto.generateKeyPackages(5);
    const bobPublished = await bobRest.publishKeyPackages(bobRowId, {
      keyPackages: bobKps.map((k) => ({
        keyPackageRef: k.keyPackageRef,
        keyPackage: toBase64(k.keyPackage),
        ciphersuite: k.ciphersuite,
      })),
    });
    expect(bobPublished).toBe(5);
  });

  it("starts a DM (alice claims bob's KeyPackage, creates the group, relays the Welcome)", async () => {
    const bobDevices = await aliceRest.listDevices(seeded.bob.id);
    expect(bobDevices.map((d) => d.id)).toContain(bobRowId);

    const claim = await aliceRest.claimKeyPackage(bobRowId);
    // `deviceId` here is the SERVER device-row id, so the Welcome's targetDeviceId routes to bob's
    // device room — exactly what useSecureConversations does.
    const { group, welcomes } = await aliceCrypto.createGroup({
      initialMembers: [{ deviceId: bobRowId, keyPackage: fromBase64(claim.keyPackage) }],
    });
    aliceGroup = group;

    const conversation = await aliceRest.createConversation({
      type: "dm",
      mlsGroupId: toBase64(group.mlsGroupId),
      memberUserIds: [seeded.bob.id],
      welcomes: welcomes.map((w) => ({
        targetDeviceId: w.targetDeviceId,
        payload: toBase64(w.payload),
        epoch: group.epoch.toString(),
      })),
    });
    conversationId = conversation.id;
    expect(conversation.type).toBe("dm");
  });

  it("delivers the Welcome to bob via the handshake inbox; bob joins the group", async () => {
    const inbox = await bobRest.fetchHandshakes(bobRowId);
    const welcome = inbox.handshakes.find(
      (h) => h.kind === "welcome" && h.conversationId === conversationId
    );
    expect(welcome, "bob should have a Welcome handshake for the DM").toBeDefined();
    expect(welcome!.targetDeviceId).toBe(bobRowId);

    const bobGroup = await bobCrypto.processWelcome(fromBase64(welcome!.payload));
    // Both sides now hold the same MLS group id (the mock carries the secret inside the Welcome).
    expect(toBase64(bobGroup.mlsGroupId)).toBe(toBase64(aliceGroup.mlsGroupId));
  });

  it("sends a message alice → bob; bob lists + decrypts it", async () => {
    const { ciphertext, epoch } = await aliceCrypto.encryptMessage(
      aliceGroup,
      utf8ToBytes(PLAINTEXT_1)
    );
    const sent = await aliceRest.sendMessage(conversationId, {
      ciphertext: toBase64(ciphertext),
      epoch: epoch.toString(),
      senderDeviceId: aliceRowId,
    });
    expect(sent.conversationId).toBe(conversationId);

    const page = await bobRest.listMessages(conversationId);
    const row = page.messages.find((m) => m.id === sent.id);
    expect(row, "bob should see the sent message").toBeDefined();

    // bobCrypto already holds this group (it processed the Welcome in the prior test, same instance),
    // so a handle carrying the right mlsGroupId is all decrypt needs.
    const decrypted = await bobCrypto.decryptMessage(bobGroupHandle(), fromBase64(row!.ciphertext));
    expect(bytesToUtf8(decrypted.plaintext)).toBe(PLAINTEXT_1);
  });

  it("stored only ciphertext — the server never saw the plaintext", async () => {
    const page = await bobRest.listMessages(conversationId);
    expect(page.messages.length).toBeGreaterThan(0);
    const needle = utf8ToBytes(PLAINTEXT_1);
    for (const m of page.messages) {
      expect(containsSubsequence(fromBase64(m.ciphertext), needle)).toBe(false);
    }
  });

  it("fans out a live message to bob over the /secure socket", async () => {
    const bobSocket = new SecureChatSocketClient({
      projectId: seeded.projectId,
      getSocketUrl: () => env!.socketUrl,
      getAccessToken: () => seeded.bob.token,
    });
    sockets.push(bobSocket);
    bobSocket.connect();
    bobSocket.joinConversation(conversationId);
    // Let the server process the room join before alice sends (membership is checked on join).
    await new Promise((r) => setTimeout(r, 600));

    const received = onceEvent<SecureMessageModel>(bobSocket, "secure:message");
    const { ciphertext, epoch } = await aliceCrypto.encryptMessage(
      aliceGroup,
      utf8ToBytes(PLAINTEXT_2)
    );
    const sent = await aliceRest.sendMessage(conversationId, {
      ciphertext: toBase64(ciphertext),
      epoch: epoch.toString(),
      senderDeviceId: aliceRowId,
    });

    const evt = await received;
    expect(evt.id).toBe(sent.id);
    const decrypted = await bobCrypto.decryptMessage(bobGroupHandle(), fromBase64(evt.ciphertext));
    expect(bytesToUtf8(decrypted.plaintext)).toBe(PLAINTEXT_2);
  });

  it("restore-on-new-browser: bob backs up, a fresh client restores from the server blob and decrypts new history", async () => {
    const passphrase = "correct horse battery staple";

    // bob seals ALL local key material (identity + every group's state) and uploads the opaque blob.
    const backup = await bobCrypto.exportBackup(passphrase);
    await bobRest.uploadKeyBackup({
      blob: toBase64(backup.blob),
      nonce: toBase64(backup.nonce),
      kdf: backup.kdf as "argon2id" | "pbkdf2",
      kdfParams: backup.kdfParams,
      cipher: backup.cipher as "xchacha20poly1305" | "aes-256-gcm",
      version: backup.version,
    });

    const stored = await bobRest.getKeyBackup();
    expect(stored, "the server should return bob's backup").toBeTruthy();
    // server-blindness: the stored blob is opaque — it must not contain the passphrase in the clear.
    expect(containsSubsequence(fromBase64(stored!.blob), utf8ToBytes(passphrase))).toBe(false);

    // A brand-new client (evicted device / new browser) restores from the server backup ALONE.
    const bob2 = variant.make();
    await bob2.importBackup(passphrase, {
      blob: fromBase64(stored!.blob),
      nonce: fromBase64(stored!.nonce),
      kdf: stored!.kdf,
      kdfParams: stored!.kdfParams,
      cipher: stored!.cipher,
      version: stored!.version,
    });

    // alice sends fresh history; the restored bob decrypts it with the rehydrated group state.
    const PLAINTEXT_3 = "hello restored bob — sent after the backup";
    const { ciphertext, epoch } = await aliceCrypto.encryptMessage(aliceGroup, utf8ToBytes(PLAINTEXT_3));
    const sent = await aliceRest.sendMessage(conversationId, {
      ciphertext: toBase64(ciphertext),
      epoch: epoch.toString(),
      senderDeviceId: aliceRowId,
    });

    const page = await bobRest.listMessages(conversationId);
    const restoredRow = page.messages.find((m) => m.id === sent.id);
    expect(restoredRow, "the restored client should see the new message").toBeDefined();
    const decrypted = await bob2.decryptMessage(bobGroupHandle(), fromBase64(restoredRow!.ciphertext));
    expect(bytesToUtf8(decrypted.plaintext)).toBe(PLAINTEXT_3);
  }, 30_000); // argon2id at the conservative profile is deliberately slow

  it("a fresh client catches up from the cursor without reprocessing (reload-survives)", async () => {
    // Drain bob's whole inbox once, recording the last seq processed.
    const full = await bobRest.fetchHandshakes(bobRowId);
    expect(full.handshakes.length).toBeGreaterThan(0);
    const lastSeq = full.handshakes[full.handshakes.length - 1]!.seq;

    // A brand-new REST client (a "reloaded" bob) asking only for rows AFTER the cursor gets nothing
    // new — proving durable, cursor-based catch-up is idempotent across a restart.
    const reloadedBob = new SecureChatRestClient({
      projectId: seeded.projectId,
      getBaseUrl: () => env!.baseUrl,
      getAccessToken: () => seeded.bob.token,
    });
    const after = await reloadedBob.fetchHandshakes(bobRowId, { since: lastSeq });
    expect(after.handshakes).toHaveLength(0);
    expect(after.hasMore).toBe(false);
  });

  // bob's group handle is established in the Welcome-join test; this returns the live handle the mock
  // already holds (its group map is keyed by id, so any handle with the right mlsGroupId works).
  function bobGroupHandle() {
    return { mlsGroupId: aliceGroup.mlsGroupId, epoch: aliceGroup.epoch };
  }
});
}

/** True if `needle` appears as a contiguous byte run inside `haystack` (server-blindness check). */
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
