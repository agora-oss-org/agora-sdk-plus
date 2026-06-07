# Status & roadmap

A running ledger of what's built, what's stubbed, and the cross-repo work this depends on.

## Built (scaffold)

- Monorepo tooling: pnpm workspace, dual ESM/CJS TypeScript build, root typecheck — mirrors agora-sdk.
- `@agora-sdk/secure-chat-crypto`: the `SecureChatCrypto` seam (interface + types) on the main entry,
  and the deterministic `MockSecureChatCrypto` on the `./testing` subpath. Dependency-free.
- `@agora-sdk/secure-chat-core`: REST transport (all endpoints from `docs/SECURE_CHAT.md` §9),
  `/secure` socket client, `SecureChatProvider` + hooks, base64 utils. Depends on the crypto package
  for the interface; carries a stand-in copy of the wire types.
- Platform packages: `react-js` (Phase 2 web, crypto/persistence placeholders), `react-native` +
  `expo` (Phase 3 stubs).

## The architecture decision (corrected)

The earlier plan — publish `@agora-sdk/secure-chat-contract` + `@agora-sdk/secure-chat-crypto`
*from agora-server* — was **wrong**: it inverted the dependency (server contract depending on an SDK
package) and would have published AGPL crypto. The corrected model, agreed with the server team:

> **The crypto seam is client code; it lives in the SDK. The wire contract stays in the server. The
> arrow is SDK → contract.**

| Artifact | Home | Relationship |
|---|---|---|
| `SecureChatCrypto` interface + mock (+ future ts-mls/OpenMLS) | **this repo** (`@agora-sdk/secure-chat-crypto`, Apache-2.0) | agora-server **dev-depends** on it for tests — a consumer, like agora-demo consumes the published SDK |
| secure-chat wire types (`Secure*Model`, request bodies) | **agora-server** (`@agora/contract`, Apache-2.0) | this SDK **depends on** it; we keep a stand-in copy until it's published |

Why this is right: it removes the dependency inversion, and it dissolves the license problem — the
seam was AGPL-3.0 inside the AGPL server; moved into this Apache-2.0 repo (sole-author relicense) it
becomes safely consumable by third parties.

## Cross-repo follow-up

### agora-server (their side)
- Delete `packages/secure-chat-core/` and point the two integration importers
  (`test/integration/secure-helpers.ts`, `secure-chat-backup.test.ts`) at
  `@agora-sdk/secure-chat-crypto/testing` (a test **devDependency**).
- Publish `@agora/contract` (Apache-2.0) so this SDK can depend on it for the wire types.
- Timing (server team's call): **cleanest** = move now, link/devDepend on the published crypto;
  **pragmatic** = keep the throwaway mock in-repo through Phase 1 (nothing's published yet) and move
  when Phase 2 builds the real core here.
- Update the server's `CHAT_TODO.md` to this model (crypto → SDK; contract stays; SDK builds on it).

### this repo (when `@agora/contract` is published)
- Add `@agora/contract` as a dependency, delete `core/src/contract/`, and repoint imports to
  `import type { ... } from "@agora/contract"`. Re-verify build + typecheck.

## What's next — Phase 2 (web) and Phase 3 (native)

The detailed, actionable task list — the MLS-core decision, persistence, KeyPackage replenishment,
handshake ordering, backup UX, tests, and the per-file map of where each task plugs into the scaffold
— lives in **[`packages/secure-chat/ROADMAP.md`](packages/secure-chat/ROADMAP.md)**. That's the SDK
team's checklist; this file stays the present-state + cross-repo ledger.

In short: Phase 2 makes the crypto real (implement `SecureChatCrypto` in
`@agora-sdk/secure-chat-crypto`, wire it + IndexedDB into `@agora-sdk/secure-chat-react-js`) and
persists group state; Phase 3 brings native (RN/Expo keystore, multi-device). Open design questions
(channel committer, padding, replay detection) are tracked in the roadmap.
