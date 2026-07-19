# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

**Agora SDK Plus** is the home for **additive, Agora-only SDK features** — capabilities that have
**no upstream Replyke counterpart** and therefore must NOT live in the
[agora-sdk](https://github.com/jenova-marie/agora-sdk) fork (whose entire value is staying a tiny,
documented divergence from upstream Replyke). Everything here is original work with **no code
dependency on `@agora-sdk/core`** — the features are standalone (the consuming app passes the API
`baseUrl` and access token in directly). They're designed to drop into an Agora/Replyke app and reuse
its config, but they don't import core. Nothing in this repo is a fork of, or contains code from,
Replyke.

The first feature is **secure chat**: the client side of Agora's end-to-end-encrypted messaging
(MLS / RFC 9420). More features will be added as sibling package groups under `packages/`.

### Why a separate repo (not a 5th package in agora-sdk)

The agora-sdk fork tracks upstream Replyke and re-applies a small, documented delta. A net-new
feature like secure chat:

- has **no upstream version** to track, so it can't sit in agora-sdk's lockstep release;
- would dilute the fork's "mirror + tiny delta" model and invite scope creep;
- is **standalone**, not a modification of `@agora-sdk/core` (it doesn't even import it).

The features take everything they need (`baseUrl`, access token, crypto, store) as explicit inputs, so
they never reach into core internals and never force a core change. (They formerly fell back to core's
`getApiBaseUrl`/`getSocketUrl` runtime singletons to auto-inherit a Replyke app's config; that was the
only coupling, and it was dropped in favor of a required `baseUrl` so the features are usable in any
app, Replyke or not.)

## Related repos

| Repo | Role |
|---|---|
| [agora-server](https://github.com/jenova-marie/agora-server) | The API. Owns the secure-chat **blind Delivery Service** and the wire contract (`@agora-server/contract`). The `SecureChatCrypto` seam moved out of here into this repo (it was test-only client code). See its `docs/SECURE_CHAT.md` — the canonical spec. |
| [agora-sdk](https://github.com/jenova-marie/agora-sdk) | The Replyke fork (`@agora-sdk/{core,react-js,react-native,expo}`). A sibling SDK an app runs alongside these features — **no longer a code dependency** of this repo (the app passes the shared `baseUrl` in). |
| **agora-sdk-plus** (this repo) | Additive Agora-only SDK features. Shipping: secure chat, social graph, auth ergonomics. |

## Architecture

> 📐 For the **visual** view — package graph, layers/seams, and runtime sequence flows — see
> [`ARCHITECTURE.md`](ARCHITECTURE.md). This section stays the prose source of truth; the diagrams
> defer to it.

The repo ships feature-grouped packages, each mirroring agora-sdk's **core + platform** shape so the
SDKs feel identical to consumers:

```
packages/secure-chat/crypto       @agora-sdk/secure-chat-crypto       the SecureChatCrypto seam: interface (main) + MockSecureChatCrypto (./testing) + real ts-mls core (./ts-mls, ESM-only). Bare entry + ./testing are dependency-free.
packages/secure-chat/core         @agora-sdk/secure-chat-core         transport + provider/hooks + DI crypto (platform-agnostic)
packages/secure-chat/react-js     @agora-sdk/secure-chat-react-js     web: real ts-mls crypto + IndexedDB persistence (ESM-only)
packages/secure-chat/react-native @agora-sdk/secure-chat-react-native bare RN: Keychain + native MLS               (Phase 3 stub)
packages/secure-chat/expo         @agora-sdk/secure-chat-expo         Expo: SecureStore                            (Phase 3 stub)
```

`secure-chat-core` depends on `secure-chat-crypto` for the interface; the platform packages provide
(or, today, stub) a concrete `SecureChatCrypto` and inject it into `<SecureChatProvider crypto={…}>`.

The second feature group, **social** — the Agora social graph as a *commons* (the graph is pointed
back at the community, never mined to rank/target/sell). Three member-facing **lenses** + a
transparency view, all standalone (`baseUrl` + token + `projectId` in, **no crypto**):

```
packages/social/core              @agora-sdk/social-core              transport + SocialProvider + feature-gated hooks (useSocialWeather/Constellation/Neighborhood/Transparency). Pure data.
packages/social/react-js          @agora-sdk/social-react-js          web components: CommunityWeather, Constellation (d3-force), Neighborhood, SocialTransparency. Re-exports social-core. (ESM-only)
packages/social/react-native      @agora-sdk/social-react-native      bare RN components (d3-force + react-native-svg). Re-exports social-core.
packages/social/expo              @agora-sdk/social-expo              thin re-export of social-react-native (zero platform difference).
```

`SocialProvider` fetches the transparency config on mount so every hook/component self-gates. See
[`docs/SOCIAL-GRAPH.md`](docs/SOCIAL-GRAPH.md) for the lens-by-lens integration guide.

Future features follow the same layout: `packages/<feature>/{core,react-js,react-native,expo}` →
`@agora-sdk/<feature>-{core,react-js,...}`. The pnpm workspace globs `packages/**/*`.

```
packages/public-read/core         @agora-sdk/public-read-core         tokenless transport + provider + hooks for the anonymous /public/* surface
packages/public-read/react-js     @agora-sdk/public-read-react-js     web: <PublicComments> drop-in. Re-exports public-read-core. (ESM-only)
```

The third feature group, **public-read** — the client for agora-server's anonymous, read-only
`/v7/:projectId/public/*` surface (internet-public entities + their comment threads). It is the
**most standalone package in this repo and the only tokenless one**: `baseUrl` + `projectId` in, no
access token, no `@agora-sdk/*` dependency of any kind, so a third-party blog with no SDK installed
can embed a thread. Read-only by construction — GET routes only, no compose UI, no code path that
could attach a credential (the surface's wildcard CORS would reject one anyway). Web-only at v1; the
server's gate returns a deliberately ambiguous `404` that the SDK surfaces as a neutral `notFound`
boolean, never a message. See [`docs/PUBLIC-READ.md`](docs/PUBLIC-READ.md).

```
packages/auth/react-js            @agora-sdk/auth-react-js            web: black-box OAuth callback + auth ergonomics (peer-deps @agora-sdk/react-js)
```

> **Scoped exception to "no `@agora-sdk/core` dependency".** `auth-react-js` is the single feature
> that *does* depend on the SDK (a `@agora-sdk/react-js` **peerDependency**), and deliberately so:
> unlike secure-chat / social — which are standalone and take `baseUrl` + token as inputs — auth is
> intrinsically *about the SDK's own session*. It runs inside `<ReplykeProvider>` and **observes** the
> SDK's auth state via its public hooks (`useAuth`/`useUser`/`useOAuthSignIn`/`useSignOutAll`), touching
> `localStorage` only in one quarantined module (`accountStorage.ts`, which owns the
> `replyke-accounts:<projectId>` key + map shape). Web-only: the OAuth callback race is specific to
> cross-document (MPA) navigation. It answers `agora-sdk/docs/AUTH_IMPLEMENTATION.md` (P1/P3/P4/P5/P6/P7)
> without widening the fork's divergence from upstream Replyke. secure-chat / social stay standalone —
> do **not** generalize this dependency to them.

### The model: blind server, all crypto client-side

Per the server spec, the Agora server is a **blind MLS Delivery Service** — it stores and relays
opaque base64 blobs (KeyPackages, Welcomes, Commits, application ciphertext, key backups) and
**never sees plaintext**. **All MLS crypto lives here, client-side, behind the `SecureChatCrypto`
seam.** This SDK's job:

1. **Transport** — typed REST client over a caller-supplied `baseUrl` + access token, plus the `/secure`
   socket.io namespace for realtime fan-out (`secure:message`, `secure:welcome`, `secure:handshake`,
   `secure:key-packages-low`, …).
2. **Crypto (DI)** — accept a `SecureChatCrypto` implementation. Core ships against the interface +
   mock; `react-js` wires the real **ts-mls** core (`@agora-sdk/secure-chat-crypto/ts-mls`) +
   IndexedDB group-state persistence.
3. **Provider + hooks** — `SecureChatProvider` + `useSecureChat`, then feature hooks
   (`useSecureDevice`, `useSecureConversations`, `useSecureMessages`) following the same
   provider+hooks pattern as `@agora-sdk/core`.

The durable source of truth is always the REST `GET .../handshakes?since=` + `GET .../messages`
endpoints; realtime is a notification optimization (offline catch-up via the cursors).

### Crypto seam (owned here) + wire types (owned by the server)

The dependency arrow is **SDK → contract**, and the **crypto seam is client code that lives here**:

- **Crypto** — `@agora-sdk/secure-chat-crypto` is the home of record for the `SecureChatCrypto`
  interface, the `MockSecureChatCrypto` (`./testing`), and the real **ts-mls** core (`./ts-mls`, an
  opt-in **ESM-only** subpath). The bare entry + `./testing` stay Apache-2.0 and dependency-free; only
  `./ts-mls` pulls in ts-mls. agora-server **consumes** it as a test devDependency (it only used
  the mock to simulate a client), so it must not live in the AGPL server repo.
- **Wire types** — owned by agora-server's `@agora-server/contract` (Apache-2.0). This SDK **depends on**
  it (a `dependency` of `@agora-sdk/secure-chat-core`, `^0.13.0`; `social-core` pins `^0.12.1`).
  `packages/secure-chat/core/src/contract/`
  is now a thin **type-only re-export** of the contract's secure-chat surface (the former byte-faithful
  stand-in copy is gone — one source of truth, zero drift). The internal import path is kept so call
  sites don't churn; the re-export is type-only, so core's dual ESM/CJS build never `require()`s the
  (ESM-only) contract at runtime. `social-core` follows the same pattern for `contract`'s `social.ts` surface.

**Do not** create an `@agora-sdk/secure-chat-contract` re-exported by `@agora-server/contract` — that
inverts the dependency. The arrow is **SDK → contract**; see `STATUS.md` for the cross-repo plan.

## Development commands

[pnpm](https://pnpm.io) workspace monorepo.

- `pnpm install` — install
- `pnpm run build-all` — build every package in dependency order: `secure-chat-crypto` first, then the
  secure-chat group (core → react-js → react-native → expo), the social group (core → react-js →
  react-native → expo), the public-read group (core → react-js), and `auth-react-js` last. Each compiles dual ESM (`dist/esm`,
  `tsconfig.esm.json`) + CJS (`dist/cjs`, `tsconfig.cjs.json`) — **except the three web packages,
  `secure-chat-react-js`, `social-react-js`, and `public-read-react-js`, which are ESM-only**
  (`secure-chat-react-js` depends on the ESM-only ts-mls core; `social-react-js` follows suit to match,
  and its `d3-force` dependency is ESM-only too — so a CJS build would never load at runtime for
  either; `public-read-react-js` matches the convention. Web/React consumers bundle anyway)
- `pnpm --filter @agora-sdk/secure-chat-core run build` — build one package while iterating
- `pnpm run verify:dist` — sanity-check built `dist/` outputs (`scripts/verify-dist.mjs`)
- `pnpm run version:patch` / `version:minor`, `publish-prod` / `publish-beta` — release across all
  twelve publishable packages (run `scripts/write-version.mjs` after a version bump)
- `pnpm run typecheck` — `tsc --noEmit` at the root
- `pnpm test` — unit suite (vitest); fully mocked, server-free. Single file/pattern:
  `pnpm test <path-or-substring>` (e.g. `pnpm test useAuthSelfHeal`); single case: add `-t "<name>"`
- `pnpm test:e2e` — **opt-in** foundation e2e: the real transport clients against a locally running
  agora-server (register → DM → send → receive → realtime → reload, server-blind). Skipped unless
  `AGORA_E2E_DATABASE_URL` + `AGORA_E2E_ACCESS_TOKEN_SECRET` are set (match the server's `.env`);
  it has its own config/glob (`e2e/**`) so `pnpm test` and CI stay server-free. See README "Develop".

> These packages have **no `@agora-sdk/core` dependency** (the app supplies `baseUrl` directly). The
> crypto seam comes from the in-repo `@agora-sdk/secure-chat-crypto` workspace package, and the wire
> types from the published `@agora-server/contract` (re-exported type-only by `core/src/contract/`). No
> cross-repo linking is required to build.

## Engineering standards (enforced)

These are **requirements**, not suggestions. Every code change MUST satisfy all five before it is
considered done. They apply to all original code under `packages/**`.

### 1. Security first — this is end-to-end-encryption code

This SDK is the **client side of an E2EE messaging system** whose entire promise is that a blind
server (and any network attacker) never sees plaintext or key material. Treat every change as
security-sensitive and hold it to that bar **before** anything else on this list.

- **Plaintext and keys never leave the client in the clear.** Only ciphertext, public keys,
  KeyPackages, Welcomes/Commits, and passphrase-encrypted backups cross the wire. Never log, throw,
  serialize into errors, or send to the server: message plaintext, MLS group secrets, signature/HPKE
  **private** keys, `privateState`, or backup passphrases. Audit `console.*`, error messages, and
  analytics for accidental leakage.
- **Respect the crypto seam.** All MLS crypto stays behind `SecureChatCrypto`. Do not hand-roll
  crypto, invent your own framing, or reach around the interface. Use vetted primitives (the chosen
  MLS core, `@noble/*`, WebCrypto) — never `Math.random()` for anything security-relevant; use a CSPRNG.
- **Preserve the security invariants of the protocol.** Epoch/generation ordering, replay/gap
  rejection, "buffer ahead-of-epoch then verify", and authenticating a sender before trusting a
  message are correctness *and* security properties. Don't weaken them for convenience; if a change
  touches one, call it out explicitly and test it.
- **Fail closed.** On a missing key, failed decrypt/verify, unknown group, or epoch mismatch, surface
  the error and drop the message — never fall back to plaintext, a zero/empty key, or "skip the check".
- **Trust boundaries.** The server is **blind and untrusted**: validate/than-decode everything it
  relays; never assume a server-supplied id, epoch, or blob is well-formed or honest. Treat realtime
  events as hints, with the REST cursors as the authenticated source of truth.
- **Backups & at-rest.** Backups use a real KDF (argon2id, conservative params) + AEAD — never the
  mock's fake KDF in shipped code. Document any plaintext-at-rest (e.g. IndexedDB on web) honestly and
  scope it.
- **Dependencies & secrets.** Crypto/security deps are pinned and minimal; review before adding one.
  No secrets, tokens, or real key material committed to the repo or baked into tests/fixtures.
- **When in doubt, stop and flag it.** A security-relevant ambiguity is a blocker, not a judgment call
  to make silently. Surface it; for a non-trivial security-affecting change, prefer a `/security-review`
  pass before calling it done.

### 2. TSDoc on every public export

Every **exported** symbol (function, class, hook, interface, type, const, enum) carries a `/** … */`
TSDoc block. TypeDoc only reads block comments directly above a declaration — file-header `//`
comments are invisible to generated docs and do **not** count.

- Document the symbol with a real, specific description — **never leave `[PLACEHOLDER]` text**.
- Functions/hooks: `@param` per parameter, `@returns`, and `@throws {ErrorType}` for each error a
  caller can hit. Add an `@example` for anything non-trivial (providers, hooks, clients).
- Interface/type members get a one-line `/** … */` each.
- **Exception — re-exported wire types:** `packages/secure-chat/core/src/contract/` only **re-exports**
  the secure-chat types from `@agora-server/contract` (type-only); the type docs live in the contract,
  so no per-symbol TSDoc is added here (the file's header comment is enough). Document original code
  authored here.
- `pnpm run typecheck` MUST stay green after doc changes.

### 3. Good comments — explain *why*, not *what*

- Lead each source file with a short header comment stating its purpose and where it sits in the
  blind-server / client-crypto model (match the existing files' style).
- Comment the non-obvious: epoch/ordering invariants, the base64⇄`Uint8Array` wire boundary, lazy
  token/baseUrl resolution, optimistic UI, "buffer ahead-of-epoch" skips — the reasoning a future
  reader can't recover from the code alone.
- Do not narrate what the code already says. Keep comments **truthful and current** — update them in
  the same edit that changes the behavior they describe; a stale comment is a bug.

### 4. Changelog discipline

Keep [`CHANGELOG.md`](CHANGELOG.md) ([Keep a Changelog](https://keepachangelog.com/)) current: after
any code/config/build change, add a bullet under `## [Unreleased]` in the right group
(`Added` / `Changed` / `Fixed` / `Removed`) in the **same commit**.

### 5. Unit tests for every feature and fix

- Every new feature or bug fix ships with unit tests in the same change. A bug fix starts with a test
  that **fails before** the fix and **passes after** it.
- Co-locate tests next to the code as `*.test.ts` / `*.test.tsx` (excluded from `tsc` build output).
- Inject `MockSecureChatCrypto` from `@agora-sdk/secure-chat-crypto/testing` — never reach for real
  MLS crypto or a live server in unit tests. Mock the transport (`SecureChatRestClient` /
  `SecureChatSocketClient`) at its boundary; assert on the base64/epoch wire shapes the client emits.
- Cover the branches that matter: error/`@throws` paths, empty/`hasMore` pagination, the
  no-`group` "listed but undecrypted" path, and realtime de-dup.
- Run the suite with `pnpm test` (one-shot) or `pnpm test:watch`. The harness is **vitest**, driven
  by the root [`vitest.config.ts`](vitest.config.ts): it globs `packages/**/src/**/*.test.{ts,tsx}`
  and aliases the workspace crypto package to its source, so tests import `@agora-sdk/secure-chat-crypto`
  / `…/testing` without a build. Default env is `node`; opt a hook/provider test into jsdom with a
  `// @vitest-environment jsdom` pragma (install `jsdom` + `@testing-library/react` when the first
  such test lands). `*.test.ts(x)` files are excluded from every package's `tsc` build.
- Tests MUST pass (`pnpm test` green) before claiming work complete.

## Phasing (from agora-server `docs/SECURE_CHAT.md` §15)

The SDK team's detailed Phase 2/3 checklist (with a per-file map of the scaffold) is in
[`packages/secure-chat/ROADMAP.md`](packages/secure-chat/ROADMAP.md). Summary:

- **Phase 1 — DONE (server).** Blind Delivery Service + schema + `/secure` realtime + contract +
  `SecureChatCrypto` seam + mock-tested.
- **Phase 2 — web client — DONE (Definition of Done met).** Real `SecureChatCrypto` (**ts-mls**) behind
  the interface, IndexedDB group-state persistence, handshake-pull on connect + realtime catch-up,
  KeyPackage replenishment, generation-counter replay/gap enforcement (ts-mls is the enforcement point;
  the SDK pins + classifies/surfaces it), and metadata hardening (size-bucket padding + safety numbers)
  are all shipped. Passphrase backup/restore shipped too but is now **deprecated** (2026-06-18):
  server-passphrase recovery is superseded by device-to-device **IUC** history restore and the local
  `createEncryptedStore` at-rest decorator (Phase 2.5). The one remaining hardening item is the `409
  secure-chat/epoch-conflict` rebase-on-retry for membership commits. Expected **no server changes**.
  Full detail in [`packages/secure-chat/ROADMAP.md`](packages/secure-chat/ROADMAP.md).
- **Phase 3 — native + full multi-device.** RN + Expo (native MLS bindings, hardware keystore);
  multiple devices/leaves per user; device-linking; cross-device history sync.
