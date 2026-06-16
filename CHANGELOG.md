# Changelog

All notable changes to Agora SDK Plus are documented here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
  cursor catch-up (reload-survives). Gated on `AGORA_E2E_TEST_DATABASE_URL` so the default `pnpm test`
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
