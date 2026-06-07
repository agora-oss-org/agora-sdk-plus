# Changelog

All notable changes to Agora SDK Plus are documented here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
  server's `@agora/contract` (Apache-2.0) once it's published — the dependency arrow is SDK →
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

### Fixed

- Root `pnpm run typecheck` no longer requires a prior `build-all`: it resolves the in-repo
  workspace packages to their source via `tsconfig` `paths`, so a fresh checkout (and CI) typechecks
  without first emitting each package's `dist/*.d.ts`.

### Not yet implemented

- Real MLS `SecureChatCrypto` (ts-mls / OpenMLS-WASM); IndexedDB group-state persistence;
  KeyPackage replenishment loop; passphrase backup/restore UX.
