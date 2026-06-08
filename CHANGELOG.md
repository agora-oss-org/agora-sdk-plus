# Changelog

All notable changes to Agora SDK Plus are documented here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

### Not yet implemented

- Real MLS `SecureChatCrypto` (ts-mls / OpenMLS-WASM); KeyPackage replenishment loop;
  passphrase backup/restore UX; backup-restore eviction recovery; 409 epoch-conflict rebase on
  membership commits (the `resync()` seam is in place); multi-device (Phase 3).

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
