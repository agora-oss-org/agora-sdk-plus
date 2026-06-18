# chat-diag — Secure Chat Diagnostic Harness Design

**Date:** 2026-06-17
**Status:** Approved — ready for implementation planning
**Repo:** `agora-sdk-plus`
**Related:** `agora-server/docs/SECURE-CHAT-DIAG-HARNESS.md` (concept doc that motivated this)

---

## Problem

Debugging the MLS secure-chat "waiting for key update" failure browser-to-browser is impossible:
device identity churns on every reload, IndexedDB state is invisible, and the SDK emits zero logs.
The existing `e2e/secure-chat.e2e.ts` runs both "devices" in a single Node process — it proves the
protocol works in-memory but never exercises the seam where the browser actually fails
(persist device state → simulate process boundary → reload from disk, NOT re-register).

When the e2e *does* run against a live server and something goes wrong, failures cascade silently:
one `ECONNREFUSED` at step 1 produces `Cannot read properties of undefined (reading 'mlsGroupId')`
at step 8. There is no way to tell which step was the actual root cause.

## Solution

`e2e/chat-diag.ts` — a single TypeScript script, invoked twice in two separate terminal processes,
that drives the full MLS round-trip through the live server with verbose per-step logging and
hard-stop on first failure (no cascade).

## CLI

```sh
# Add to root package.json scripts:
"chat-diag": "tsx e2e/chat-diag.ts"

# Terminal 1 — run first:
pnpm chat-diag -- --role initiator

# Terminal 2 — run after initiator prints "INITIATOR DONE":
pnpm chat-diag -- --role responder
```

Same env vars as the existing e2e — no new config:
- `AGORA_E2E_TEST_DATABASE_URL` — Postgres URL of the running server's DB
- `AGORA_E2E_ACCESS_TOKEN_SECRET` — matches the server's `.env`
- `AGORA_E2E_BASE_URL` (optional, default `http://localhost:4000/v7`)
- `AGORA_E2E_SOCKET_URL` (optional, default `http://localhost:4000`)

## Architecture

### Files

| File | Purpose |
|---|---|
| `e2e/chat-diag.ts` | **New.** The entire diagnostic script. |
| `~/.agora-chat-diag/session.json` | Cross-process state written by initiator, read by responder. |
| `e2e/bootstrap.ts` | Unchanged. Reused for `readE2EEnv()` + `seedScenario()`. |
| `e2e/crypto-factory.ts` | Unchanged. Not used (always real ts-mls). |

No changes to any SDK source files or existing tests.

### Initiator flow (9 steps)

1. **Seed users** — `seedScenario(env)` → throwaway project + alice + bob + tokens. Does NOT call
   `teardown()` — the project must live until the responder finishes.
2. **Generate device identities** — two fresh `createTsMlsSecureChatCrypto()` instances; one
   `generateDeviceIdentity()` each.
3. **Register both devices + publish KeyPackages** — alice and bob both register via their respective
   `SecureChatRestClient` instances; each publishes 50 key packages.
   Logs both `serverRowId` values with a callout: `⚠ this UUID ≠ deviceId — Welcomes/messages use this`.
4. **List bob's devices (alice's view)** — `aliceRest.listDevices(bob.userId)`.
5. **Claim bob's KeyPackage** — `aliceRest.claimKeyPackage(bobServerRowId)`.
6. **Create MLS group + generate Welcome** — `aliceCrypto.createGroup({ initialMembers: [bobDevice + bobKP] })`.
7. **Create conversation + relay Welcome** — `aliceRest.createConversation({ type:"dm", mlsGroupId, welcomes })`.
8. **Encrypt + send message** — `aliceCrypto.encryptMessage(aliceGroup, plaintext)` →
   `aliceRest.sendMessage(conversationId, { ciphertext, epoch, senderDeviceId: aliceServerRowId })`.
9. **Save session** — write `~/.agora-chat-diag/session.json` with:
   - `projectId`, `aliceUserId`, `bobUserId`, `aliceToken`, `bobToken`
   - `aliceServerRowId`, `bobServerRowId`
   - `conversationId`
   - `bobExportedDeviceState` — `bobCrypto.exportDeviceState()` (base64 blob)

### Responder flow (5 steps)

1. **Load session** — read `~/.agora-chat-diag/session.json`.
2. **Import bob's device state** — fresh `createTsMlsSecureChatCrypto()` instance, then
   `bobCrypto.importDeviceState(session.bobExportedDeviceState)`.
   Logs: `✓ using saved device state — skipping registerDevice (invariant: no churn)`.
3. **Drain handshakes** — `bobRest.fetchHandshakes(bobServerRowId, { since: "0" })`.
   Logs: count, seq numbers, types, blob sizes.
4. **Process Welcome → join group** — for each `type:"welcome"` handshake:
   `bobCrypto.processWelcome(welcomeBlob)` → `bobGroup`. Advances handshake cursor.
5. **List + decrypt messages** — `bobRest.listMessages(conversationId)` → for each message:
   `bobCrypto.decryptMessage(bobGroup, ciphertext)`. Logs raw ciphertext (base64 summary) AND
   decrypted plaintext. At the end, creates a fresh `pg.Pool` from `AGORA_E2E_TEST_DATABASE_URL`
   and deletes the throwaway project row (`DELETE FROM projects WHERE id = $1`) — the responder
   is a separate process and cannot reuse the initiator's pool.

### The `step()` helper

```typescript
async function step<T>(
  label: string,
  current: number,
  total: number,
  fn: () => Promise<T>,
  summarize?: (result: T) => string[]
): Promise<T> {
  process.stdout.write(`[${current}/${total}] ${label}...\n`);
  try {
    const result = await fn();
    for (const line of summarize?.(result) ?? []) {
      process.stdout.write(`  ✓ ${line}\n`);
    }
    return result;
  } catch (err) {
    process.stdout.write(`  ✗ FAILED\n  ${String(err)}\n`);
    process.exit(1); // hard stop — no cascade
  }
}
```

Each `step()` call owns its own payload logging (URLs, bodies, response fields, base64 summaries)
inside the `fn` callback, printed before the call returns.

### Crypto + storage

- **Crypto:** Always `createTsMlsSecureChatCrypto()` — real MLS, not the mock. Two fresh instances
  (`aliceCrypto`, `bobCrypto`). In-process group/device state lives in those instances' memory.
- **Storage:** No `SecureChatRepository` or `MemoryStore` wrapper — the script calls transport and
  crypto directly (same pattern as the existing e2e). The session JSON *is* the persistence layer.
- **WebSocket:** Not used in v1. The responder polls via REST
  (`listMessages`/`fetchHandshakes`). WebSocket streaming is a follow-up.

## Representative output

**Initiator:**
```
[1/9] Seeding users (throwaway project)...
  ✓ project  a4874bcb-...
  ✓ alice    884e1f77-...
  ✓ bob      47bf9e17-...

[3/9] Registering devices + publishing KeyPackages...
  ✓ alice serverRowId=8877181e  ⚠  this UUID ≠ deviceId — Welcomes/messages use this
  ✓ bob   serverRowId=f3c9a024  ⚠  this UUID ≠ deviceId
  ✓ alice  50 KPs published
  ✓ bob    50 KPs published

[8/9] Encrypting + sending message...
  plaintext : "hello bob, can you read this?"
  ciphertext: QlpoOT... (96B)  epoch=0  senderDeviceId=8877181e
  ✓ messageId=msg001-...

INITIATOR DONE ✓
Run: pnpm chat-diag -- --role responder
```

**Responder:**
```
[2/5] Importing bob's device state (simulating reload)...
  ✓ deviceId=bob-web  serverRowId=f3c9a024
  ✓ using saved device state — skipping registerDevice (no churn)

[3/5] Draining handshakes from server...
  ✓ 1 handshake  seq=1  type=welcome  (2.4 KB)

[4/5] Processing Welcome → joining group...
  ✓ bobGroup  mlsGroupId=a1b2c3...  epoch=0

[5/5] Listing + decrypting messages...
  ciphertext : QlpoOT... (96B)
  ✓ DECRYPTED : "hello bob, can you read this?"

RESPONDER DONE ✓  round-trip verified
```

## What this diagnoses

The session-file boundary between initiator and responder is the exact seam the browser fails on:
bob's device state is exported → written to disk → imported into a fresh crypto instance in a
new process. If `processWelcome` fails, you see the raw blob. If `decryptMessage` fails, you see
the epoch and ciphertext. No cascade, no mystery.

## Out of scope (v1)

- WebSocket streaming (responder polls REST)
- Filesystem `SecureChatStore` (session JSON covers the cross-process seam)
- Load testing (`--count`, `--rate`, `--concurrency`)
- SDK logger seam (tracked separately in `SECURE-CHAT-DIAG-HARNESS.md`)
- Multi-device per user
- Python API-stability oracle
