# Design: `@agora-sdk/client` — a framework-neutral Agora client, Vue-first

- **Date:** 2026-06-28
- **Status:** Approved (brainstorm) → ready for implementation planning
- **Repo:** `agora-sdk-plus`
- **Author:** Jenova + Claude

## Goal

Reach developers who are **not on React**. The agora-sdk fork (`@agora-sdk/{core,react-js,…}`)
is React-only: its "platform-agnostic" `core` is React-agnostic *within* React (React + React
Native), wired to React Context, hooks, and Redux Toolkit + react-redux.

This project builds a genuinely **framework-neutral** Agora client and a **Vue 3** binding on top of
it, so the same social surface (feed, comments, reactions, auth) is consumable from Vue/Nuxt today
and Svelte/Solid/vanilla nearly for free later.

The first framework target is **Vue / Nuxt** (composables map almost 1:1 to React hooks — the gentlest
first port). Adoption/reach is the motivation, not a single downstream app.

## Strategy: clean-sheet headless client ("C-first")

We considered three strategies:

- **A — Parallel Vue packages over agora-sdk/core's spine.** Reuse core's Redux store + axios + socket
  from Vue, reimplement only the binding layer. Pragmatic but couples the Vue work to core's
  React-shaped internals and upstream hook churn.
- **B — Refactor core into a shared headless core, then thin React + Vue bindings.** Architecturally
  ideal, but **rewrites `core` and detonates the agora-sdk fork's "tiny documented divergence from
  upstream Replyke" sync model.** Rejected for that repo.
- **C — A fresh, additive headless client, agora-sdk untouched. ✅ CHOSEN.** Write a brand-new,
  framework-neutral package implementing the durable REST/socket/auth surface against the **server
  contract** — not derived from Replyke, not importing `@agora-sdk/core`. React keeps using core as-is;
  Vue (and future frameworks) bind to the new client. The client tracks the *stablest thing in the
  system* — the Agora server's REST/socket contract — so it is immune to upstream hook churn.

We chose **C first**: build the framework-neutral foundation up front. It is the real
"reach *many* frameworks" play, and it is fully additive — it touches neither agora-sdk nor the
existing agora-sdk-plus packages.

## Home: `agora-sdk-plus`, new `packages/client/*` feature group

`agora-sdk-plus` is the established home for **additive, net-new SDK packages with no upstream
lockstep release**. This project fits its charter cleanly:

- **Clean-sheet code** — contains no Replyke source; "nothing here is a fork of Replyke" holds.
- **Tracks the server contract, not Replyke** — exactly like `social-core` and `secure-chat-core`,
  which depend on `@agora-server/contract`. (`social-core`'s "no upstream counterpart" framing is
  really "tracks the server, not the fork" — our client honors that.)
- **No code dependency on `@agora-sdk/core`** — wire types come from `@agora-server/contract` where
  available, plus a local `src/contract` for shapes the server contract does not yet cover
  (feed/comments/reactions/entities). This is the same pattern `social-core` already uses (published
  contract dep **and** a local `src/contract`).
- **No lockstep release** — agora-sdk's `scripts/release.sh` bumps all four `@agora-sdk/*` packages in
  lockstep; a net-new client should not ride that train. A separate repo gives it independent cadence.

### The new tier

Existing `agora-sdk-plus` `*-core` packages are still **React-bound** (peer `react`; hooks + context).
This project introduces a genuinely **framework-neutral tier below them**: state lives in
[**nanostores**](https://github.com/nanostores/nanostores) (~1 KB, tree-shakable, with official
React/Vue/Svelte/Solid adapters), so each framework binding is a thin `useStore()` wrapper.

The member axis for this group is therefore **framework** (vue, react, …), not just platform.

## Packages

```
packages/client/core   @agora-sdk/client-core   framework-neutral. NO react/vue peer.
                                                 deps: nanostores, axios, @agora-server/contract
                                                 (+ local src/contract for feed/comments/reactions)
packages/client/vue    @agora-sdk/client-vue     Vue 3 binding.
                                                 deps: @agora-sdk/client-core, @nanostores/vue
                                                 peer: vue
```

Future, near-free once the core is stable: `packages/client/react-js` (`@nanostores/react`), then
`packages/client/svelte`, `packages/client/solid`, and a vanilla/web-component entry.

## `@agora-sdk/client-core` internals (four isolated units)

Each unit has one purpose, a well-defined interface, and is testable independently.

### 1. `transport/` — `class AgoraRestClient`

Mirrors the existing `SocialRestClient` (`packages/social/core/src/transport/rest.ts`):

- Constructed with lazy resolvers: `{ projectId, getBaseUrl, getAccessToken }`. Base URL and token are
  resolved **per request**, so a token refresh or a late-set `baseUrl` always wins.
- axios under the hood; one private `http` instance (boundary-stubbable in tests).
- Normalized error type **`AgoraApiError`** (`{ status, code, message }`), extracted from both nested
  (`{ error: { code } }`) and flat (`{ code }`) server error bodies — same normalization as
  `SocialApiError`.
- **Token-refresh-on-401** lives here (the Agora divergence: Agora returns **401** on token expiry,
  **403** for authorization denials — refresh keys off 401, never 403). A single-flight refresh guard
  prevents a thundering herd of concurrent 401s from all refreshing at once.
- Methods cover the first-scope endpoints: auth (sign-in/refresh/sign-out), entities + entity-lists
  (cursor-paginated), comments (CRUD + threads), reactions (toggle/add/remove).

### 2. `state/` — nanostores

- `$session` — auth/session atom (access token, current user).
- `$entityLists` — a `map`/keyed store of cursor-paginated feed pages, keyed by list id.
- `$comments` — keyed comment threads.
- `$reactions` — per-entity reaction state for optimistic toggles.
- Stores hold only serializable data; no framework objects.

### 3. `contract/` — local wire types

TS types for feed/comments/reactions/entities wire shapes, until `@agora-server/contract` absorbs
them. Re-export from `@agora-server/contract` whatever it already covers, to avoid drift.

### 4. `api/` — orchestration (framework-agnostic)

Functions that bind transport → state — **the logic React hooks bake in today, lifted out**:

- `loadMore(listId)` — fetch next cursor page, append to `$entityLists`.
- `toggleReaction(entityId, type)` — optimistic write to `$reactions`, call transport, **roll back on
  error**.
- `createComment` / `deleteComment` / `loadReplies` — thread mutations with optimistic updates.
- `signIn` / `signOut` / `refresh` — session lifecycle into `$session`.

These are plain async functions over the stores and the `AgoraRestClient`; every framework binding
calls the same ones.

### Token storage (pluggable)

A `TokenStorage` interface (`get`/`set`/`clear`) injected at client creation. The web/Vue path
provides a `localStorage` adapter; future RN/Expo paths provide Keychain/SecureStore — mirroring how
agora-sdk's platform packages inject storage.

## `@agora-sdk/client-vue` binding

- **Plugin:** `app.use(createAgoraClient({ projectId, baseUrl, getAccessToken, tokenStorage }))`
  instantiates `client-core` and provides it via Vue `provide`/`inject`.
- **Composables** mirror the SDK hook names so the mental model transfers:
  - `useAuth()` — session + `signIn`/`signOut`.
  - `useEntityList(opts)` — feed pages + `loadMore`, sort/filter passthrough.
  - `useComments(entityId)` — thread + create/delete/replies.
  - `useReactions(entityId)` — reaction state + `toggle`.
  Each wraps `@nanostores/vue`'s `useStore` over the relevant atom and exposes the matching `api/`
  actions. Returned refs are reactive; actions are stable.

## First scope (the vertical slice)

**auth + entities + entity-lists + comments + reactions.** This exercises every hard problem except
realtime:

- REST CRUD against a caller-supplied `baseUrl` + token.
- **Cursor pagination** (entity-lists).
- **Optimistic updates with rollback** (reactions, comments).
- **Token-refresh-on-401** (transport, single-flight).

**Explicitly out of first scope (fast-follow #2):** the socket.io realtime layer (live comments,
notifications, chat). REST is the durable source of truth; realtime is a notification optimization
layered on the already-validated base. Also deferred: additional frameworks (React/Svelte/Solid
bindings), additional domains (follows, collections, spaces, search), and SSR/Nuxt-server specifics
beyond what the client-side composables need.

## Testing

Follow the repo's vitest conventions:

- `client-core`: boundary-stub the `AgoraRestClient`'s private `http` axios instance (mirror
  `packages/social/core/src/transport/rest.test.ts`). Unit-test `api/` orchestration against
  in-memory nanostores (optimistic apply + rollback paths). Test the single-flight 401 refresh guard.
- `client-vue`: composable/component tests (Vue Test Utils + vitest) asserting reactivity and that
  actions call the right `api/` functions.
- TDD throughout: write the failing test first, then the implementation.

## Risks & open questions

- **Server contract coverage.** Confirm exactly which feed/comments/reactions/entities shapes
  `@agora-server/contract` already exports vs. what `client-core` must declare locally. If the gap is
  large, consider an upstream PR to the server contract so the client can shed local types over time.
- **Auth endpoint parity.** Verify the Agora server's auth/refresh endpoints and the 401-vs-403
  semantics against agora-sdk's `useAxiosPrivate` so the refresh behavior matches exactly.
- **Naming.** Package `@agora-sdk/client-{core,vue}`; transport class `AgoraRestClient`. (Confirmed.)
- **Nuxt SSR.** First scope targets client-side composables; full Nuxt server-side/SSR hydration is a
  later concern once the client API stabilizes.

## Non-goals

- No refactor of `@agora-sdk/core` or any agora-sdk fork file (preserves the upstream-sync model).
- No dependency on `@agora-sdk/core`.
- No UI components in `client-core`; bindings ship composables/hooks, not styled widgets (matching the
  headless philosophy).
