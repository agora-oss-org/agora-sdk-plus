# Status & roadmap

A running ledger of what's built, what's stubbed, and the cross-repo work this depends on.

## Built (scaffold)

- Monorepo tooling: pnpm workspace, dual ESM/CJS TypeScript build, root typecheck — mirrors agora-sdk.
- `@agora-sdk/secure-chat-crypto`: the `SecureChatCrypto` seam (interface + types) on the main entry,
  and the deterministic `MockSecureChatCrypto` on the `./testing` subpath. Dependency-free.
- `@agora-sdk/secure-chat-core`: REST transport (all endpoints from `docs/SECURE_CHAT.md` §9),
  `/secure` socket client, `SecureChatProvider` + hooks, base64 utils. Depends on the crypto package
  for the interface; consumes the wire types from the published `@agora-server/contract` (type-only
  re-export in `core/src/contract/`).
- `@agora-sdk/public-read-core` + `@agora-sdk/public-read-react-js`: the anonymous `/public/*` client
  — tokenless transport (`baseUrl` + `projectId` only, **no** credential field in the config type),
  `PublicReadProvider`, `usePublicEntity` / `usePublicComments` / `usePublicCommentThread`, and the
  `<PublicComments>` drop-in. Consumes `@agora-server/contract@^0.22.0` (the floor that carries
  `Entity.public`). Web-only at v1; `core` is platform-agnostic so native can follow.
- Platform packages: `react-js` (Phase 2 web — **done**: real ts-mls crypto, IndexedDB persistence,
  KeyPackage replenishment, replay/gap enforcement, metadata padding; see "What's next" below),
  `react-native` + `expo` (Phase 3 stubs).

## The architecture decision (corrected)

The earlier plan — publish `@agora-sdk/secure-chat-contract` + `@agora-sdk/secure-chat-crypto`
*from agora-server* — was **wrong**: it inverted the dependency (server contract depending on an SDK
package) and would have published AGPL crypto. The corrected model, agreed with the server team:

> **The crypto seam is client code; it lives in the SDK. The wire contract stays in the server. The
> arrow is SDK → contract.**

| Artifact | Home | Relationship |
|---|---|---|
| `SecureChatCrypto` interface + mock + the real ts-mls core (`./ts-mls`) | **this repo** (`@agora-sdk/secure-chat-crypto`, Apache-2.0) | agora-server **dev-depends** on it for tests — a consumer, like agora-demo consumes the published SDK |
| secure-chat wire types (`Secure*Model`, request bodies) | **agora-server** (`@agora-server/contract`, Apache-2.0) | this SDK **depends on** it (currently `^0.13.0` on `secure-chat-core`, `^0.12.1` on `social-core`; bumped as the contract's surface has grown — see `CLAUDE.md`); `core/src/contract/` is a type-only re-export (the stand-in copy is gone) |

Why this is right: it removes the dependency inversion, and it dissolves the license problem — the
seam was AGPL-3.0 inside the AGPL server; moved into this Apache-2.0 repo (sole-author relicense) it
becomes safely consumable by third parties.

## Cross-repo follow-up

### agora-server (their side)
- Delete `packages/secure-chat-core/` and point the two integration importers
  (`test/integration/secure-helpers.ts`, `secure-chat-backup.test.ts`) at
  `@agora-sdk/secure-chat-crypto/testing` (a test **devDependency**).
- Publish `@agora-server/contract` (Apache-2.0) so this SDK can depend on it for the wire types.
- Timing (server team's call): **cleanest** = move now, link/devDepend on the published crypto;
  **pragmatic** = keep the throwaway mock in-repo through Phase 1 (nothing's published yet) and move
  when Phase 2 builds the real core here.
- Update the server's `CHAT_TODO.md` to this model (crypto → SDK; contract stays; SDK builds on it).

### this repo (when `@agora-server/contract` is published) — ✅ done (2026-06-08)
- `@agora-server/contract` (originally pinned `^0.9.3`, since bumped to `^0.13.0` on `secure-chat-core`
  and `^0.12.1` on `social-core` as the contract's surface grew) is a `dependency` of both. The former
  byte-faithful stand-in copy is replaced by a **type-only re-export** in `core/src/contract/` (kept as
  a thin barrel so the internal import path is stable and the public surface stays scoped to
  secure-chat). The contract added the request-**body** types (`z.input` of its schemas) in 0.9.3, so
  the SDK no longer hand-maintains any wire types. Verified: typecheck + unit + build-all + verify:dist
  + dual e2e all green. *(If a literal file deletion + direct `@agora-server/contract` imports is
  preferred over the re-export barrel, that's a quick follow-up.)*

## What's next — Phase 2 (web) and Phase 3 (native)

The detailed, actionable task list — the MLS-core decision, persistence, KeyPackage replenishment,
handshake ordering, backup UX, tests, and the per-file map of where each task plugs into the scaffold
— lives in **[`packages/secure-chat/ROADMAP.md`](packages/secure-chat/ROADMAP.md)**. That's the SDK
team's checklist; this file stays the present-state + cross-repo ledger.

In short: **Phase 2's Definition of Done is met** — real `SecureChatCrypto` (ts-mls), IndexedDB
persistence, KeyPackage replenishment, generation-counter replay/gap enforcement, and metadata
hardening (padding + safety numbers) are all shipped. Passphrase backup/restore shipped too but is now
**deprecated** in favor of device-to-device IUC history restore + the local `createEncryptedStore`
at-rest decorator (Phase 2.5). The one remaining Phase-2 hardening item is the `409
secure-chat/epoch-conflict` rebase-on-retry for membership commits. Phase 3 brings native (RN/Expo
keystore, multi-device). See the roadmap for the full, current task-by-task state.

### MLS core decision (2026-06-08)

**Chosen: [ts-mls](https://github.com/LukaJCB/ts-mls) `1.6.2`** — pure TypeScript (`@hpke/core` +
`@noble/*`, no WASM) — over OpenMLS→WASM and mls-rs→WASM. Rationale: the same JS runs on web now and
RN/Expo later with **no native bridge** (the fastest web→native path), and its functional API maps
cleanly onto the `SecureChatCrypto` seam. Tradeoff accepted: younger / less audited than OpenMLS,
mitigated by keeping it behind the interface so it can be swapped without touching call sites.

Shipped as `createTsMlsSecureChatCrypto()` on the opt-in **ESM-only** subpath
`@agora-sdk/secure-chat-crypto/ts-mls` (bare entry + `./testing` mock stay dependency-free). Ciphersuite
**1** (`MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`) default. Recipient joins from the Welcome alone
(`ratchetTreeExtension`); group + device state persist via ts-mls `encode/decodeGroupState`. Proven by
the dual mock+ts-mls e2e against a running agora-server. **Consequence:** `@agora-sdk/secure-chat-react-js`
is now **ESM-only** (it depends on the ESM-only core + bundler-only `@agora-sdk/core`). Notes:
ts-mls leaves `@noble/hashes` undeclared, so the crypto package declares the `@noble/*` primitives
directly; `makeKeyPackageRef`/`getGroupMembers`/`defaultClientConfig` aren't re-exported from the
ts-mls root and are deep-imported via its `./*.js` exports.

### Passphrase backup / restore (2026-06-08)

Phase 2 task 5 landed: real at-rest backup crypto + the `useSecureBackup` hook + a passphrase-strength
meter (see CHANGELOG `[Unreleased]`). Envelope = **argon2id** (m=64 MiB, t=3, p=1) + **xchacha20poly1305**
(`crypto/src/ts-mls/backup.ts`), with envelope descriptors bound as AEAD AAD. `SecureChatCrypto.importBackup`
now returns the restored `DeviceIdentity` (deliberate in-repo seam change, mirrors `importDeviceState`).
Restore is **server-assisted**: the backup is conversationId-agnostic; the hook rebinds each
conversation's group state from the server's conversation list. With this, the Phase-2 Definition of
Done is met **in code** — the one open proof is the restore-on-new-browser **e2e leg**, deferred until
a local agora-server is running again.

### ADR — generation-counter replay/gap enforcement (2026-06-08)

**Decision: ts-mls is the single enforcement point for MLS replay/gap/reorder; the SDK does not
hand-roll a parallel generation counter.** ts-mls's secret-tree ratchet already implements RFC 9420's
per-sender generation enforcement — it rejects a replayed/consumed generation
(`ValidationError "Desired gen in the past"`), bounds the forward gap
(`maximumForwardRatchetSteps`, default 200 → `"too far in the future"`), tolerates in-window reorder
(`retainKeysForGenerations`, default 10), and zeroizes consumed keys. Re-implementing that at the SDK
layer would be hand-rolling crypto (against engineering standard #1) and would risk diverging from the
core's semantics.

**What the SDK adds** (Phase 2 task 1.3 — closes spec §16.3 / `CHAT_TODO.md` #3 "verify the chosen core
enforces this"):
1. **Pin it** — characterization tests in `crypto/src/ts-mls/_characterization.test.ts` exercise the raw
   library so a future ts-mls upgrade that weakens replay/gap fails loudly.
2. **Classify + surface** — `decryptMessage` maps a core rejection to a typed `SecureChatDecryptError`
   (`reason`), and `useSecureMessages` marks the row `status: "rejected"` and **fails closed** (no
   plaintext, never retried). Previously every decrypt failure was swallowed into `plaintext: null` and
   retried forever, which masked a replay/forgery as an ordinary buffered message. "Is this bufferable?"
   is decided by **epoch comparison** (`model.epoch > group.epoch`) — a future-epoch message is `pending`
   and retried when a Commit advances the group; everything else that fails is terminal.
3. **Tuning knob** — an optional `keyRetention` on `createTsMlsSecureChatCrypto` exposes ts-mls's window
   (it can only *tighten/loosen*, never disable enforcement), threaded consistently through every group
   create/join/import/restore so it survives a persistence round-trip.

Generation numbers stay **internal** (not exposed on the seam); message-list completeness comes from the
durable REST list, not an app-level generation tracker.
