# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

**Agora SDK Plus** is the home for **additive, Agora-only SDK features** — capabilities that have
**no upstream Replyke counterpart** and therefore must NOT live in the
[agora-sdk](https://github.com/jenova-marie/agora-sdk) fork (whose entire value is staying a tiny,
documented divergence from upstream Replyke). Everything here is original work that **consumes
`@agora-sdk/core` as an ordinary published dependency** — the same way an app does. Nothing in this
repo is a fork of, or contains code from, Replyke.

The first feature is **secure chat**: the client side of Agora's end-to-end-encrypted messaging
(MLS / RFC 9420). More features will be added as sibling package groups under `packages/`.

### Why a separate repo (not a 5th package in agora-sdk)

The agora-sdk fork tracks upstream Replyke and re-applies a small, documented delta. A net-new
feature like secure chat:

- has **no upstream version** to track, so it can't sit in agora-sdk's lockstep release;
- would dilute the fork's "mirror + tiny delta" model and invite scope creep;
- is a **downstream consumer** of `@agora-sdk/core`, not a modification of it.

If secure chat ever needs something `@agora-sdk/core` doesn't export, the fix is a small, deliberate,
**documented core export addition in agora-sdk** (a tracked divergence) — never a deep-import of core
internals from here.

## Related repos

| Repo | Role |
|---|---|
| [agora-server](https://github.com/jenova-marie/agora-server) | The API. Owns the secure-chat **blind Delivery Service** and the wire contract (`@agora/contract`). The `SecureChatCrypto` seam moved out of here into this repo (it was test-only client code). See its `docs/SECURE_CHAT.md` — the canonical spec. |
| [agora-sdk](https://github.com/jenova-marie/agora-sdk) | The Replyke fork (`@agora-sdk/{core,react-js,react-native,expo}`). We depend on its published `@agora-sdk/core`. |
| **agora-sdk-plus** (this repo) | Additive Agora-only SDK features. First: secure chat. |

## Architecture

The repo ships feature-grouped packages, each mirroring agora-sdk's **core + platform** shape so the
SDKs feel identical to consumers:

```
packages/secure-chat/crypto       @agora-sdk/secure-chat-crypto       the SecureChatCrypto seam: interface (main) + MockSecureChatCrypto (./testing). Dependency-free.
packages/secure-chat/core         @agora-sdk/secure-chat-core         transport + provider/hooks + DI crypto (platform-agnostic)
packages/secure-chat/react-js     @agora-sdk/secure-chat-react-js     web: ts-mls crypto + IndexedDB persistence   (Phase 2)
packages/secure-chat/react-native @agora-sdk/secure-chat-react-native bare RN: Keychain + native MLS               (Phase 3 stub)
packages/secure-chat/expo         @agora-sdk/secure-chat-expo         Expo: SecureStore                            (Phase 3 stub)
```

`secure-chat-core` depends on `secure-chat-crypto` for the interface; the platform packages provide
(or, today, stub) a concrete `SecureChatCrypto` and inject it into `<SecureChatProvider crypto={…}>`.

Future features follow the same layout: `packages/<feature>/{core,react-js,react-native,expo}` →
`@agora-sdk/<feature>-{core,react-js,...}`. The pnpm workspace globs `packages/**/*`.

### The model: blind server, all crypto client-side

Per the server spec, the Agora server is a **blind MLS Delivery Service** — it stores and relays
opaque base64 blobs (KeyPackages, Welcomes, Commits, application ciphertext, key backups) and
**never sees plaintext**. **All MLS crypto lives here, client-side, behind the `SecureChatCrypto`
seam.** This SDK's job:

1. **Transport** — typed REST client over `@agora-sdk/core`'s base URL/auth, plus the `/secure`
   socket.io namespace for realtime fan-out (`secure:message`, `secure:welcome`, `secure:handshake`,
   `secure:key-packages-low`, …).
2. **Crypto (DI)** — accept a `SecureChatCrypto` implementation. Core ships against the interface +
   mock; `react-js` will wire the real **ts-mls** (or OpenMLS-WASM) implementation + IndexedDB
   group-state persistence (Phase 2).
3. **Provider + hooks** — `SecureChatProvider` + `useSecureChat`, then feature hooks
   (`useSecureDevice`, `useSecureConversations`, `useSecureMessages`) following the same
   provider+hooks pattern as `@agora-sdk/core`.

The durable source of truth is always the REST `GET .../handshakes?since=` + `GET .../messages`
endpoints; realtime is a notification optimization (offline catch-up via the cursors).

### Crypto seam (owned here) + wire types (owned by the server)

The dependency arrow is **SDK → contract**, and the **crypto seam is client code that lives here**:

- **Crypto** — `@agora-sdk/secure-chat-crypto` is the home of record for the `SecureChatCrypto`
  interface + the `MockSecureChatCrypto` (and, in Phase 2, the real ts-mls/OpenMLS cores). It is
  Apache-2.0 and dependency-free. agora-server **consumes** it as a test devDependency (it only used
  the mock to simulate a client), so it must not live in the AGPL server repo.
- **Wire types** — owned by agora-server's `@agora/contract` (Apache-2.0). This SDK **depends on**
  it. Until `@agora/contract` is published, `packages/secure-chat/core/src/contract/` holds a
  **stand-in copy** (types-only, byte-faithful to `contract/src/secure-chat.ts`).

**Do not** create an `@agora-sdk/secure-chat-contract` re-exported by `@agora/contract` — that
inverts the dependency. When the contract publishes, delete the stand-in and import from
`@agora/contract`. Keep the stand-in byte-faithful in the meantime; see `STATUS.md` for the cross-repo
plan.

## Development commands

[pnpm](https://pnpm.io) workspace monorepo.

- `pnpm install` — install
- `pnpm run build-all` — build all packages in dependency order (core → react-js → react-native →
  expo); each compiles dual ESM (`dist/esm`, `tsconfig.esm.json`) + CJS (`dist/cjs`,
  `tsconfig.cjs.json`)
- `pnpm --filter @agora-sdk/secure-chat-core run build` — build one package while iterating
- `pnpm run typecheck` — `tsc --noEmit` at the root

> `pnpm install` resolves `@agora-sdk/core` from npm; the crypto seam comes from the in-repo
> `@agora-sdk/secure-chat-crypto` workspace package, and the wire types from the in-repo stand-in
> (until `@agora/contract` is published). No cross-repo linking is required to build.

## Changelog discipline

Keep [`CHANGELOG.md`](CHANGELOG.md) ([Keep a Changelog](https://keepachangelog.com/)) current: after
any code/config/build change, add a bullet under `## [Unreleased]` in the right group
(`Added` / `Changed` / `Fixed` / `Removed`) in the same commit.

## Phasing (from agora-server `docs/SECURE_CHAT.md` §15)

The SDK team's detailed Phase 2/3 checklist (with a per-file map of the scaffold) is in
[`packages/secure-chat/ROADMAP.md`](packages/secure-chat/ROADMAP.md). Summary:

- **Phase 1 — DONE (server).** Blind Delivery Service + schema + `/secure` realtime + contract +
  `SecureChatCrypto` seam + mock-tested.
- **Phase 2 — web client (this repo's focus).** Real `SecureChatCrypto` (ts-mls/OpenMLS-WASM) behind
  the interface; IndexedDB group-state persistence; KeyPackage replenishment loop; handshake-pull on
  connect + realtime catch-up; passphrase backup/restore (argon2id). Expected **no server changes**.
- **Phase 3 — native + full multi-device.** RN + Expo (native MLS bindings, hardware keystore);
  multiple devices/leaves per user; device-linking; cross-device history sync.
