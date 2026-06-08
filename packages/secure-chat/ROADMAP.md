# Secure Chat — SDK roadmap (agora-sdk-plus)

The client-side roadmap and task checklist for Agora's end-to-end-encrypted chat. This is the SDK
team's counterpart to agora-server's `CHAT_TODO.md` (server checklist) and `docs/SECURE_CHAT.md` (the
**canonical spec** — read it first). Orientation for this repo is in [CLAUDE.md](../../CLAUDE.md);
current state + cross-repo notes are in [STATUS.md](../../STATUS.md).

**Where we are:** Server Phase 1 (the blind MLS Delivery Service) is shipped. This repo owns the
**crypto seam**, the **transport**, and the **React layer**, all scaffolded and building. The transport
is complete; the crypto is a stub. **Phase 2 = make the crypto real and persist state.**

The cardinal rule (see STATUS.md): **crypto lives here; the wire contract lives in agora-server's
`@agora-server/contract`; the SDK depends on the contract, never the reverse.**

---

## Where Phase 2 plugs into the scaffold (file map)

The structure is in place — Phase 2 is mostly *filling defined seams*, not new architecture:

| What | File | State today |
|---|---|---|
| Real `SecureChatCrypto` | `crypto/src/` (`@agora-sdk/secure-chat-crypto`) | interface + `MockSecureChatCrypto` (`./testing`). **Add the real core** as an opt-in subpath (e.g. `./ts-mls`). |
| Web crypto + persistence wiring | `react-js/src/crypto-web.ts` | `createWebSecureChatCrypto()` is a throwing stub — **wire the real core + IndexedDB here**. |
| Device registration + KeyPackages | `core/src/hooks/useSecureDevice.tsx` | transport + low-water auto-replenish done; **needs `privateState` persistence + a stable persisted `deviceId`**. |
| DM creation (claim→createGroup→relay) | `core/src/hooks/useSecureConversations.tsx` | transport flow done; **needs group-state persistence after `createGroup`**. |
| Send/receive + decrypt | `core/src/hooks/useSecureMessages.tsx` | encrypt/decrypt done *given a `GroupHandle`*; **needs the `conversationId → GroupHandle` resolver** (the persistence layer). |
| REST + `/secure` socket | `core/src/transport/*` | complete. |

The two recurring gaps — "persist `privateState`" and "resolve `conversationId → GroupHandle`" — are
both **task 2 (persistence)** below. Land that and the hooks light up.

---

## Phase 2 — web client (the work)

### 1. Pick + implement the MLS core
- [ ] **Decide ts-mls vs OpenMLS→WASM.** Criteria:

  | | ts-mls | OpenMLS→WASM |
  |---|---|---|
  | Language | pure TS — same JS on web/RN/Expo | Rust→WASM; RN/Expo need a native bridge (Phase 3) |
  | Audit | younger, less audited | audited, mature |
  | Bundle | smaller, no WASM load | WASM payload + init |
  | Phase 3 | "ship the same JS" | build uniffi/JSI bridge |

  Lean **ts-mls** for fastest web→native path unless the audit bar mandates OpenMLS. Record the
  decision + rationale in STATUS.md.
- [ ] Implement it in `@agora-sdk/secure-chat-crypto` behind the existing interface, as an **opt-in
      subpath** (`@agora-sdk/secure-chat-crypto/ts-mls`) so the heavy core isn't pulled in by default.
      The mock stays on `./testing`.
- [ ] **Enforce replay/gap detection** via MLS generation counters — the DS only sanity-bounds epochs
      (spec §11, open decision #3). Verify the chosen core surfaces this; surface gaps to the caller.

### 2. Key & group-state persistence
- [ ] Define a small **persistence interface** (get/set opaque blobs by key) so web uses IndexedDB and
      RN/Expo can swap a keystore later.
- [ ] Persist: device `privateState` + the stable `deviceId`; per-group state via
      `exportGroupState`/`importGroupState`; the handshake `lastSeq` cursor (task 4).
- [ ] Implement the **`conversationId → GroupHandle`** resolver and feed it to `useSecureMessages`
      (and the post-`createGroup` save in `useSecureConversations`).
- [ ] Handle eviction gracefully (Safari ITP / "clear browsing data") — detect missing state and fall
      back to backup-restore (task 5) rather than crashing.

### 3. KeyPackage replenishment loop
- [ ] Publish a batch on registration (done) and **top up** on `secure:key-packages-low` (already wired
      in `useSecureDevice`) and proactively via `GET /key-packages/count`. Tune the low-water threshold.

### 4. Handshake processing + ordering
- [x] On connect: `GET /devices/:id/handshakes?since=<lastSeq>`, then live via `secure:welcome` /
      `secure:handshake`. Process Welcomes/Commits in **`seq` order**; persist the cursor.
      *(`useSecureHandshakes` — serialized seq-ordered queue, dedupe, cursor persistence, room re-join.)*
- [x] **Buffer** application messages whose epoch the client hasn't reached yet; flush as Commits land.
      *(provider group-version signal → `useSecureMessages` re-resolves + re-decrypts in place.)*
- [ ] On `409 secure-chat/epoch-conflict` (membership commits): refetch handshakes, rebase, retry.
      *(deferred — needs a membership-write hook; `useSecureHandshakes` exposes `resync()` as the primitive.)*

### 5. Passphrase backup / restore UX
- [ ] `exportBackup(passphrase)` → `PUT /key-backup` on a schedule; restore on a new browser via
      `GET /key-backup` → `importBackup`. The **real** core must use a real KDF (argon2id, conservative
      params) + AEAD — the mock's is fake. Add a passphrase-strength meter (the server holds the
      ciphertext blob, so a weak passphrase is offline-brute-forceable on a DB exfil).

### 6. Metadata hardening *(optional, Phase 2+)*
- [ ] Client-side ciphertext **size-bucket padding** (blunts traffic-shape fingerprinting; pairs with
      the server's Tor track).
- [ ] **Safety-number / key-verification UI** (out-of-band fingerprint compare) for TOFU hardening.

### 7. Tests + a working demo
- [ ] Mock-backed (`@agora-sdk/secure-chat-crypto/testing`) unit tests of the hooks.
- [ ] An e2e against a **running agora-server** proving, from the client side, the round-trip
      (register → DM → send → receive → reload-survives → restore-on-new-browser) and that the server
      only ever stored ciphertext. Consider wiring a secure-chat screen into `agora-demo`.

---

## Definition of done (Phase 2)

A browser app can — against an **unmodified** agora-server — register a device, start a DM, exchange
E2EE messages across two browsers, survive a reload (persistence), and restore on a fresh browser via
passphrase backup, with the server storing **only ciphertext**.

---

## Cross-repo dependencies & coordination

- **Consume the mock** from `@agora-sdk/secure-chat-crypto/testing` (already exported).
- **`@agora-server/contract`** — depend on it for wire types once agora-server publishes it (Apache-2.0); then
  delete `core/src/contract/` and import from it. Until then keep the stand-in byte-faithful.
- **Coordinate with the server team on:** publishing `@agora-server/contract`; retiring their
  `packages/secure-chat-core/` in favor of consuming our crypto in tests; and the **channel committer
  strategy** (MLS External Commits) *before* building `channel`-type conversations (spec §16.1).

## Open decisions (SDK-relevant; from spec §16)

1. ts-mls vs OpenMLS-WASM — **must pick** (task 1).
2. Chosen core must enforce generation-counter replay/gap detection (task 1).
3. Ciphertext padding strategy (task 6).
4. Backup-passphrase strength enforcement (task 5).
5. Channel committer (External Commits) — needs server coordination before channels.
