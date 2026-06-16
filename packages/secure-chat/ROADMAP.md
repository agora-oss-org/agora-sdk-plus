# Secure Chat — SDK roadmap (agora-sdk-plus)

The client-side roadmap and task checklist for Agora's end-to-end-encrypted chat. This is the SDK
team's counterpart to agora-server's `CHAT_TODO.md` (server checklist) and `docs/SECURE_CHAT.md` (the
**canonical spec** — read it first). Orientation for this repo is in [CLAUDE.md](../../CLAUDE.md);
current state + cross-repo notes are in [STATUS.md](../../STATUS.md).

**Where we are:** Server Phase 1 (the blind MLS Delivery Service) is shipped. The SDK's transport,
**persistence**, React layer, handshake processing, the **real ts-mls MLS core** (released **v0.4.0**),
and now **passphrase backup/restore** (real argon2id+AEAD core + `useSecureBackup` + strength meter)
are all done. The Phase-2 Definition of Done is met in code; the one remaining proof is the
**restore-on-new-browser e2e leg** (needs a running agora-server). **Remaining Phase 2 = hardening:**
409 epoch-conflict rebase and the demo screen. (Generation-counter enforcement — done, task 1.3;
eviction recovery — done, task 2.4; KeyPackage-replenishment tuning — done, task 3; metadata hardening
— size-bucket padding + safety number — done, task 6.)

The cardinal rule (see STATUS.md): **crypto lives here; the wire contract lives in agora-server's
`@agora-server/contract`; the SDK depends on the contract, never the reverse.**

---

## Where Phase 2 plugs into the scaffold (file map)

The structure is in place — Phase 2 is mostly *filling defined seams*, not new architecture:

| What | File | State today |
|---|---|---|
| Real `SecureChatCrypto` | `crypto/src/ts-mls/` (`@agora-sdk/secure-chat-crypto/ts-mls`) | ✅ **done** — real ts-mls core on the opt-in ESM-only subpath; mock stays on `./testing`. |
| Web crypto + persistence wiring | `react-js/src/crypto-web.ts` | ✅ `createWebSecureChatCrypto()` returns the real ts-mls core; group state persists via the IndexedDB store. |
| Device registration + KeyPackages | `core/src/hooks/useSecureDevice.tsx` | ✅ transport + auto-replenish (deficit top-up + configurable low-water + proactive/manual check, task 3) + `privateState`/stable `deviceId` persistence — done. |
| DM creation (claim→createGroup→relay) | `core/src/hooks/useSecureConversations.tsx` | ✅ done — group state persists after `createGroup` (`rememberGroup`). |
| Send/receive + decrypt | `core/src/hooks/useSecureMessages.tsx` | ✅ done — cached `conversationId → GroupHandle` resolver wired; re-decrypts buffered rows when the epoch advances. |
| REST + `/secure` socket | `core/src/transport/*` | complete. |

Both recurring gaps — "persist `privateState`" and "resolve `conversationId → GroupHandle`" — landed in
**task 2 (persistence)** below; the hooks are now self-sufficient.

---

## Phase 2 — web client (the work)

### 1. Pick + implement the MLS core
- [x] **Decided: ts-mls** (1.6.2; pure TS, `@hpke/core` + `@noble/*`, no WASM) over OpenMLS/mls-rs→WASM,
      for the fastest web→native path (same JS on web/RN/Expo, no native bridge). Decision + rationale
      recorded in STATUS.md (2026-06-08).
- [x] Implemented in `@agora-sdk/secure-chat-crypto` behind the existing interface as an **opt-in
      ESM-only subpath** `@agora-sdk/secure-chat-crypto/ts-mls` (`createTsMlsSecureChatCrypto`); the
      mock stays on `./testing` and the bare entry stays dependency-free. Recipient joins from the
      Welcome alone (`ratchetTreeExtension`); state persists via `encode/decodeGroupState`. Proven by
      the dual mock+ts-mls e2e.
- [x] **Replay/gap detection enforced + surfaced.** ts-mls's secret-tree ratchet is the enforcement
      point (rejects replayed generations, bounds the forward gap, tolerates in-window reorder); the SDK
      **pins** it with characterization tests and **classifies/surfaces** the rejection: `decryptMessage`
      throws a typed `SecureChatDecryptError(reason)`, and `useSecureMessages` marks the row
      `status: "rejected"` and fails closed (never re-decrypts it — only future-epoch `pending` rows
      retry). Optional `keyRetention` knob tightens the window. ADR in STATUS.md (2026-06-08). We do **not**
      hand-roll a parallel counter (standard #1).

### 2. Key & group-state persistence — ✅ done (v0.2.0+), incl. eviction recovery
- [x] Define a small **persistence interface** (get/set opaque blobs by key) so web uses IndexedDB and
      RN/Expo can swap a keystore later. *(`SecureChatStore` + `MemoryStore` (core); `createIndexedDBStore` (react-js).)*
- [x] Persist: device `privateState` + the stable `deviceId`; per-group state via
      `exportGroupState`/`importGroupState`; the handshake `lastSeq` cursor (task 4). *(`SecureChatRepository`.)*
- [x] Implement the **`conversationId → GroupHandle`** resolver and feed it to `useSecureMessages`
      (and the post-`createGroup` save in `useSecureConversations`). *(provider-cached `resolveGroup`/`rememberGroup`.)*
- [x] Handle eviction gracefully (Safari ITP / "clear browsing data") — detect missing state and fall
      back to backup-restore rather than crashing. *(`useSecureBackup` exposes `needsRestore` /
      `checkingRestore` / `recheckRestore()`: on mount, no local device + a server backup ⇒ the app
      prompts for the passphrase and `restore()`s instead of registering a fresh identity. Evicted,
      cleared, and new-browser are indistinguishable and resolve identically. Fails soft on network error.)*

### 3. KeyPackage replenishment loop — ✅ done
- [x] Publish a batch on registration (done) and **top up** on `secure:key-packages-low` (wired in
      `useSecureDevice`) and proactively via `GET /key-packages/count`. The server signal and the
      proactive/manual paths now **top up to `keyPackageTarget` by the deficit** (from the actual
      `available` count) rather than a blind full batch. Configurable low-water threshold
      (`keyPackageLowWater`, default 50% of target); a one-shot proactive check on device-ready
      (self-heals after a missed signal); and an app-callable `checkAndReplenish()` for
      window-focus / foreground re-checks. No server changes.

### 4. Handshake processing + ordering
- [x] On connect: `GET /devices/:id/handshakes?since=<lastSeq>`, then live via `secure:welcome` /
      `secure:handshake`. Process Welcomes/Commits in **`seq` order**; persist the cursor.
      *(`useSecureHandshakes` — serialized seq-ordered queue, dedupe, cursor persistence, room re-join.)*
- [x] **Buffer** application messages whose epoch the client hasn't reached yet; flush as Commits land.
      *(provider group-version signal → `useSecureMessages` re-resolves + re-decrypts in place.)*
- [ ] On `409 secure-chat/epoch-conflict` (membership commits): refetch handshakes, rebase, retry.
      *(deferred — needs a membership-write hook; `useSecureHandshakes` exposes `resync()` as the primitive.)*

### 5. Passphrase backup / restore UX — ✅ done (crypto + hook + meter)
- [x] Real KDF+AEAD envelope: `crypto/src/ts-mls/backup.ts` (`sealBackup`/`openBackup`) — **argon2id**
      (m=64 MiB, t=3, p=1, 32-byte key) + **xchacha20poly1305** (random salt+nonce), envelope
      descriptors bound as AEAD AAD (downgrade/tamper fails closed). The ts-mls core's
      `exportBackup`/`importBackup` now implement it for real (device identity + every group's state);
      `importBackup` returns the restored `DeviceIdentity` (seam change, mirrors `importDeviceState`).
- [x] `useSecureBackup` hook: `backup(passphrase)` → `PUT /key-backup`; `restore(passphrase)` →
      `GET /key-backup` → `importBackup` → idempotent device re-assert → persist device → rebind each
      conversation's group state from the server conversation list. Plus `needsBackup` stale signal +
      `estimatePassphraseStrength` meter.
- [ ] **Deferred (needs a running agora-server):** the restore-on-new-browser **e2e** leg in
      `e2e/secure-chat.e2e.ts` (alice backs up → a second client with an empty store restores via
      passphrase → decrypts history). Tracked under task 7.

### 6. Metadata hardening — ✅ done *(was optional, Phase 2+)*
- [x] Client-side ciphertext **size-bucket padding** (blunts traffic-shape fingerprinting; pairs with
      the server's Tor track). *(`core/src/util/padding.ts` — self-describing frame + fixed bucket ladder,
      applied in `useSecureMessages`; configurable via `<SecureChatProvider padding>`.)*
- [x] **Safety-number / key-verification** (out-of-band fingerprint compare) for TOFU hardening.
      *(seam `exportGroupIdentities` + pure `core/src/util/safety-number.ts` (Signal-style 60 digits,
      symmetric) + `useSecureSafetyNumber` hook — a headless primitive; the styled UI is the demo, task 7.)*

### 7. Tests + a working demo
- [x] Mock-backed (`@agora-sdk/secure-chat-crypto/testing`) unit tests of the hooks.
      *(`useSecureDevice`/`useSecureConversations`/`useSecureMessages`/`useSecureHandshakes` `.test.tsx`,
      plus transport, persistence, crypto, and ciphersuite suites — 56 tests via `pnpm test`.)*
- [x] An e2e against a **running agora-server** proving, from the client side, the round-trip
      (register → DM → send → receive → reload-survives → restore-on-new-browser) and that the server
      only ever stored ciphertext. Consider wiring a secure-chat screen into `agora-demo`.
      *(`e2e/secure-chat.e2e.ts` — opt-in `pnpm test:e2e`, real transport + MockSecureChatCrypto + two
      devices; covers register→DM→send→receive→realtime→reload + server-blindness. **TODO (needs the
      server up):** add the restore-on-new-browser leg now that task 5's backup/restore exists; the
      demo screen is still TODO.)*

---

## Definition of done (Phase 2)

A browser app can — against an **unmodified** agora-server — register a device, start a DM, exchange
E2EE messages across two browsers, survive a reload (persistence), and restore on a fresh browser via
passphrase backup, with the server storing **only ciphertext**.

---

## Cross-repo dependencies & coordination

- **Consume the mock** from `@agora-sdk/secure-chat-crypto/testing` (already exported).
- **`@agora-server/contract`** — ✅ done: published, and a `dependency` of `@agora-sdk/secure-chat-core`
  (`^0.9.3`). `core/src/contract/` is now a type-only re-export of its secure-chat surface (no more
  copied types). The contract exports the request-body types (`z.input` of its schemas) as of 0.9.3.
- **Coordinate with the server team on:** publishing `@agora-server/contract`; retiring their
  `packages/secure-chat-core/` in favor of consuming our crypto in tests; and the **channel committer
  strategy** (MLS External Commits) *before* building `channel`-type conversations (spec §16.1).

## Open decisions (SDK-relevant; from spec §16)

1. ts-mls vs OpenMLS-WASM — ✅ **decided: ts-mls** (task 1; see STATUS.md 2026-06-08).
2. Generation-counter replay/gap detection — ✅ **resolved** (task 1.3): ts-mls enforces it; the SDK pins
   it with characterization tests + classifies/surfaces rejections (`SecureChatDecryptError`,
   message `status`) + a `keyRetention` knob. ADR in STATUS.md (2026-06-08).
3. Ciphertext padding strategy — ✅ **decided** (task 6a): a self-describing frame zero-padded to a fixed
   bucket ladder (`32…8192`, then 8 KiB multiples), applied before MLS encryption; provider-configurable.
4. Backup-passphrase strength — ✅ **addressed**: `estimatePassphraseStrength` (coarse client-side
   meter) + a memory-hard argon2id KDF (task 5). Hard *enforcement* (reject below a threshold) is left
   to the app/UX.
5. Channel committer (External Commits) — needs server coordination before channels.
