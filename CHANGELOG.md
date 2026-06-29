# Changelog

All notable changes to Agora SDK Plus are documented here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.3] — 2026-06-28

### Added

- Each feature guide now **ships inside** its primary web package's npm tarball, so it travels with an `npm install`: `docs/AUTH.md` → `@agora-sdk/auth-react-js`, `docs/SECURE-CHAT.md` → `@agora-sdk/secure-chat-react-js`, `docs/SOCIAL-GRAPH.md` → `@agora-sdk/social-react-js`. The copy is generated from the root `docs/` source of truth by each package's `copy:docs` script (wired into `build`) and git-ignored, so there is no committed duplicate to drift. Added READMEs for `secure-chat-react-js` and `social-react-js` (previously none), and a "Full guide" link from each web package README + the root README.

## [0.9.2] — 2026-06-28

### Fixed

- **`@agora-sdk/auth-react-js` — `useOAuthCallback` no longer hangs to timeout on a successful login when a stale account is present (field report A8).** A leftover stale account in `localStorage` triggers an SDK boot-refresh that fails `401` and resets the in-store `accessToken` the fresh OAuth flow just set; the previous gate, keyed on in-store auth, then never fired even though the fresh account had persisted correctly. The gate now keys on the **persisted row** — success = a *fresh* active account (new id, or an advanced token expiry) lands in `localStorage` — and polls (the SDK's same-tab writes emit no `storage` event), making it immune to the race. `useOAuthCallback` no longer reads `useAuth`/`useUser`. Added `readActiveAccount` + `pruneAllAccounts` to the storage seam and an optional `pruneStaleOnMount` prop (off by default) that clears pre-existing accounts on mount to silence the cosmetic `401` in single-session apps.

## [0.9.1] — 2026-06-28

### Added

- `docs/TESTING.md` — testing guide covering all three layers (mocked unit + jsdom, opt-in e2e), the two vitest configs and their disjoint globs, source aliases, the WebCrypto-realm shim, e2e prerequisites/env-var gate, plus the `chat-diag` diagnostic and `verify:dist` packaging guard. Linked from the README "Develop" section.

### Changed

- `CLAUDE.md` + `ARCHITECTURE.md` — documented the **social** feature group (`@agora-sdk/social-{core,react-js,react-native,expo}`): the three commons lenses (Weather / Constellation / Neighborhood) + transparency self-gating, REST-only/no-crypto layering, and its own package-graph cluster and layers diagram. Corrected `@agora-server/contract` version drift (secure-chat-core `^0.13.0`, social-core `^0.12.1`), the `build-all` order, and added single-test + release/`verify:dist` commands.

### Fixed

- All package manifests now point `repository.url` / `homepage` / `bugs.url` at `github.com/agora-oss-org/agora-sdk-plus` (the repo moved orgs from `jenova-marie`). npm publish with provenance (`NPM_CONFIG_PROVENANCE`) rejected every package with `422 … Failed to validate repository information` because the manifest org no longer matched the GitHub Actions build repo recorded in the sigstore attestation.

## [0.9.0] — 2026-06-28

### Added

- **`@agora-sdk/auth-react-js`** (new web package): black-box OAuth callback handling and auth ergonomics for Agora SDK (Replyke fork) web apps — `useOAuthCallback` / `OAuthCallbackHandler` (persistence-gated MPA redirect), `useAuthStatus` (auth-ready signal), `useSignOutEverywhere` (reliable full logout), `useAuthSelfHeal` (stale-account prune). First plus feature that peer-depends on `@agora-sdk/react-js` — a deliberate, scoped exception to the "no `@agora-sdk/core` dependency" rule (auth is *about* the SDK session). Answers `agora-sdk/docs/AUTH_IMPLEMENTATION.md` P1/P3/P4/P5/P6/P7.
- Restore-blob REST methods (`uploadRestoreBlob`/`getRestoreBlob`/`deleteRestoreBlob`) + `SecureRestoreError`; `@agora-server/contract` bumped to `^0.13.0` with type-only re-exports of `RestoreBlobModel`/`UploadRestoreBlobResponse`/`UploadRestoreBlobBody`.
- `kind:1` IUC control-message codec (`secure-chat-core/restore/control`) — canonical-CBOR encode/decode for request/offer/declined/envelope/complete/ack; strict, fail-closed.
- IUC ENVELOPE blob AEAD (`secure-chat-core/restore/seal`) — XChaCha20-Poly1305 seal/open with a full-entropy CSPRNG key and the transfer descriptor bound as canonical-CBOR AAD; fail-closed.
- Public surface for IUC ENVELOPE foundation exported from `@agora-sdk/secure-chat-core` — all restore/seal, restore/control, and restore-blob transport/contract symbols now accessible from the package root.

### Changed

- Post-review hardening of the IUC ENVELOPE foundation: `decodeIucControl` now bounds untrusted input tighter (`maxBytes`/`maxDepth` for the flat control messages, not just `maxItems`); `restoreAad` drops the `unknown` cast for compile-time-checked CBOR entries; added a negative-blindness test asserting the sealed blob never embeds the descriptor routing strings (AAD is bound, not embedded). Documented the slice-#2 AAD-reconstruction mapping and the `count` (history rows) vs `chunkCount` (blob chunks) distinction in the design spec.

### Fixed

- e2e harness now defaults `AGORA_E2E_BASE_URL`/`AGORA_E2E_SOCKET_URL` to the standalone `@agora/secure-chat` process on `:4002` (was `:4000`, the main API, which serves neither the secure REST nor the `/secure-socket/` realtime). This unblocks the `fans out a live message over the /secure socket` e2e (`connect_error: websocket error` against the 404'd path); the realtime socket was never broken — the harness was probing the wrong port. Full suite green (16/16) against `:4002`.

## [0.8.0] — 2026-06-20

### Changed

- Durable message store now persists decrypted content-frame bytes (`[kind][payload]`) instead of UTF-8 plaintext — `SecureChatRepository.saveMessageContent`/`loadMessageContent` replace `saveMessagePlaintext`/`loadMessagePlaintext`.
- `DecryptedSecureMessage` now carries structured `content` (body/replyTo/editedAt/deleted/reactions) + raw `mimi` + `contentHash` instead of `plaintext: string | null`; messages encode as MIMI CBOR (`[kind][payload]` frame) end-to-end.

### Added

- Replies, reactions, edits, and deletes in `useSecureMessages` via MIMI content (`reply`/`react`/`editMessage`/`deleteMessage`/`unreact`).
- Message fold reducer (`secure-chat-core/hooks/message-fold`) — folds reactions/edits/deletes/un-reacts onto their target by MIMI content-hash, with out-of-order buffering and reload-stable re-folding.
- Tier-2 MimiContent builders (`secure-chat-core/content/builders`) — `post/reply/edit/delete/react/un-react` with fresh CSPRNG salts (draft-08 shape).
- Content routing frame (`secure-chat-core/content/frame`) — `[kind:1][payload]` discriminator (`0`=MimiContent, `1`=IUC control, reserved).
- Deterministic CBOR codec (`secure-chat-core/content/cbor`) — canonical encode + strict, bounded
  decode over the MimiContent subset (no floats/indefinite/bignum); the basis for MIMI content +
  stable content hashing.
- Differential CBOR oracle test cross-checking the codec against `cbor2` (test-only devDependency) over randomized in-subset structures.
- `MimiContent` types + codec + `contentHash` (`secure-chat-core/content/mimi-content`) — the full
  draft-ietf-mimi-content-08 wire structure (faithful CDDL: `NestedPart` wrapper, `Expiration`,
  32-byte `MessageId` reply/replace refs, multipart with `partSemantics`, ≥2-parts) encoded/decoded
  and schema-validated, fail-closed on untrusted peer bytes. `contentHash` returns a 32-byte
  MessageId-shaped value (`0x01 || sha256(canonical CBOR)[0..30]`) — the wire is interop-faithful; the
  single documented deviation is the simplified hash input (we adopt the content format, not MIMI
  federation, so there is no senderUri/roomUri). SHA-256 via `@noble/hashes` (now a core dependency).

### Fixed

- **A tampered/forged application-message ciphertext is now classified `unauthenticated`, not
  `unknown`.** The ts-mls decrypt-error classifier (`secure-chat-crypto/ts-mls`) only mapped a failed
  *signature* (`CryptoVerificationError`) to `unauthenticated`, but the common active-attacker /
  byte-flip case fails the AEAD tag first, which ts-mls surfaces as a `CryptoError` with a
  primitive-dependent opaque message (WebCrypto AES-GCM: `OperationError`; @noble: `invalid … tag`).
  That fell through to `unknown`. The classifier now keys off the error **name** (`CryptoError`), so an
  AEAD authentication failure is reported as forged. Behavior already failed closed (the message was
  always dropped); this only corrects the security-relevant `SecureDecryptFailureReason`. Added wrapper
  tests pinning the `unauthenticated` and `epoch-too-old` reasons end-to-end, plus raw ts-mls/@noble
  error-string characterization pins so a future upstream reword fails loudly with a minimal repro.

## [0.7.0] — 2026-06-20

### Added

- **`exportSecret(group, label, context, length)` on the `SecureChatCrypto` seam.** An RFC 9420 MLS
  Exporter that derives an application-specific secret from the group's current-epoch `exporter_secret`,
  domain-separated by `(label, context, length)` — the same group+epoch+label+context yields identical
  bytes on every member of the epoch, and a device that did not join cannot reproduce them. It is the
  prerequisite for the IUC Short Authentication String (exporter-derived, not KeyPackage-derived, so a
  blind server cannot grind a colliding device). Implemented on both the real **ts-mls** core (a thin
  `mlsExporter` pass-through) and `MockSecureChatCrypto` (deterministic, epoch- and domain-bound), with
  the RN/Expo Phase-3 stubs updated. Fails closed (unknown group / `length <= 0` throw); the raw
  `exporter_secret` never crosses the method boundary. **Client-only — no server, contract, or wire
  change.**

- **Encryption at rest for the web store (`createEncryptedStore`).** A new `SecureChatStore` decorator
  in `@agora-sdk/secure-chat-react-js` that seals every persisted **value** (MLS group/ratchet secrets,
  the device signing key, decrypted `msg:` history, cursors) with AES-256-GCM before delegating to a
  base store (normally `createIndexedDBStore()`). A password is stretched with **argon2id** (RFC 9106,
  `m=64MiB, t=3, p=1`) into a KEK that wraps a random AES-256-GCM DEK held only as a **non-extractable**
  WebCrypto `CryptoKey`; per-value AES-GCM uses a fresh CSPRNG nonce (`[version][nonce][ciphertext+tag]`).
  The decorator adds `unlock(password)` / `lock()` / `isLocked()` / `changePassword(old, new)`
  (re-wraps the same DEK — no bulk re-encryption) and a `StoreLockedError`; the AEAD unlock IS the
  password check (no stored hash). Fails closed everywhere (locked → throw; wrong password or tamper →
  generic error, never raw bytes). Store **keys** still pass through in the clear (values-only scope;
  keys leak conversation ids + message counts the blind server already sees). The repository, provider,
  and hooks are untouched — it drops in as a wrapper.

- **Durable decrypt-once message store (local plaintext history).** `SecureChatRepository` gains
  `saveMessagePlaintext` / `loadMessagePlaintext` (keyed `msg:<conversationId>:<messageId>`) over the
  existing `SecureChatStore` seam. `useSecureMessages` now write-throughs every successful decode (and
  our own sends) to it and serves already-seen ids from the store *before* touching the MLS ratchet —
  the principled fix for forward-secret history: MLS application keys are single-use, so a message can
  be decrypted exactly once and re-decrypting a consumed generation throws `"Desired gen in the past"`.
  Conversation history therefore lives on-device and survives reload without ever replaying the ratchet.
  Plaintext at rest here is **local-only** (the blind server never sees it); on-disk encryption-at-rest
  is a future drop-in `SecureChatStore` implementation (the repository/hooks are untouched by it).

- **`TESTING.md` — a full map of the test harness.** Documents the unit suite, the two-client hook
  composition (mock, ts-mls, and browser-runtime variants), the opt-in foundation e2e, and the
  two-process `chat-diag` diagnostic: what each proves, how to run it, the env it needs, and the
  **fault-isolation ladder** that localizes a bug to a specific layer (the method behind the "waiting
  for key update" investigation).
- **Browser-runtime test (`react-js/src/browser-runtime.test.tsx`).** The last rung of the ladder: the
  real web wiring — `createWebSecureChatCrypto()` (ts-mls) + `createIndexedDBStore()` (over
  `fake-indexeddb`, real async latency) + `<React.StrictMode>` (dev mount→cleanup→mount double-invoke) —
  with two clients through the real hooks. Proves bob registers/joins/decrypts and that a reload (fresh
  crypto + fresh StrictMode mount on the same IndexedDB) rehydrates the device **without re-registering**.
  A sanity probe confirms StrictMode genuinely doubles; the flow shows why it's safe (`useSecureHandshakes`
  gates catch-up on a resolved device id, so the doubled mount never double-processes a Welcome —
  observed `processWelcome ×1`). Needed a vitest alias for the `@agora-sdk/secure-chat-crypto/ts-mls`
  subpath (so the web crypto factory resolves to source in tests). Result: the SDK is exhausted across
  every browser combination; a surviving fault is in the consuming app's wiring (e.g. a non-memoized
  `crypto`/`store` prop that rebuilds the provider and churns the device).
- **Two-client hook-orchestration test (`hooks/two-client-handshake.test.tsx`).** Drives BOTH peers
  through the real `useSecure*` hooks against one shared in-memory fake DS (routed per-caller by bearer
  token), closing the gap above the transport e2e and the two-process `chat-diag` harness (which both
  exercise only the stack *below* React). Four cases assert the receive chain that backs the app's
  "waiting for key update" state: `useSecureHandshakes` drains the Welcome → `rememberGroup` →
  group-version bump → `useSecureMessages` re-resolves + flushes the previously-`pending` row to
  decrypted text — across catch-up, live-socket delivery, and the **full `useSecureDevice` stack**
  (bob self-registers, and the device→handshakes id handoff still joins + decrypts despite the late
  device id). A companion case characterizes the symptom: without `useSecureHandshakes`, the DM lists
  but its message stays `pending`/`plaintext:null`. Proves the conversations/handshakes/messages/device
  orchestration is sound under mock crypto.
- **ts-mls capstone test (`hooks/two-client-ts-mls.test.tsx`).** The same two-client flow as above but
  with **real ts-mls crypto** under the real hooks — the only harness that combines real MLS *and* the
  React hooks for both peers (the e2e/chat-diag run real ts-mls but no React; the mock hook test runs
  the hooks but mock crypto). Bob registers + publishes real KeyPackages via `useSecureDevice`, alice
  claims a real one to build the group, and genuine MLS Welcomes/ciphertext flow through the hooks
  (catch-up + live socket). The fake DS stores/dispenses real KeyPackages. Result: the orchestration
  holds under real MLS too — exhausting the SDK and narrowing the live two-browser fault to the real
  browser runtime (StrictMode + IndexedDB in `secure-chat-react-js`) and the consuming app's wiring.
- **`.env.example` documenting the e2e environment.** Copy to `.env` (gitignored; direnv auto-loads it
  via the repo's `.envrc`) and fill in. Spells out the trap that the `AGORA_E2E_DATABASE_URL` must point
  at the database the **running** agora-server reads (normally its DEV db while `pnpm dev:api` is up) —
  not the server's own internal test database — or every seeded-project request 404s.
- **`chat-diag` — a two-process secure-chat diagnostic harness (`e2e/chat-diag.ts`, `pnpm chat-diag`).**
  Drives the full MLS round-trip (register → publish/claim KeyPackages → createGroup/Welcome → send →
  processWelcome → decrypt) with the real ts-mls crypto against a locally running agora-server, split
  across two OS processes (`--role initiator` then `--role responder`) that hand off via
  `~/.agora-chat-diag/session.json`. The responder re-imports the initiator-exported device state into
  a fresh crypto instance — a faithful, observable stand-in for the browser's "reload, don't
  re-register" seam. Verbose per-step logging (REST paths, base64/epoch wire shapes, the
  `deviceId`-vs-`device.id` footgun) and a `step()` helper that hard-exits on the first failure so a
  root cause is never buried under a cascade. Reuses `e2e/bootstrap.ts`; no SDK source changed.

### Changed

- **MLS group state is now persisted after every send and receive, not just on join/Commit.** Added a
  quiet `persistGroupState(conversationId, handle)` to `SecureChatProvider` (re-exports + saves the
  current ratchet WITHOUT a version bump or listener notify, since an application message is
  intra-epoch). `useSecureMessages` calls it right after `encryptMessage` (before the network send) and
  after every successful `decryptMessage`. The ratchet advances in memory on each application message,
  so this keeps the persisted state in lock-step — see the resend-replay fix below.
- **BREAKING: dropped the `@agora-sdk/core` dependency — secure-chat and social are now standalone;
  `baseUrl` is a required provider prop.** Both feature groups used `@agora-sdk/core` for exactly one
  thing: the `getApiBaseUrl`/`getSocketUrl` runtime-singleton fallback, which let a provider auto-inherit
  a Replyke app's configured URL when `baseUrl`/`socketUrl` weren't passed. Those are accessors to a
  singleton `ReplykeProvider` writes inside core (not pure functions), so the coupling only paid off
  inside a Replyke app. `SecureChatProvider` and `SocialProvider` now **require `baseUrl`** (and
  `SecureChatProvider`'s optional `socketUrl` defaults to `baseUrl`), the core import + fallback are
  gone, and `@agora-sdk/core` is removed from every package's peers, the root devDeps, and the vitest
  stub/alias. Result: the features compile/test/run with **zero `@agora-sdk/core` coupling** and work in
  any app, Replyke or not. **Migration:** pass `baseUrl` (e.g. `https://api.example.com/v7`) to the
  provider; if you relied on the Replyke auto-inherit, read it from your `@agora-sdk/core` config and
  pass it in. (Demo already passes it, so it's unaffected.)
- **Renamed `AGORA_E2E_TEST_DATABASE_URL` → `AGORA_E2E_DATABASE_URL`** across the e2e harness, docs, and
  `.env`. The `TEST` was misleading: the var holds whichever Postgres the server is *actually running*
  on (typically the DEV db), which is distinct from the server's own test database used by its internal
  suite — a naming collision that caused a real misconfiguration (e2e seeding one db while the server
  read another, surfacing as a 404 cascade). The other knobs (`AGORA_E2E_ACCESS_TOKEN_SECRET`,
  `AGORA_E2E_BASE_URL`, `AGORA_E2E_SOCKET_URL`) are unchanged.
- **Declared `@types/react` as a `^18.0.0 || ^19.0.0` peer on every React-facing platform package**
  (`secure-chat/{react-js,react-native,expo}`, `social/{react-js,react-native,expo}`), matching the
  `react`/`react-dom` peer ranges already there and bringing these packages to parity with the
  `agora-sdk` fork's platform packages. A React 19 consumer's `@types/react@^19` is now an accepted
  peer rather than an implicit mismatch. No runtime peer ranges changed; the remaining install-time
  peer warnings are dev-toolchain-only (`react-native@0.79` requires React 19; Expo's CLI pulls a
  transitive `react-dom@19`) and are shared with the `agora-sdk` fork — not emitted by `@agora-sdk/core`
  (which itself peers `react ^18 || ^19`).
- **CI push trigger fixed (`ci.yml`: `branches: [main]` → `[root]`).** This repo's trunk is `root`, so
  the push-CI job never ran; it now runs on trunk pushes. The Node test matrix stays `[20, 22]`.

### Deprecated

- **Passphrase→server key-material backup (`exportBackup` / `importBackup` / `PassphraseBackup`).**
  Tagged `@deprecated` on the `SecureChatCrypto` interface (no behavior change, no removal). Recovery is
  now device-to-device via IUC, and local at-rest protection is provided by the new
  `createEncryptedStore` decorator. Full removal is a separate cleanup (it also touches the crypto
  interface and agora-server's test devDependency).

### Fixed

- **Real-MLS tests (ts-mls) failed under Node 20 in CI — `crypto.subtle.importKey` cross-realm error.**
  The hook/browser-runtime tests that exercise the real **ts-mls** crypto run under jsdom, but vitest
  executes each test module in its own vm realm whose `ArrayBuffer` / `Uint8Array` intrinsics differ
  from Node's main realm — where `crypto.subtle` lives. ts-mls / `@hpke` / `@noble` build key material
  with the vm-realm constructors and hand a *bare* `ArrayBuffer` to `importKey`; **Node 20** brand-checks
  it with `instanceof` against its own `ArrayBuffer` and rejects the cross-realm value (`"2nd argument is
  not instance of ArrayBuffer, Buffer, TypedArray, or DataView"`). Node 22 relaxed that check, so the
  failure was Node-20-only and invisible locally. A real browser has a single realm, so this can never
  happen in production — it is purely a split-realm test artifact. Fixed with a vitest `setupFiles`
  (`test-support/jsdom-webcrypto-realm.ts`) that restores Node's `ArrayBuffer` + `Uint8Array` as the test
  globals, so binary values share Node's WebCrypto realm (a no-op under the `node` environment). The full
  suite now passes on both Node 20 and Node 22; **no product or crypto code changed.**
- **A message sent after reload was rejected by the peer as a replay (`"Desired gen in the past"`).**
  An MLS application message advances the leaf's single-use **send ratchet**, but the SDK only persisted
  group state on join/Commit — never after a send. So on reload the SDK re-imported the pre-send state,
  the send ratchet rewound to an already-consumed generation, and the next message reused a generation
  the peer had already seen → the peer's secret-tree refused it as a replay (surfacing in the demo as
  "⚠️ couldn't be verified (replay)"). Fixed by persisting group state after every send/receive (see
  *Changed*) and by decrypting each message exactly once into the durable plaintext store (see *Added*),
  so own/peer history renders from the store instead of replaying the consumed ratchet. Regression
  covered end-to-end with real ts-mls + IndexedDB in `react-js/src/browser-runtime.test.tsx` (Alice
  reloads, sends again, Bob decrypts `ok`; Alice's own history restores from the store without
  re-decrypting). Forward secrecy is preserved — each message's key is still consumed exactly once.
- **Message stuck on "⏳ waiting for key update" even though its group had resolved.** `useSecureMessages`
  decrypted against a `group` captured in its closure, so a message page whose fetch finished *after*
  `resolveGroup` succeeded decrypted against the stale `null` and stranded as `pending` — and nothing
  re-triggered it (the retry effect fires on a `group` *change*, which had already happened while the
  list was empty). Compounding it, MLS application-message keys are single-use (forward secrecy), yet
  the hook decrypts the same message from several effects (load, retry, live echo) that React StrictMode
  double-invokes — so the one-time key could be consumed on a run whose result was then discarded. Fixes:
  (1) `decrypt` reads the **live group via a ref**, so a late-finishing load decrypts with the current
  handle; (2) a **decrypt-once cache** (by message id) returns the single successful decode to every
  later caller, so the forward-secret key is consumed exactly once and never lost on a discarded/double
  invocation; (3) both merge paths (live-receive, older-page load) keep the more-resolved copy via a
  `preferResolved` helper — a successful `ok` is never overwritten by a later failed re-attempt; a row's
  status may only improve. Three regression tests: a late-finishing load still decrypts; a live message
  UPGRADES a row that resolved to `rejected`; the row stays a single React key. Also added a `provider`
  debug log (`resolveGroup`: no-state / imported / import-FAILED) so a group that's persisted-but-
  unreadable is visible instead of silently degrading to "waiting for key update".
- **Recipient stuck on "⏳ waiting for key update" forever (KeyPackage private keys lost on reload).**
  `useSecureDevice.publishKeyPackages` generated KeyPackages — whose **private** keys land only in the
  crypto's in-memory store — and uploaded the public halves, but never re-persisted device state
  afterward. `register()` persists, but runs *before* any KeyPackages exist. So after a reload,
  `importDeviceState` rehydrated a device-state snapshot with **no** KeyPackages; a peer who claimed one
  of the published KeyPackages and built a Welcome from it then hit `processWelcome` →
  "no matching KeyPackage", and the recipient could never join (every DM opened to them after their
  reload stayed undecryptable, surviving further reloads). `publishKeyPackages` now re-exports +
  `saveDevice`s device state immediately after generating KeyPackages, so their private keys are
  durable. This was invisible to the single-process test harness, which only re-read already-joined
  history after a reload; a new `react-js/browser-runtime` regression (register → publish → **reload** →
  receive a *new* Welcome) reproduces it (fails before, passes after), plus a `useSecureDevice` unit test.
- **A failed *for-us* Welcome no longer permanently strands the recipient (self-heal on retry).**
  `useSecureHandshakes` advanced and persisted the delivery cursor even when `dispatchByKind` threw —
  intended as poison-blob protection, but for a Welcome **addressed to this device** it moved the cursor
  *past* the Welcome, so catch-up's strictly-greater `since=cursor` never re-served it and a single
  transient `processWelcome` failure stranded the recipient forever. Now a for-us Welcome that throws
  **holds** the cursor (it is not advanced) so the next catch-up / reload / `resync()` retries, bounded
  by an in-session retry cap so a genuinely-poison Welcome can't wedge the inbox; genuinely-skippable
  rows (a Welcome not for us, a Commit for an unknown group) still advance as before. New
  `useSecureHandshakes` tests cover the hold-then-join and the bounded-skip; the prior "throwing row
  advances" test now targets a Commit (the still-skippable class).
- **De-flaked the argon2id backup-envelope test (`ts-mls/backup.test.ts`).** The "emits a real envelope"
  case asserted the ciphertext, decoded as UTF-8, did `not.toContain("x")` — a non-deterministic check
  that failed whenever a random ciphertext byte happened to be `0x78`. Replaced with deterministic
  byte-level assertions: the blob differs from the plaintext bytes and is exactly `plaintext.length + 16`
  (the appended poly1305 tag). Same intent ("the blob is ciphertext, not plaintext"), no randomness.
- **Closed the last non-deduped merge path in `useSecureMessages` (React duplicate-key).** 0.6.5 fixed
  the optimistic-send add and the live-receive path to dedup by id, but `load`'s older-page append
  (`loadMore`, pagination) still concatenated unconditionally — so a row already in state (one that
  arrived live, or an overlap at the page boundary) could be appended a second time, producing two
  children with the same React `key`. The append now filters out ids already present (the `reset`
  reload replaces wholesale and can't duplicate), bringing all three merge paths — load, live-receive,
  optimistic-send — to the same by-id dedup invariant: exactly one row per id.
- **Silenced the leaked stderr `Error:` dumps from the two "used outside its provider" negative tests**
  (`social-context.test.tsx`, `secure-chat-context.test.tsx`). The tests assert that `useSocial` /
  `useSecureChat` throw when rendered with no provider and already mocked `console.error`, but the throw
  still spammed stderr: React 18's dev build re-dispatches a render-time throw onto a detached DOM node,
  and jsdom catches it and reports via its `jsdomError` virtual-console channel — separate from
  `console.error`. Each test now also installs a one-shot `window` `error` listener that calls
  `preventDefault()` (jsdom's `reportException` honors `defaultPrevented`), so the suite output is clean.
  No production code changed; the assertions are unchanged.

## [0.6.5] — 2026-06-17

### Added

- **Exported `VERSION` constant (`@agora-sdk/secure-chat-core`, re-exported by the platform packages).**
  The published `major.minor.patch` string, so an app can log/confirm which SDK build it actually
  loaded at runtime (handy when a stale bundle is suspected). It's **generated from the package's
  `package.json`** by `scripts/write-version.mjs` and regenerated by `version:patch` / `version:minor`,
  so it can't drift; a unit test guards `VERSION === package.json.version`.

### Fixed

- **A sent message could duplicate (React duplicate-key) and flash as `rejected` in `useSecureMessages`.**
  The server stores a sent message once and echoes that same row back over `secure:message`; because a
  sender cannot decrypt their own MLS application message, the echo decrypts as `rejected`. The
  live-receive path dedups by id, but the **optimistic-send add did not** — so when the echo won the race
  against the HTTP send response (common on localhost), the rejected echo was added first and the
  optimistic `ok` copy was then prepended as a *second* row with the same id (two children with the same
  React `key`). The optimistic add now dedups by id while prepending (drops any prior echo, keeps the
  authoritative `ok` copy), so the list holds exactly one row per id in **both** orderings and the user
  never sees their own message as `rejected`. Regression test reproduces the echo-first race.

## [0.6.4] — 2026-06-17

### Fixed

- **Stale handshake cursor masked a re-registered device's own Welcome (recipient never joined).** The
  delivery cursor was persisted under one global key (`handshake:cursor`), untethered from the device it
  belonged to. After a server wipe / device revoke + re-register, the new device row (a fresh server UUID)
  inherited the dead device's cursor; because the blind DS `seq` is a global Postgres sequence that
  survives a `DELETE`, the new Welcome could land on exactly the stale cursor's `seq`, and the handshakes
  query (`seq > since`, strictly greater) then dropped it — so the recipient fetched its inbox, skipped its
  own Welcome, never built the MLS group, and the conversation rendered one-sided. The cursor is now
  **scoped by device row id** (`handshake:cursor:<rowId>`): a re-registered device gets a new key ⇒ a fresh
  `null` cursor ⇒ it fetches `since=undefined` and receives its Welcome. `loadHandshakeCursor` /
  `saveHandshakeCursor` take the row id (the value `useSecureHandshakes` already resolves before draining);
  the effect's dep on the row id re-runs catch-up clean on re-registration. Also closes a latent
  multi-device data-loss bug (two device rows sharing one store clobbered each other's cursor). Locked by
  repository + `useSecureHandshakes` regression tests (a stale cursor under a different row id no longer
  masks the Welcome; catch-up fetches `since=undefined`). Server unchanged — its strictly-greater
  semantics are correct.

- **Device churn + server split-brain in `useSecureDevice`.** Two related causes of a brand-new server
  device row on every reload are fixed. (1) **StrictMode dead-closure:** the mount effect's superseded
  (dev double-invoke) run called `setLoading(false)` while `device` was still null, so the app's
  `if (!loading && !device) register()` bootstrap fired a spurious registration before the live remount
  could re-hydrate — a superseded run now bails without touching state. (2) **Split-brain reconcile:** a
  device persisted locally whose server row is gone (DB wiped / revoked) was adopted blindly, leaving
  every device-scoped call 404ing forever with no recovery (the `!device ⇒ register()` path never fires
  because `device` looks set). Both the mount effect and `register()` now verify server-side first via
  the new `SecureChatRestClient.deviceExists()` (probes the device-scoped key-package count; a definitive
  `404 secure-chat/device-not-found` ⇒ wipe all local state via `repo.clearAll()` and re-register clean;
  a transient probe error keeps the identity for offline tolerance). `register()` also gains an
  idempotency guard: if a usable persisted device exists, it re-imports and adopts instead of minting a
  new identity, so repeated calls yield one device, not one per call.

## [0.6.3] — 2026-06-17

### Fixed

- **`/secure` socket connected to the wrong namespace — realtime never worked.** `SecureChatSocketClient.connect()`
  built the socket URL from `getSocketUrl()` (the REST base, e.g. `http://host/v7`) and only stripped a
  trailing slash, so `io(`${base}/secure`)` requested namespace `/v7/secure`. socket.io derives the
  namespace from the URL path, and the server registers `io.of("/secure")` — so every connect was
  rejected as *Invalid namespace* (5× `connect_error`, zero `/secure` connections). Now strips to the
  bare origin via `new URL(getSocketUrl()).origin`, so the namespace is exactly `/secure`,
  correct-by-construction (no caller can re-leak the `/v7` path). Diagnosed by the agora-server team;
  server needs no change. Locked by new `socket.test.ts` cases asserting the bare-origin `/secure` URL
  (and never `/v7/secure`).

## [0.6.2] — 2026-06-17

### Added

- **Unit tests for the `SecureChatRestClient` transport (`transport/rest.test.ts`).** Closes the
  largest coverage gap — the wire boundary to the blind Delivery Service previously had zero unit
  tests. 27 cases cover all 17 endpoints (method + path with `encodeURIComponent` on ids, the query
  params / request body emitted, and how each response shape is unwrapped), the cross-cutting
  interceptor behaviour (lazy `{base}/{projectId}/secure-chat` composition + trailing-slash strip,
  lazy `Bearer` token resolved per request so a refresh takes effect, header omitted when signed out),
  and the error contracts callers depend on (`getKeyBackup` → `null` on 404 but re-throws a 500;
  `claimKeyPackage` / `removeMember` propagate `409`). The client's real request/response interceptors
  run against an injected axios adapter, so the test exercises actual wiring rather than a stub.
- **Dev-only trace/debug logging for the secure-chat sync internals.** A tiny, dependency-free logger
  (`packages/secure-chat/core/src/util/debug.ts`) that is **off by default** and short-circuits on a
  single boolean when disabled, so a shipped build logs nothing and pays nothing. Toggle it at runtime
  with the new exports `setSecureChatDebug(on, level?)` / `isSecureChatDebugEnabled()`, or via the
  `AGORA_SECURE_CHAT_DEBUG` env var / `globalThis.__AGORA_SECURE_CHAT_DEBUG__`. Two levels: `debug`
  (greppable status lines — method/url/status, seq, epoch, counts, decrypt outcome) and `trace` (full
  raw payloads). It is a **development aid only** and makes no redaction guarantees — keep it off in
  production. Instrumented the sync/failure-prone paths: the REST client (one request/response/error
  trace site covering all endpoints, via interceptors), the `/secure` socket lifecycle + room joins,
  and the `useSecureHandshakes` (catch-up loop, per-handshake dispatch, dedupe, live-buffer replay,
  cursor advance), `useSecureMessages` (page load, decrypt outcome, send, live de-dup), and
  `useSecureDevice` (register, re-hydrate, KeyPackage replenishment) hooks. Unit-tested for the
  silent-by-default contract and faithful raw output when on.

### Changed

- The "throws when used outside the provider" negative tests (secure-chat + social contexts) now
  swallow React's expected error-boundary `console.error` with a scoped, restored spy, so a passing
  `pnpm test` no longer prints an alarming error block for an assertion that is working as intended.

## [0.6.0] — 2026-06-16

### Added

- **Social graph package group (`@agora-sdk/social-*`).** A new additive feature exposing Agora's
  community social graph (`docs/SOCIAL.md`) — the three member-facing lenses (Weather, Constellation,
  Neighborhood) plus the Transparency endpoint — mirroring the `secure-chat` core+platform layout. No
  crypto, persistence, or realtime: social data is public/server-side and slow-moving.
  - `@agora-sdk/social-core` — typed `SocialRestClient` (throws a `SocialApiError` carrying HTTP
    `status` + the server's machine `code`), a `SocialProvider` that auto-fetches `/social/transparency`
    on mount and treats `503 social/graph-unavailable` as an all-disabled sentinel, and four
    feature-gated hooks (`useSocialWeather`, `useSocialConstellation`, `useSocialNeighborhood` with an
    `includeInteractions` toggle, `useSocialTransparency`). The lens hooks **fail soft** on `SOCIAL.md`
    §7 degradation: a `social/graph-unavailable` or `social/<surface>-disabled` error (classified by the
    exported `isSocialDegradation(err)`) hides the surface — clears its data and is *not* surfaced via
    `error` — so a lens toggled off or a graph dropped mid-session disappears rather than erroring at
    members; real failures still propagate.
  - `@agora-sdk/social-react-js` — web components `<CommunityWeather />` (band + subtle trend cue),
    `<Constellation />` (d3-force blob canvas, positions re-randomized every mount), `<Neighborhood />`
    (brightness-as-glow tie list with a hopeful "sprout" state), and `<SocialTransparency />`, sharing a
    single climate palette that enforces the privacy invariants (never render brightness numbers / exact
    counts, warmth-only tints, no red for low warmth).
  - `@agora-sdk/social-react-native` — native visual components (`<CommunityWeather />`,
    `<Constellation />`, `<Neighborhood />`, `<SocialTransparency />`) built on React Native primitives
    + `react-native-svg` (gradient orb + d3-force blob field) and the same `useSocial*` hooks. The
    privacy-critical palette and brightness mapping are **ported** from the web sibling — identical §5
    band colors and §6 thresholds (`isSprout` floor at `0.24`, layout re-randomized every mount,
    warmth-only tints, brightness never rendered as a number), with `brightnessTreatment` returning RN
    shadow/elevation props instead of CSS `box-shadow`. `react-native-svg` is a peer dependency.
  - `@agora-sdk/social-expo` — thin re-export of `@agora-sdk/social-react-native` (the visual
    components have zero Expo-vs-bare-RN difference), so an Expo app gets the same drop-in components.
  - Wire types come from `@agora-server/contract@^0.12.1` (which publishes the social surface):
    `social-core/src/contract/` is a thin **type-only re-export** (one source of truth, zero drift),
    mirroring `secure-chat-core`. The three runtime const arrays (`WEATHER_BANDS`, `BLOB_SIZE_BUCKETS`,
    `NEIGHBORHOOD_TIE_KINDS`) are re-declared locally and typed against the contract's unions, so core's
    CJS build never `require()`s the ESM-only contract.

## [0.5.0] — 2026-06-16

### Added

- **Ciphertext size-bucket padding (Phase 2 task 6a).** Outbound message plaintext is now wrapped in a
  self-describing frame (`[version][contentLen][content][zero pad]`) and zero-padded up to a fixed size
  bucket **before** MLS encryption, so the ciphertext length leaks less traffic shape to the blind
  server (the Signal-model metadata concession). New dependency-free codec
  `@agora-sdk/secure-chat-core` `util/padding` (`padPlaintext`/`unpadPlaintext`/`nextBucket`,
  `PaddingPolicy`); ladder is `32,64,…,8192` then 8 KiB multiples. `useSecureMessages` pads on send and
  strips on receive — an authenticated message with a bad frame fails closed as `rejected`/`malformed`
  rather than rendering raw bytes. Configurable via the new `<SecureChatProvider padding>` prop
  (`"ladder"` default, `"none"` = frame-only). No server changes.
- **Safety number / key verification (Phase 2 task 6b).** A new headless primitive for out-of-band
  identity-key verification (TOFU hardening against a blind-but-untrusted server swapping a KeyPackage).
  New seam method `SecureChatCrypto.exportGroupIdentities(group)` (+ `GroupMemberIdentity` type) lists a
  group's members' **public** signature keys from the local MLS roster (implemented in the ts-mls core
  and the mock). New pure `@agora-sdk/secure-chat-core` `util/safety-number` `computeSafetyNumber(a, b)`
  derives a Signal-style **60-digit** number (12 groups of 5) symmetrically (sorted so both sides match)
  via iterated SHA-256, plus raw fingerprint bytes for a QR. New `useSecureSafetyNumber(conversationId)`
  hook resolves the DM roster and returns the comparable number (null for non-DM / unresolved groups).
  All client-side; no server changes.

- **KeyPackage replenishment tuning (Phase 2 task 3).** `useSecureDevice` now keeps the single-use
  KeyPackage stock topped up smarter and from more triggers. New configurable `keyPackageLowWater`
  option (default `ceil(keyPackageTarget / 2)`, i.e. 10 for the default target of 20): when the server
  count drops below it, the client tops up **to the target by publishing only the deficit** (using the
  actual `available` count) instead of the old blind full-batch publish on every `secure:key-packages-low`
  signal. Replenishment now also runs **proactively** — a one-shot count check once the device is ready
  (self-heals a client that missed the realtime signal while offline) — and on demand via a new
  `checkAndReplenish()` (safe to call before `register()`; no-ops to 0) so an app can wire it to
  window-focus / app-foreground. No server changes.

- **Passphrase backup / restore (Phase 2 task 5).** Real at-rest crypto for key-material backups: a
  new envelope codec in `@agora-sdk/secure-chat-crypto/ts-mls` (`backup.ts` — `sealBackup`/`openBackup`)
  using **argon2id** (RFC 9106 high-memory profile: m=64 MiB, t=3, p=1, 32-byte key) +
  **xchacha20poly1305** (24-byte random nonce, 16-byte random salt), with the stable scalar envelope
  descriptors (`version`/`kdf`/`cipher`) bound as AEAD associated data so a downgrade/tamper of any of
  them fails closed. `kdfParams` is deliberately **not** in the AAD: the blind server stores it as
  Postgres `jsonb`, which does not preserve object key order, so a `JSON.stringify(kdfParams)`-based
  AAD would differ between seal and open and break a valid backup across a DB round-trip — the `salt`
  is already bound implicitly (it's a KDF input) and the cost params are pinned on open. The ts-mls
  core's `exportBackup`/`importBackup` now implement this for real (previously
  threw), sealing the device identity + every joined group's MLS state and restoring them on a fresh
  instance.
- **`useSecureBackup` hook (`@agora-sdk/secure-chat-core`).** `backup(passphrase)` exports + uploads
  the encrypted blob (base64 at the wire boundary) to the blind server; `restore(passphrase)` fetches
  it, re-derives the identity + groups, idempotently re-asserts the device to recover its server row,
  persists the device, and rebinds each conversation's group state by `conversationId` from the
  server's conversation list (the server is the source of truth for membership). Exposes `needsBackup`
  (a stale-backup signal that flips when a group advances), `backingUp`/`restoring`/`error`/
  `lastBackupAt`, and `estimateStrength`.
- **`estimatePassphraseStrength` (`@agora-sdk/secure-chat-core`).** A small, dependency-free 0–4
  passphrase-strength estimator (length + character-class diversity + common-password penalty) for a
  backup-passphrase meter — the blind server holds the ciphertext, so a weak passphrase is
  offline-brute-forceable on a DB exfil (spec §16.5).
- **Eviction recovery (Phase 2 task 2.4).** `useSecureBackup` now detects an evicted/fresh client on
  mount — no local key material but a backup exists on the server (Safari ITP, "clear browsing data",
  or a new browser are indistinguishable and resolve the same way) — and exposes `needsRestore` (plus
  `checkingRestore` and an on-demand `recheckRestore()`), so the app routes to a passphrase prompt →
  `restore()` instead of registering a fresh, history-less identity. The check only hits the server
  when local state is gone (the healthy path stays a single IndexedDB read) and fails soft on a network
  error.
- **Generation-counter replay/gap enforcement, surfaced (Phase 2 task 1.3).** ts-mls's secret-tree
  ratchet is the enforcement point (rejects replayed generations, bounds the forward gap, tolerates
  in-window reorder); the SDK now **pins** that with characterization tests and **classifies + surfaces**
  the rejection instead of silently swallowing it. New `SecureChatDecryptError` (with a
  `SecureDecryptFailureReason`: `replay` / `gap-too-large` / `epoch-too-old` / `unauthenticated` /
  `malformed` / `unknown`), thrown by `decryptMessage` (fail closed). `DecryptedSecureMessage` gains a
  `status` (`ok` | `pending` | `rejected`) + `rejectedReason`, so the app can show a "couldn't be
  verified" marker. New optional `keyRetention` knob on `createTsMlsSecureChatCrypto` /
  `createWebSecureChatCrypto` (ts-mls `maximumForwardRatchetSteps` / `retainKeysForGenerations` /
  `retainKeysForEpochs`) to tighten the window; it's threaded consistently through created, joined,
  imported, and restored groups (survives a persistence round-trip).

### Changed

- **`SecureChatCrypto.importBackup` now returns `Promise<DeviceIdentity>`** (was `Promise<void>`),
  symmetric with `importDeviceState`, so the restore flow can re-assert the device server-side and
  recover its row. Both the ts-mls core and the mock implement the new return. Deliberate, documented
  in-repo seam change (the seam is owned here) — no cross-repo coordination.
- **`useSecureMessages` fails closed on rejected messages.** A message the MLS core refuses (replay,
  over-window gap, bad auth, malformed, too-old epoch) is now marked `status: "rejected"` and is **never
  re-decrypted** on a group advance. Only genuinely future-epoch (`pending`) rows are retried — the old
  code swallowed every failure into `plaintext: null` and retried them forever, masking replays/forgeries
  as merely "buffered."

### Not yet implemented

- 409 epoch-conflict rebase on membership commits (the `resync()` seam is in place);
  `removeMember`/membership churn + multi-device + native (Phase 3).

## [0.4.0] — 2026-06-08

### Added

- **Real MLS core (Phase 2 task 1).** `@agora-sdk/secure-chat-crypto/ts-mls` —
  `createTsMlsSecureChatCrypto()`, a real RFC 9420 implementation of `SecureChatCrypto` built on
  **ts-mls** (pure TS; ciphersuite 1), on an opt-in **ESM-only** subpath so the bare entry + `./testing`
  mock stay dependency-free. Recipients join from the Welcome alone (ts-mls `ratchetTreeExtension`);
  group + device state persist via ts-mls's `encodeGroupState`/`decodeGroupState` into the existing
  IndexedDB layer (no persistence-layer changes). `react-js`'s `createWebSecureChatCrypto()` now returns
  it. Proven by running the foundation e2e a second time with the real core (genuine MLS blobs through
  the blind server; recipient joins from the Welcome alone) — `pnpm test:e2e` now runs mock + ts-mls
  (14 tests). Pulls `ts-mls` + the `@noble/*` primitives it needs (ts-mls leaves `@noble/hashes`
  undeclared). Backup KDF (task 5), metadata padding (task 6), generation-counter enforcement, and
  `removeMember`/native (Phase 3) remain deferred.

- **Foundation-validation e2e (test infra).** An opt-in Node suite (`e2e/secure-chat.e2e.ts`,
  `e2e/bootstrap.ts`, `vitest.e2e.config.ts`, `pnpm test:e2e`) that drives the **real**
  `SecureChatRestClient` + `SecureChatSocketClient` against a **locally running agora-server** with
  `MockSecureChatCrypto` and two simulated devices. It proves the full round-trip end to end —
  register → publish KeyPackages → start DM → recipient joins via the handshake inbox → send →
  receive+decrypt → **server stored only ciphertext** → live `/secure` realtime fan-out → fresh-client
  cursor catch-up (reload-survives). Gated on `AGORA_E2E_DATABASE_URL` so the default `pnpm test`
  and CI stay server-free; it imports the transport source directly (no `@agora-sdk/core`, no React),
  which also confirms the transport path loads under plain Node ESM. Adds devDeps `pg` + `jose`
  (direct DB seeding + token signing, mirroring agora-server's integration helpers).

### Changed

- **Wire types now come from the published `@agora-server/contract`** (`^0.9.3`, a `dependency` of
  `@agora-sdk/secure-chat-core`). The former byte-faithful stand-in copy in
  `core/src/contract/` is replaced by a thin **type-only re-export** of the contract's secure-chat
  surface — one source of truth, zero drift. (The contract added the request-body types via `z.input`
  of its zod schemas in 0.9.3, so the SDK no longer hand-maintains any wire types.) The re-export is
  type-only, so core's dual ESM/CJS build never `require()`s the ESM-only contract at runtime; the
  internal import path is unchanged, so call sites didn't churn. Verified by typecheck + unit +
  build-all + verify:dist + the dual mock/ts-mls e2e.
- **`@agora-sdk/secure-chat-react-js` is now ESM-only.** It depends on the ESM-only ts-mls core and
  on bundler-only `@agora-sdk/core` (see `UPSTREAM_FIX.md`), so its CJS output never loaded at runtime;
  dropping it removes a misleading artifact. Web/React consumers always bundle (Vite/webpack/Metro).
  `verify-dist` now allows ESM-only packages (detected by an ESM `main`). `react-native`/`expo` stay dual.
- **Engineering standards now lead with security.** `CLAUDE.md` adds a new enforced standard #1,
  "Security first — this is end-to-end-encryption code" (no plaintext/keys on the wire or in logs,
  respect the crypto seam + CSPRNG, preserve epoch/replay invariants, fail closed, treat the server as
  blind/untrusted, real KDF for backups, pinned crypto deps, flag ambiguities), and renumbers the
  existing TSDoc / comments / changelog / tests standards to #2–#5.

### Fixed

- **`/secure` socket join payloads were a bare string, not an object.** `SecureChatSocketClient`
  emitted `join:secure-conversation` / `join:secure-device` with a bare id, but the server
  destructures `{ conversationId }` / `{ deviceId }` off the payload — so the room join silently
  no-op'd (no realtime delivery) and a `null` payload could even crash the server process. Now emits
  the object shape; `SecureClientEvents` is corrected to match `SecureClientToServerEvents`. Caught by
  the new e2e (the realtime fan-out step) and locked by a `socket.test.ts` regression.

## [0.3.0] — 2026-06-07

### Added

- **Handshake processing (Phase 2 Task 4)** — `useSecureHandshakes`, the recipient side of secure
  chat. On connect it drains the device's handshake inbox (`fetchHandshakes(since=cursor)`, paged) and
  then processes live `secure:welcome` / `secure:handshake` events, all funneled through one
  serialized, `seq`-ordered, idempotent path that persists the delivery cursor. A processed Welcome
  joins the group (`rememberGroup`) + joins its socket room; a Commit advances the epoch; live events
  arriving during catch-up are buffered and replayed in `seq` order so none are dropped. Known rooms
  are re-joined after a reload. Plus a provider group-version signal (`getGroupVersion` /
  `subscribeGroupChange`, bumped by `rememberGroup`) that `useSecureMessages` subscribes to, so a
  join/Commit flushes buffered (`plaintext: null`) rows in place — no re-fetch. Exposes a `resync()`
  primitive for the future 409 epoch-conflict rebase.

## [0.2.0] — 2026-06-07

### Added

- Initial monorepo scaffold for **Agora SDK Plus** — additive, Agora-only SDK features built on
  `@agora-sdk/*`, kept out of the agora-sdk Replyke fork.
- `@agora-sdk/secure-chat-crypto` — the `SecureChatCrypto` seam (interface + types on the main entry;
  the deterministic `MockSecureChatCrypto` on the `./testing` subpath). Apache-2.0 and
  dependency-free; this is the home of record for the client crypto (the real ts-mls/OpenMLS cores
  land here in Phase 2). Relocated from agora-server, where it was test-only client code.
- `@agora-sdk/secure-chat-core` — platform-agnostic client for Agora's end-to-end-encrypted chat
  (MLS / RFC 9420): typed REST client + `/secure` socket.io transport, `SecureChatProvider` +
  `useSecureChat`, and the `useSecureDevice` / `useSecureConversations` / `useSecureMessages` hooks.
  Crypto is supplied by dependency injection of a `SecureChatCrypto`.
- `@agora-sdk/secure-chat-react-js` (Phase 2, web), `@agora-sdk/secure-chat-react-native` and
  `@agora-sdk/secure-chat-expo` (Phase 3 stubs) — platform packages re-exporting core.
- Stand-in in-repo copy of the secure-chat wire types, to be replaced by a dependency on the
  server's `@agora-server/contract` (Apache-2.0) once it's published — the dependency arrow is SDK →
  contract (see `STATUS.md`).
- Docs: `packages/secure-chat/ROADMAP.md` — the SDK team's Phase 2/3 task checklist with a per-file
  map of the scaffold (the counterpart to agora-server's `CHAT_TODO.md`).
- TSDoc/TypeDoc doc comments on the original public API — `SecureChatProvider`, `useSecureChat`,
  the `useSecure*` hooks, `SecureChatRestClient`, `SecureChatSocketClient`, and their option/return
  types. The transitional contract/crypto-interface copies are intentionally left undocumented to
  stay byte-faithful to the agora-server source.
- `CLAUDE.md` "Engineering standards (enforced)" section — required clauses for TSDoc on public
  exports, intent-explaining comments, changelog discipline, and unit tests (with `MockSecureChatCrypto`).
- **vitest** test harness — root `vitest.config.ts` (globs `packages/**/src/**/*.test.{ts,tsx}`,
  node env, aliases the workspace crypto package to source) plus `test` / `test:watch` scripts;
  `*.test.ts(x)` excluded from every package's `tsc` build. First tests: `base64` wire-boundary
  round-trips (`@agora-sdk/secure-chat-core`) and a two-party `MockSecureChatCrypto` DM flow incl.
  plaintext-hiding + passphrase backup/restore (`@agora-sdk/secure-chat-crypto`).
- `ARCHITECTURE.md` — visual companion to CLAUDE.md: mermaid package graph, layers/seams, and
  runtime sequence flows (start-DM, send/receive, persistence). Cross-linked from CLAUDE.md + README.
- Design spec for the Phase 2 persistence layer (`docs/superpowers/specs/2026-06-06-secure-chat-persistence-design.md`),
  with mermaid wiring + reload-survive diagrams — generic key→blob store seam, typed repository,
  provider-injected store with a cached `resolveGroup`, and an `exportDeviceState`/`importDeviceState`
  addition to the crypto seam.
- **GitHub Actions** — `.github/workflows/ci.yml` (typecheck + test + build-all on push to `main`
  and all PRs, Node 20 & 22) and `.github/workflows/publish.yml` (on a `v*` tag: re-run the CI gate,
  then `pnpm -r publish` all packages with provenance; dist-tag by suffix — `vX.Y.Z` → `latest`,
  `vX.Y.Z-<pre>` → `beta`). Requires an `NPM_TOKEN` repo secret. Pinned `packageManager`
  to `pnpm@10.14.0` so runners match local.
- **Persistence layer (Phase 2)** — `SecureChatStore` key→blob seam + `MemoryStore` (core),
  `SecureChatRepository` typed façade, provider-injected `store` with a cached `resolveGroup` /
  `rememberGroup`, and `createIndexedDBStore()` (react-js). The three hooks are now self-sufficient:
  device identity + stable `deviceId` persist and re-hydrate, created groups persist, and
  `useSecureMessages` auto-resolves the group handle + sender device. Adds
  `exportDeviceState`/`importDeviceState` to the `SecureChatCrypto` seam. Plaintext at rest on web
  (documented); backup-restore eviction recovery and handshake processing stay deferred (tasks 5, 4).

### Changed

- The eventual contract dependency is now named **`@agora-server/contract`** (was `@agora/contract`)
  — updated across docs (`CLAUDE.md`, `STATUS.md`, `ARCHITECTURE.md`, `ROADMAP.md`) and the in-repo
  stand-in header (`packages/secure-chat/core/src/contract/index.ts`). The dependency arrow
  (SDK → contract) and the byte-faithful stand-in plan are unchanged; only the package name to depend
  on / import from once it publishes.

### Fixed

- `useSecureMessages` now decrypts conversation **history** after a reload, not just new sends. The
  first page loads while `resolveGroup` is still in flight, so those rows arrived `plaintext: null`
  and never re-decrypted; the hook now re-decrypts the undecrypted rows in place once the group handle
  resolves (no re-fetch, scroll/pagination preserved). Surfaced by a new end-to-end reload test that
  drives a *fresh* crypto instance through `importDeviceState` + `importGroupState`.
- Root `pnpm run typecheck` no longer requires a prior `build-all`: it resolves the in-repo
  workspace packages to their source via `tsconfig` `paths`, so a fresh checkout (and CI) typechecks
  without first emitting each package's `dist/*.d.ts`.
- **Broken ESM/CJS package output (all packages).** `tsc` emitted extensionless relative imports
  (e.g. `export … from "./mock-crypto"`), which Node's ESM resolver rejects — so
  `@agora-sdk/secure-chat-crypto`'s `./testing` entry (and every other relative import) failed to
  load for ESM consumers. Fixed by writing explicit `.js` extensions on all relative specifiers in
  source (`./contract` → `./contract/index.js`). Additionally, because each package is
  `"type": "module"`, the `dist/cjs/*.js` CommonJS output was being parsed as ESM; `build:cjs` now
  emits a `dist/cjs/package.json` (`{"type":"commonjs"}`) so the CJS entry resolves too.
- Added `scripts/verify-dist.mjs` (`pnpm run verify:dist`, run after `build-all` in CI and publish):
  static-lints emitted ESM for extensionless relative imports, checks the CJS type marker, and
  load-tests the dependency-free `crypto` package in both ESM and CJS — so a broken dist can never be
  published again.
- Documented [`UPSTREAM_FIX.md`](UPSTREAM_FIX.md): the upstream `@agora-sdk/core@1.2.2` is unloadable
  (no `exports` map, extensionless ESM imports, no CJS type marker) — the same bug class — which
  blocks `secure-chat-core` + platform packages at runtime until the agora-sdk repo is fixed and
  republished. `secure-chat-crypto` is unaffected.
