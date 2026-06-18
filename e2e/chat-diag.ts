// Two-process diagnostic harness for Agora secure chat.
//
// Where this sits in the blind-server / client-crypto model: this is a CLIENT. It drives the real
// ts-mls MLS crypto + the real `SecureChatRestClient` against a LOCALLY RUNNING agora-server (the
// blind Delivery Service), exactly as a browser would — but split across TWO OS processes so the
// device-state persistence seam (export on one process, import on a fresh process) is exercised for
// real. That seam is where the browser bug lives: on reload the browser churns its device identity
// instead of rehydrating, so Welcomes end up targeting a device it no longer is. Here the initiator
// EXPORTS bob's device state to disk and the responder IMPORTS it into a fresh crypto instance — a
// faithful, observable stand-in for "reload, don't re-register".
//
// It is a diagnostic, not a test: every step logs its REST path, the base64/epoch wire shapes it
// emits, and the `deviceId` (client text) vs `device.id` (server row uuid) footgun. A `step()` helper
// HARD-EXITS on the first failure so one error can never cascade into a misleading second one.
//
// Security: this is E2EE client code. It logs only ciphertext summaries, public ids, and the single
// diagnostic plaintext it itself authored — never group secrets, private keys, or `privateState`.
//
// Usage (same env vars as the e2e — see e2e/bootstrap.ts):
//   pnpm chat-diag -- --role initiator   # seeds, registers both devices, creates DM, sends
//   pnpm chat-diag -- --role responder   # imports bob's state, drains handshakes, decrypts
//
// State is handed between the two processes via ~/.agora-chat-diag/session.json.

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { createTsMlsSecureChatCrypto } from "../packages/secure-chat/crypto/src/ts-mls/index.js";
import { SecureChatRestClient } from "../packages/secure-chat/core/src/transport/rest.js";
import {
  toBase64,
  fromBase64,
  utf8ToBytes,
  bytesToUtf8,
} from "../packages/secure-chat/core/src/util/base64.js";
import { readE2EEnv, seedScenario, type E2EEnv, type Seeded } from "./bootstrap.js";

// ─── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const roleIdx = args.indexOf("--role");
const role = roleIdx !== -1 ? args[roleIdx + 1] : null;

if (!role || !["initiator", "responder"].includes(role)) {
  console.error("Usage: pnpm chat-diag -- --role initiator|responder");
  process.exit(1);
}

// ─── Session (the cross-process persistence seam) ──────────────────────────────

const SESSION_DIR = join(homedir(), ".agora-chat-diag");
const SESSION_FILE = join(SESSION_DIR, "session.json");

/** Everything the responder process needs to pick up where the initiator left off. */
interface DiagSession {
  projectId: string;
  aliceUserId: string;
  aliceToken: string;
  /** alice's SERVER device-row uuid (the message `senderDeviceId`) — NOT her client `deviceId`. */
  aliceServerRowId: string;
  bobUserId: string;
  bobToken: string;
  /** bob's SERVER device-row uuid (the Welcome `targetDeviceId`) — NOT his client `deviceId`. */
  bobServerRowId: string;
  conversationId: string;
  /** base64 of `bobCrypto.exportDeviceState()` — re-imported by the responder to simulate a reload. */
  bobExportedDeviceState: string;
  /** carried so the responder can run teardown without re-reading the env. */
  databaseUrl: string;
}

async function writeSession(session: DiagSession): Promise<void> {
  await mkdir(SESSION_DIR, { recursive: true });
  await writeFile(SESSION_FILE, JSON.stringify(session, null, 2), "utf-8");
}

async function readSession(): Promise<DiagSession> {
  try {
    const raw = await readFile(SESSION_FILE, "utf-8");
    return JSON.parse(raw) as DiagSession;
  } catch {
    console.error(`✗ No session found at ${SESSION_FILE}`);
    console.error(`  Run the initiator first: pnpm chat-diag -- --role initiator`);
    process.exit(1);
  }
}

// ─── Logging ─────────────────────────────────────────────────────────────────

function arrow(msg: string): void {
  console.log(`  → ${msg}`);
}
function check(msg: string): void {
  console.log(`  ✓ ${msg}`);
}

/** A short, non-sensitive summary of a base64 blob: first 8 chars + decoded byte size. */
function b64summary(b64: string, label = "blob"): string {
  const bytes = Math.round((b64.length * 3) / 4);
  return `${label}=${b64.slice(0, 8)}... (${bytes}B)`;
}

// ─── Step runner ─────────────────────────────────────────────────────────────

let _step = 0;
let _total = 0;

/**
 * Run one labelled step. Logs `[N/M] label...`, runs `fn`, and on ANY throw prints the error (plus a
 * short stack) and HARD-EXITS the process. The hard stop is the whole point: it makes the FIRST
 * failure the last line of output, so a root cause is never buried under cascading secondary errors.
 */
async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  _step++;
  console.log(`\n[${_step}/${_total}] ${label}...`);
  try {
    return await fn();
  } catch (err) {
    console.error(`  ✗ FAILED`);
    console.error(`  ${String(err)}`);
    if (err instanceof Error && err.stack) {
      const lines = err.stack.split("\n").slice(1, 5).map((l) => `  ${l}`);
      console.error(lines.join("\n"));
    }
    process.exit(1);
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

// Wrapped in a `main()` (not top-level await) so tsx can run the file under either module format.
async function main(): Promise<void> {
  const env = readE2EEnv();
  if (!env) {
    console.error(
      "✗ AGORA_E2E_DATABASE_URL is not set.\n" +
        "  Set it (and AGORA_E2E_ACCESS_TOKEN_SECRET) to match the running agora-server's .env."
    );
    process.exit(1);
  }

  if (role === "initiator") {
    _total = 8;
    await runInitiator(env);
  } else {
    _total = 5;
    await runResponder();
  }
}

main().catch((err) => {
  // step() already hard-exits on per-step failures; this only catches a setup error before any step.
  console.error(`✗ chat-diag aborted: ${String(err)}`);
  process.exit(1);
});

// ─── Initiator ─────────────────────────────────────────────────────────────────

async function runInitiator(env: E2EEnv): Promise<void> {
  console.log("\n╔══════════════════════════════════════╗");
  console.log("║  chat-diag  —  INITIATOR              ║");
  console.log("╚══════════════════════════════════════╝");

  // Step 1: Seed a throwaway project + alice + bob directly into the server's DB.
  let seeded!: Seeded;
  await step("Seeding users (throwaway project)", async () => {
    seeded = await seedScenario(env);
    check(`project  ${seeded.projectId}`);
    check(`alice    ${seeded.alice.id}`);
    check(`bob      ${seeded.bob.id}`);
    // NOTE: seeded.teardown() is deliberately NOT called — the project must outlive this process so
    // the responder can read it. The responder owns teardown (it can't reuse this process's pool).
  });

  // Two fresh real-MLS instances — one per simulated device. In-memory device/group state lives here.
  const aliceCrypto = createTsMlsSecureChatCrypto();
  const bobCrypto = createTsMlsSecureChatCrypto();

  // One REST client per user (project + bearer token are user-specific).
  const makeRest = (token: string) =>
    new SecureChatRestClient({
      projectId: seeded.projectId,
      getBaseUrl: () => env.baseUrl,
      getAccessToken: () => token,
    });
  const aliceRest = makeRest(seeded.alice.token);
  const bobRest = makeRest(seeded.bob.token);

  // Step 2: Register both devices + publish KeyPackages. `generateDeviceIdentity` is called EXACTLY
  // ONCE per instance here (a second call can mint a different identity), and we use its return value.
  let aliceServerRowId!: string;
  let bobServerRowId!: string;
  await step("Registering devices + publishing KeyPackages", async () => {
    // alice
    const aliceId = await aliceCrypto.generateDeviceIdentity({ deviceId: "alice-web" });
    arrow("POST /secure-chat/devices (alice)");
    const aliceRow = await aliceRest.registerDevice({
      deviceId: aliceId.identity.deviceId,
      signaturePublicKey: toBase64(aliceId.identity.signaturePublicKey),
      credential: toBase64(aliceId.identity.credential),
      ciphersuite: aliceId.identity.ciphersuite,
    });
    aliceServerRowId = aliceRow.id;
    check(`alice serverRowId=${aliceServerRowId}  ⚠  this UUID ≠ deviceId "alice-web" — Welcomes/messages use this`);

    // bob
    const bobId = await bobCrypto.generateDeviceIdentity({ deviceId: "bob-web" });
    arrow("POST /secure-chat/devices (bob)");
    const bobRow = await bobRest.registerDevice({
      deviceId: bobId.identity.deviceId,
      signaturePublicKey: toBase64(bobId.identity.signaturePublicKey),
      credential: toBase64(bobId.identity.credential),
      ciphersuite: bobId.identity.ciphersuite,
    });
    bobServerRowId = bobRow.id;
    check(`bob   serverRowId=${bobServerRowId}  ⚠  this UUID ≠ deviceId "bob-web"`);

    // alice's KeyPackages
    const aliceKps = await aliceCrypto.generateKeyPackages(10);
    arrow(`POST /secure-chat/devices/${aliceServerRowId}/key-packages (alice, 10)`);
    const alicePublished = await aliceRest.publishKeyPackages(aliceServerRowId, {
      keyPackages: aliceKps.map((k) => ({
        keyPackageRef: k.keyPackageRef,
        keyPackage: toBase64(k.keyPackage),
        ciphersuite: k.ciphersuite,
      })),
    });
    check(`alice  ${alicePublished} KPs published`);

    // bob's KeyPackages — these are what alice will claim to add bob to the group.
    const bobKps = await bobCrypto.generateKeyPackages(10);
    arrow(`POST /secure-chat/devices/${bobServerRowId}/key-packages (bob, 10)`);
    const bobPublished = await bobRest.publishKeyPackages(bobServerRowId, {
      keyPackages: bobKps.map((k) => ({
        keyPackageRef: k.keyPackageRef,
        keyPackage: toBase64(k.keyPackage),
        ciphersuite: k.ciphersuite,
      })),
    });
    check(`bob    ${bobPublished} KPs published`);
  });

  // Step 3: List bob's devices from alice's view (the discovery the initiator does before a DM).
  await step("Listing bob's devices (alice's view)", async () => {
    arrow(`GET /secure-chat/devices?userId=${seeded.bob.id}`);
    const devices = await aliceRest.listDevices(seeded.bob.id);
    const bobDevice = devices.find((d) => d.id === bobServerRowId);
    if (!bobDevice) {
      throw new Error(
        `bob's device ${bobServerRowId} not in the device list. Found: ` +
          `${devices.map((d) => d.id).join(", ") || "(none)"}`
      );
    }
    check(`1 device found: serverRowId=${bobDevice.id}`);
  });

  // Step 4: Claim one of bob's KeyPackages (single-use; consumed server-side) to add him to the group.
  let claimedKeyPackage!: string; // base64
  await step("Claiming bob's KeyPackage", async () => {
    arrow(`POST /secure-chat/devices/${bobServerRowId}/key-packages/claim`);
    const claim = await aliceRest.claimKeyPackage(bobServerRowId);
    claimedKeyPackage = claim.keyPackage; // already base64
    check(b64summary(claimedKeyPackage, "keyPackage"));
  });

  // Step 5: Create the MLS group locally; the Welcome is the secret bob needs to join.
  let aliceGroup!: Awaited<ReturnType<typeof aliceCrypto.createGroup>>["group"];
  let welcomes!: Awaited<ReturnType<typeof aliceCrypto.createGroup>>["welcomes"];
  await step("Creating MLS group + generating Welcome", async () => {
    // The member `deviceId` is bob's SERVER row uuid: the Welcome's targetDeviceId must route to his
    // device room. (This is the footgun — using the client "bob-web" here would misroute the Welcome.)
    const result = await aliceCrypto.createGroup({
      initialMembers: [{ deviceId: bobServerRowId, keyPackage: fromBase64(claimedKeyPackage) }],
    });
    aliceGroup = result.group;
    welcomes = result.welcomes;
    check(`mlsGroupId=${toBase64(aliceGroup.mlsGroupId).slice(0, 12)}...  epoch=${aliceGroup.epoch}`);
    check(`${welcomes.length} Welcome(s) generated`);
    for (const w of welcomes) {
      check(`  target=${w.targetDeviceId}  ${b64summary(toBase64(w.payload), "payload")}`);
    }
  });

  // Step 6: Register the conversation on the blind DS, relaying the Welcome for the server to deliver.
  let conversationId!: string;
  await step("Creating conversation + relaying Welcome", async () => {
    arrow(`POST /secure-chat/conversations`);
    const conv = await aliceRest.createConversation({
      type: "dm",
      mlsGroupId: toBase64(aliceGroup.mlsGroupId),
      memberUserIds: [seeded.bob.id],
      welcomes: welcomes.map((w) => ({
        targetDeviceId: w.targetDeviceId,
        payload: toBase64(w.payload),
        epoch: aliceGroup.epoch.toString(),
      })),
    });
    conversationId = conv.id;
    check(`conversationId=${conversationId}  type=${conv.type}`);
  });

  // Step 7: Encrypt + send the one diagnostic message. The server only ever sees this ciphertext.
  const PLAINTEXT = "hello bob, can you read this? — chat-diag diagnostic run";
  await step("Encrypting + sending message", async () => {
    const { ciphertext, epoch } = await aliceCrypto.encryptMessage(aliceGroup, utf8ToBytes(PLAINTEXT));
    const ct64 = toBase64(ciphertext);
    check(`plaintext : "${PLAINTEXT}"`);
    check(b64summary(ct64, "ciphertext") + `  epoch=${epoch}`);
    arrow(`POST /secure-chat/conversations/${conversationId}/messages`);
    const sent = await aliceRest.sendMessage(conversationId, {
      ciphertext: ct64,
      epoch: epoch.toString(),
      senderDeviceId: aliceServerRowId,
    });
    check(`messageId=${sent.id}`);
  });

  // Step 8: Export bob's device state and persist the whole session for the responder process.
  await step("Exporting bob's device state + saving session", async () => {
    const bobStateBytes = await bobCrypto.exportDeviceState();
    const bobExportedDeviceState = toBase64(bobStateBytes);
    const session: DiagSession = {
      projectId: seeded.projectId,
      aliceUserId: seeded.alice.id,
      aliceToken: seeded.alice.token,
      aliceServerRowId,
      bobUserId: seeded.bob.id,
      bobToken: seeded.bob.token,
      bobServerRowId,
      conversationId,
      bobExportedDeviceState,
      databaseUrl: env.databaseUrl,
    };
    await writeSession(session);
    check(SESSION_FILE);
    check(b64summary(bobExportedDeviceState, "bob.exportedDeviceState"));
    check(`conversationId=${conversationId}`);
  });

  console.log("\nINITIATOR DONE ✓");
  console.log(`Run: pnpm chat-diag -- --role responder\n`);
}

// ─── Responder ───────────────────────────────────────────────────────────────

async function runResponder(): Promise<void> {
  console.log("\n╔══════════════════════════════════════╗");
  console.log("║  chat-diag  —  RESPONDER              ║");
  console.log("╚══════════════════════════════════════╝");

  // Step 1: Load the session the initiator wrote.
  let session!: DiagSession;
  await step("Loading session", async () => {
    session = await readSession();
    check(`project=${session.projectId}`);
    check(`conversationId=${session.conversationId}`);
    check(b64summary(session.bobExportedDeviceState, "bob.deviceState"));
  });

  // Step 2: Import bob's device state into a FRESH crypto instance — the reload seam. We do NOT call
  // registerDevice: the whole point is rehydrating the SAME identity, not minting a new one (the
  // browser's churn bug is exactly the failure to do this).
  const bobCrypto = createTsMlsSecureChatCrypto();
  await step("Importing bob's device state (simulating reload)", async () => {
    await bobCrypto.importDeviceState(fromBase64(session.bobExportedDeviceState));
    check(`deviceId=bob-web  serverRowId=${session.bobServerRowId}`);
    check(`using saved device state — skipping registerDevice (no churn)`);
  });

  const bobRest = new SecureChatRestClient({
    projectId: session.projectId,
    getBaseUrl: () => process.env.AGORA_E2E_BASE_URL ?? "http://localhost:4000/v7",
    getAccessToken: () => session.bobToken,
  });

  // Step 3: Drain the handshake inbox — the durable, authenticated catch-up path (REST, not realtime).
  let welcomePayload!: Uint8Array;
  await step("Draining handshakes from server", async () => {
    arrow(`GET /secure-chat/devices/${session.bobServerRowId}/handshakes`);
    const inbox = await bobRest.fetchHandshakes(session.bobServerRowId);
    check(`${inbox.handshakes.length} handshake(s) received  hasMore=${inbox.hasMore}`);
    for (const h of inbox.handshakes) {
      check(`  seq=${h.seq}  kind=${h.kind}  conversationId=${h.conversationId}  ${b64summary(h.payload, "payload")}`);
    }
    const welcome = inbox.handshakes.find(
      (h) => h.kind === "welcome" && h.conversationId === session.conversationId
    );
    if (!welcome) {
      throw new Error(
        `No welcome handshake for conversationId=${session.conversationId}.\n` +
          `  Handshakes received: ${inbox.handshakes.map((h) => `${h.kind}@conv=${h.conversationId}`).join(", ") || "(none)"}\n` +
          `  Re-run the initiator: pnpm chat-diag -- --role initiator`
      );
    }
    welcomePayload = fromBase64(welcome.payload);
  });

  // Step 4: Join the group from the Welcome alone. If THIS throws, the raw welcome blob size is the
  // signal — compare it with the payload size the initiator logged at its step 5.
  let bobGroup!: Awaited<ReturnType<typeof bobCrypto.processWelcome>>;
  await step("Processing Welcome → joining group", async () => {
    bobGroup = await bobCrypto.processWelcome(welcomePayload);
    check(`bobGroup mlsGroupId=${toBase64(bobGroup.mlsGroupId).slice(0, 12)}...  epoch=${bobGroup.epoch}`);
  });

  // Step 5: List + decrypt. If decryptMessage throws, the epoch + ciphertext summary are the signal.
  await step("Listing + decrypting messages", async () => {
    arrow(`GET /secure-chat/conversations/${session.conversationId}/messages`);
    const page = await bobRest.listMessages(session.conversationId);
    check(`${page.messages.length} message(s)  hasMore=${page.hasMore}`);
    for (const msg of page.messages) {
      check(`  id=${msg.id}  epoch=${msg.epoch}  sender=${msg.senderDeviceId}`);
      check(`  ${b64summary(msg.ciphertext, "ciphertext")}`);
      const result = await bobCrypto.decryptMessage(bobGroup, fromBase64(msg.ciphertext));
      const plaintext = bytesToUtf8(result.plaintext);
      console.log(`\n  ✓ DECRYPTED: "${plaintext}"\n`);
    }

    // Teardown: the responder owns it — the initiator's pool closed when that process exited, so we
    // open our own from the carried databaseUrl. The FK cascade wipes the project's profiles/devices/
    // conversations/messages.
    const pool = new Pool({ connectionString: session.databaseUrl });
    try {
      await pool.query("DELETE FROM projects WHERE id = $1", [session.projectId]);
      check(`project ${session.projectId} deleted (teardown complete)`);
    } finally {
      await pool.end();
    }
  });

  console.log("\nRESPONDER DONE ✓  round-trip verified\n");
}
