# `public-read` — anonymous entity + comment reads 🌍

**Date:** 2026-07-18
**Status:** Approved (brainstormed with Jenova)
**Answers:** `docs/superpowers/specs/2026-07-18-public-read-comments-change-request.md` (from the agora-sdk fork maintainers)
**Server dependency:** `agora-server` — **merged to `root`** (`14b7bc9`), documented in that repo's `docs/PUBLIC-API.md`
**Contract:** `@agora-server/contract@^0.21.0` — **published to npm**, carries `Entity.public`

---

## 1. Problem

Agora is private by default. The auth wall (server migration `0064`) requires an authenticated
account on every `/v7/:projectId/*` route outside a tiny allowlist. That intentionally killed
anonymous reads — including the legitimate one: a blog, marketing page, or third-party site
embedding a comment thread that anyone can read, with **no visitor account**.

The server answered with a deliberate, narrow, auditable read-only hole — the `/public/*` surface.
Nothing in the SDK can consume it. The fork's `useCommentSectionData` bundles reads, writes,
reactions, and identity into one hook with no read-only mode, and every list path routes through
`useAxiosPrivate()` → `useAuth()`. This spec designs the client that can.

### Why it lands in agora-sdk-plus

The fork's charter is a tiny, documented divergence from upstream Replyke. Upstream serves *all*
reads publicly: it has no `is_public` flag, no visibility ladder, and no `/public/*` namespace. There
is no upstream counterpart to track and nothing that could ever merge back — the exact charter of
this repo.

Three facts reinforce it:

1. **Nothing is shared.** A read-only anonymous variant must bypass the fork's comment machinery
   entirely, so co-location saves nothing.
2. **This is the most standalone feature in this repo.** Secure Chat and Social take `baseUrl` + an
   access token. This one is **tokenless** — `baseUrl` + `projectId` and nothing else. No `useAuth`,
   no store, no boot latch, no interceptors, no `@agora-sdk/*` dependency of any kind. It does not
   need the scoped exception `auth-react-js` carries.
3. **The types already have a home.** `@agora-server/contract` exports `Entity` and `Comment`;
   `Entity` gained `public: boolean` in the same server change. The dependency arrow stays
   **SDK → contract**.

---

## 2. The wire contract we code against

Three routes, all **GET-only, anonymous, read-only**, mounted at `/v7/:projectId/public/*`.
`"/public/"` is the only project-scoped prefix on `AUTH_WALL_ALLOWLIST` besides `/auth/`. Nothing
branches on caller identity — a signed-in user gets exactly what a stranger gets.

| Route | Returns |
|---|---|
| `GET /public/entities/:id` | shaped `Entity` (bare object, **no envelope**) |
| `GET /public/entities/:id/comments` | `{ data: Comment[], pagination }` — one level |
| `GET /public/entities/:id/comments/thread` | `{ data: PublicCommentNode[] }` — **server-nested, no pagination envelope** |

### Query parameters (verified against `agora-server/docs/PUBLIC-API.md` §3)

**`/comments`** — `parentId` (page replies; **malformed → 404**), `page` (1), `limit` (20, clamped
100), `sortBy` (`createdAt` | `top` | `controversial`; legacy `new`/`old` still work but emit an
RFC 8594 `Deprecation` header), `sortDir` (`desc`, applies to `createdAt` only), `include` (`user`).

**`/comments/thread`** — `rootId` (subtree root, `parentId` accepted as alias; **malformed → treated
as absent**, serves the whole thread), `page` (1, translated to an offset), `limit` (50, clamped
100), `include` (`user`).

**`/entities/:id`** — `include` (`user`, `files`).

> ⚠️ **The `parentId` / `rootId` asymmetry is load-bearing.** Two same-looking params with opposite
> failure modes: a malformed `parentId` 404s, a malformed `rootId` silently serves the whole thread.
> The transport must not "helpfully" normalize one into the other.

**`spaceReputation*` params are accepted and silently ignored.** We never send them.

### Behavioral contract

- **404, never 403.** The gate re-derives live on every request from the conjunction
  `exists ∧ is_public ∧ not deleted ∧ not draft ∧ not moderation-removed ∧ (spaceless ∨ space is
  reading_permission='anyone')`. Any failure is `404 entities/not-found`. **The client must never
  interpret a 404 as "unpublished" vs "missing" vs "draft" vs "space went private"** — the server
  deliberately makes them indistinguishable. One neutral empty state; never guess.
- **Fail-closed and live.** An un-publish, moderation removal, soft-delete, or space flip un-exposes
  the thread immediately at the origin.
- **Anonymous shapes.** `userReaction` is always `null`. `user.birthdate` is always `null` and
  `user.metadata` always `{}` — `redactPublicUser` (`apps/api/src/routes/public.ts:27`) is applied at
  all three `?include=user` sites. The internet still gets `username`, `name`, `avatar`, `bio`.
- **CORS is wide open** — `Access-Control-Allow-Origin: *`, never credentials, and **no
  `Vary: Origin`** on this prefix. Send **no** `Authorization` header and **no** cookies: a
  credentialed request against a wildcard ACAO fails preflight in the browser.

### Caching (landed after the change request was written)

Success responses carry `Cache-Control: public, max-age=0, s-maxage=300, must-revalidate` and an
`ETag`, with bodyless `304` support. Error responses are `no-store`.

**Design consequence: we add no client-side cache, deliberately.** `max-age=0, must-revalidate`
means the browser issues `If-None-Match` on every read and transparently serves the stored body on
`304` — correct revalidation is free, and we get it by doing nothing. Any cache layered on top would
fight the browser's and reintroduce exactly the takedown-window risk the server bounded at 300s.
This is a **do-nothing decision made on purpose**, and is documented as such in code so a future
reader doesn't "fix" it by adding memoization.

### Comment visibility — the tombstone case

Removed comments are always hidden (filtered in SQL for the list; the thread RPC passes
`p_hide_removed => true`, which prunes removed comments *and their descendant subtrees* — a
post-filter would orphan children). Deleted comments are excluded by the RPC, **but author-deleted
ones are blanked in place by the shaper** (Reddit-style placeholder, `userDeletedAt` set), exactly as
on the walled surface.

So a **tombstone node is a real state in both modes** and needs its own render path and its own test.
(The change request stated deleted comments are "omitted from the list entirely" — that is
incorrect; see §11.)

### Do not port `addCommentsToTree`

The fork assembles threads client-side from repeated flat `GET /comments` calls. The public thread
arrives already nested. Porting that helper would buy nothing and create a drift liability against a
fork we do not depend on.

---

## 3. Packages

```
packages/public-read/core      @agora-sdk/public-read-core      dual ESM/CJS
packages/public-read/react-js  @agora-sdk/public-read-react-js  ESM-only
```

**Web-only at v1**, following the `auth-react-js` precedent rather than social's full four. A native
app has a login; an anonymous internet reader is a browser. `core` stays strictly
platform-agnostic — **no DOM, no web APIs** — so `react-native`/`expo` can be added later without a
refactor. We do not ship stub packages pretending to be shipped.

`react-js` is ESM-only, matching `social-react-js` and `secure-chat-react-js`: web/React consumers
always bundle, so a CJS build would be dead weight. It carries `main === module` (both pointing at
`dist/esm`), which is how `scripts/verify-dist.mjs` detects ESM-only.

**Dependencies.** `core`: `@agora-server/contract@^0.21.0`, `axios@^1.4.0`, `react` peer.
`react-js`: `@agora-sdk/public-read-core` (`workspace:*`), `react`/`react-dom`/`@types/react` peers,
plus a `copy:docs` script shipping `docs/PUBLIC-READ.md` (the web package is this repo's doc carrier
by convention). Both mirror `social-core`'s `package.json` shape.

**No `@agora-sdk/*` dependency of any kind** — not a dependency, not a peer, not a dev dependency.

---

## 4. Transport — `PublicReadRestClient`

`packages/public-read/core/src/transport/rest.ts`. Modeled on `SocialRestClient`, with one
structural difference that carries the entire security posture:

```ts
export interface PublicReadRestConfig {
  /** Resolve the API base URL incl. the version prefix (e.g. `() => "https://host/v7"`). */
  getBaseUrl: () => string;
  /** The Agora project id (path-scoped on every endpoint). */
  projectId: string;
}
```

**There is no `getAccessToken`.** Not an optional token — no token parameter exists anywhere in the
config, so sending one is *structurally impossible* rather than merely discouraged. This is the
single most important line in the package.

The client owns a bare `axios.create()` (never the fork's instance — that one is wrapped in
`withAuthTransport` and blocks on a boot latch released only by the auth-init thunk, so an
anonymous flow would hang forever). One request interceptor:

- sets `req.baseURL = ${base}/${projectId}/public`
- sets `withCredentials: false`
- **deletes any `Authorization` header** defensively

The last two are belt-and-braces against a host app configuring axios defaults globally. Cheap, and
the failure mode they prevent is silent in dev and total in production (a credentialed request
against wildcard ACAO fails preflight).

### Methods

```ts
getEntity(entityId, opts?: { include?: EntityInclude[] })            → Entity
getComments(entityId, opts?: PublicCommentsQuery)                     → PaginatedResponse<Comment>
getThread(entityId, opts?: PublicThreadQuery)                         → { data: PublicCommentNode[] }
```

Params are sent **only when explicitly provided** — `undefined` means "use the server default",
matching `SocialRestClient` and asserted in its tests.

### Errors

One private `get<T>` funnels every failure into `PublicReadApiError` (readonly `status: number`,
`0` = network failure; readonly `code: string | null`), reusing social's defensive `extractCode`
shape-prober. Plus one exported predicate:

```ts
export function isNotFound(err: unknown): boolean
```

This is the direct analogue of social's `isSocialDegradation`, and the **single place the neutral-404
rule is encoded**. Note the server distinguishes `project/not-found` (bad `projectId` — caller
config, not a secret) from `entities/not-found` (the gate). `isNotFound` covers the gate case; a
`project/not-found` is a genuine misconfiguration and surfaces as a real error, because silently
showing an empty thread when the host wired the wrong project id would be hostile to the integrator.

---

## 5. Contract re-export

`packages/public-read/core/src/contract/index.ts` — type-only re-export of `Entity`, `Comment`,
`User`, `PaginatedResponse`, `PaginationMetadata` from `@agora-server/contract`, following the
established pattern: `export type { … } from` is erased at emit, so the CJS build never `require()`s
the ESM-only contract at runtime. Per CLAUDE.md §2 this directory is exempt from per-symbol TSDoc —
the docs live in the contract.

The server nests thread replies ad hoc and the contract has **no type for it**, so we declare one
locally. This is original code and carries full TSDoc:

```ts
/**
 * A comment in a server-nested thread response, carrying its replies inline.
 *
 * The `/comments/thread` route returns the subtree already assembled (parents always before
 * children), unlike the flat `/comments` route which pages one level at a time. Recursive by
 * construction: a leaf has `replies: []`.
 */
export type PublicCommentNode = Comment & { replies: PublicCommentNode[] };
```

Local runtime const arrays (sort options, include options) are re-declared here rather than
value-re-exported — same CJS reason — but **typed against the contract's unions so drift is a
compile error**, exactly as `social-core` does with `WEATHER_BANDS`.

---

## 6. Provider

```tsx
<PublicReadProvider baseUrl={url} projectId={id}>
```

Deliberately **simpler than `SocialProvider`**: no token prop, and **no mount-time fetch**, because
the public surface has no transparency/feature-gate endpoint. There is no `configLoading` gate and
no all-disabled sentinel — it memoizes the REST client and nothing else. `usePublicRead()` throws
`"usePublicRead must be used within a <PublicReadProvider>."` when unwrapped.

This shape satisfies both of the change request's hard requirements at once:

- **Renders with no `<ReplykeProvider>` anywhere in the tree** — zero SDK dependency, own axios
  instance, no boot latch. A third-party blog has no Agora SDK installed at all.
- **Renders inside a `<ReplykeProvider>` without inheriting its token, latch, or interceptors** —
  there is no code path that could read them.

### The auth-swap contract

The consuming app renders one or the other, never both, and a login **remounts**:

```tsx
{user
  ? <CommentSection entityId={id} />   // @agora-sdk/react-js — authed, read + write
  : <PublicComments  entityId={id} />}  // @agora-sdk/public-read-react-js — anonymous, read-only
```

**Zero shared state between the two.** No shared cache, no handoff, no preserved scroll position or
expanded-replies state across the swap. The public tree unmounts; the authed one fetches from
scratch. A seamless in-place upgrade was evaluated and **rejected**: it would force a shared
tree/state layer straddling both repos, which is precisely the coupling this split exists to avoid.

---

## 7. Hooks

```ts
usePublicEntity(entityId, opts?)
  → { entity, loading, notFound, error, refresh }

usePublicComments(entityId, opts?)
  → { comments, loading, notFound, error, hasMore, loadMore, page,
      sortBy, setSortBy, sortDir, setSortDir, refresh }

usePublicCommentThread(entityId, opts?)
  → { nodes, loading, notFound, error, hasMore, loadMore, refresh }
```

Reply paging in `paged` mode uses `usePublicComments` with `parentId` set — no separate hook, since
the endpoint and the state machine are identical.

### `notFound` is first-class, separate from `error`

The most important decision in the hook layer. A 404 sets `notFound: true`, `error: null`, and empty
data. It never becomes an `Error` carrying a message, because **any message we wrote would be a
guess** between unpublished / missing / draft / removed / space-went-private — states the server
deliberately made indistinguishable. Leaking that guess into a UI string would hand an anonymous
prober exactly the existence oracle the server's 404-never-403 posture exists to deny.

Following the social hook template: bail early while a prerequisite is pending, clear state when
inputs change, surface real errors, hide the designed-neutral one, and keep `loading` false whenever
there is nothing to load.

`hasMore` on the thread hook is derived from `data.length === limit` rather than a pagination
envelope, because the thread route returns none. That inference is documented at the call site — it
can produce one wasted final request when the count divides evenly, which is the correct trade
against inventing a client-side count.

---

## 8. Components (`react-js`)

```tsx
<PublicComments
  entityId={id}
  mode="thread" | "paged"     // default "thread"
  className
  renderComment
  emptyState
  onSignInRequired
/>
```

**`mode="thread"` is the default**: one round trip, server-nested, rendered recursively — exactly
right for the embed case, which is the product. `mode="paged"` switches to the flat list with
"load more" plus per-comment reply paging, for threads that outgrow the 50-root default.

**Styling** matches the `social-react-js` precedent: self-contained inline `style={{}}`, a
`className` escape hatch for host layout, no CSS files and no style dependencies — so it drops into a
blog and looks finished with zero config. One `renderComment` render prop then hands the host total
control per node without us building a theming system:

```tsx
renderComment={(comment, { depth, children }) => (
  <MyComment comment={comment} depth={depth}>{children}</MyComment>
)}
```

Internals: `<PublicCommentNodeView>` (recursive, depth-aware indent) and
`<PublicCommentTombstone>` for the blanked author-deleted case (§2).

**Read-only is enforced structurally.** No compose box, no reaction control, no reply affordance
anywhere in the tree, and no code path that could produce one. `onSignInRequired` is an optional
callback so the host renders *its own* "sign in to join the conversation" CTA — we ship no auth UI
and take no auth dependency.

---

## 9. Testing

Per engineering standard #5, unit tests ship in the same change. Transport is mocked at its
boundary (`vi.spyOn(PublicReadRestClient.prototype, …)` for hooks; the private axios instance for
transport tests), following the `social-core` conventions verbatim — including the jsdom pragma and
the expected-render-time-throw noise suppression documented in `TESTING.md`.

**The negative cases are the point.** Mirroring the server's security posture:

- A 404 on every route renders the same neutral empty state, with **no** message distinguishing
  unpublished / missing / draft / space-went-private.
- **No `Authorization` header and no credentials are ever sent** — asserted on the outgoing request,
  including when a host app has set a global axios default.
- Renders with **no `ReplykeProvider`** in the tree.
- Renders **inside** a `ReplykeProvider` without inheriting its token.
- Nested thread renders from the server's `replies[]` shape directly (no client-side assembly).
- **Tombstone**: an author-deleted comment (`userDeletedAt` set) renders its placeholder in *both*
  modes without crashing and without exposing blanked content.
- Pagination: empty list, `hasMore` boundary, `parentId` reply paging.
- `userReaction: null` and absent `isSaved` do not crash the renderer.
- `spaceReputation*` params are never sent.
- A malformed `parentId` surfaces as `notFound`, while a malformed `rootId` is passed through
  untouched (the §2 asymmetry).

An **opt-in e2e** against a locally running `agora-server` (`e2e/**`, env-gated like the secure-chat
one) is valuable, since CORS behavior, the gate, and the ETag/304 round trip cannot be faithfully
unit-tested. **Nice-to-have, not a v1 gate.** It needs a `projectId` and a published entity id.

---

## 10. Docs & repo wiring

New docs:

1. `docs/PUBLIC-READ.md` — numbered-section integration guide in the `SOCIAL-GRAPH.md` shape
   (metadata blockquote, numbered sections, `*Source: …*` footer).
2. `packages/public-read/react-js/README.md`.

Updated:

3. Root `README.md` — Features table row + Packages block line.
4. `ARCHITECTURE.md` — a `subgraph` in the package graph + a `## public-read layers & seams` section.
5. `STATUS.md` — entries under `## Built`, plus the contract version floor (`^0.21.0`).
6. `CHANGELOG.md` — `### Added` bullets under `[Unreleased]`, same commit as the code.
7. `CLAUDE.md` — the architecture section and the `build-all` package order, both of which spell out
   the package list in prose and would go stale otherwise.

Repo wiring:

8. Root `package.json` — the package list is duplicated across **five** scripts (`build-all`,
   `version:patch`, `version:minor`, `publish-prod`, `publish-beta`). All five need both new names.
9. Root `tsconfig.json` `paths` + `vitest.config.ts` `alias` — map `@agora-sdk/public-read-core` to
   its source so typecheck and tests run without a build.
10. `pnpm-workspace.yaml` — **no change**, the `packages/**/*` glob picks it up.

### Two pre-existing gaps this feature inherits

Flagged, not silently accepted:

- **`scripts/verify-dist.mjs` hardcodes `packages/secure-chat`** (line 27), so the social group's
  dist has never been verified in CI despite `pnpm run verify:dist` running. `public-read` would
  inherit the same blind spot. Generalizing the script to loop over feature-group directories is a
  small change that covers both. **Recommended as part of this work.**
- The five duplicated root package lists mean adding a group is ten hand edits with no guard against
  missing one. Out of scope here, but worth a follow-up.

---

## 11. Corrections for the API team / fork maintainers

The change request predates three server commits and states two things that are now incorrect. These
should not propagate into the fork's docs:

| Claim in the CR §2 | Correction |
|---|---|
| Thread route reads `limit`/`offset` | It reads **`page`/`limit`** (limit default 50, clamped 100; page translated to an offset internally). |
| Deleted comments are "omitted from the list entirely (not blanked in place)" | Author-deleted comments are **blanked in place** (Reddit-style tombstone, `userDeletedAt` set), on both the list and the thread — same as the walled surface. |
| *(absent — post-dates the CR)* | The surface is now **CDN-cacheable**: `Cache-Control: public, max-age=0, s-maxage=300, must-revalidate` + `ETag` + `304` on success, `no-store` on errors. The CR's "do not cache client-side" guidance still holds and is now *also* the reason not to. |

Confirmed correct, for the record: `include=user` really does redact `birthdate` → `null` and
`metadata` → `{}` (`redactPublicUser`, `public.ts:27`, applied at all three sites).

Also noted: the server's own `docs/PUBLIC-API.md` §9 independently reaches this spec's conclusion —
*"an anonymous embed therefore needs new hooks in the SDK repo — not a server change."*

---

## 12. Out of scope

- **`PATCH /entities/:id/visibility`** — the privileged publish toggle. An authed mutation; it does
  not belong in a tokenless read package. `agora-admin` calls it with its existing authed client.
- Any write path whatsoever — no reactions, no comment creation, no reporting.
- Single-comment public permalinks — parked v2 on the server; the route does not exist.
- Public discovery listings — deliberately not built server-side. v1 is **by-direct-link only**: the
  caller must already know the entity id.
- Realtime — the public surface is REST-only; there is no anonymous socket namespace. (The fork has
  no comment sockets either, so this loses nothing.)
- `react-native` / `expo` packages — deferred until a real use case appears (§3).

---

## 13. Verification still outstanding

Everything above is verified against merged server code, the published contract, and live probes of
`localhost:4000` (404 posture, wildcard ACAO with no credentials, absent `Vary: Origin`, `no-store`
on errors, `204` preflight from a third-party origin).

Not yet exercised live, because it needs a `projectId` and a **published** entity id:

- the three success-path envelope shapes,
- the tombstone render case against real data,
- the `ETag` / `If-None-Match` → `304` round trip.

None block writing the implementation plan. They become blocking at the e2e task.
