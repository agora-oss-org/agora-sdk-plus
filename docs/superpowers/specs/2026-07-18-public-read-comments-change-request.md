# Change Request — `public-read`: anonymous entity + comment reads 🌍

**Date:** 2026-07-18
**From:** agora-sdk (fork maintainers)
**To:** agora-sdk-plus
**Status:** Proposed — needs brainstorm → spec → plan in this repo before implementation
**Server dependency:** `agora-server` branch `feat/internet-public-entities`
— spec `docs/superpowers/specs/2026-07-18-internet-public-entities-design.md`,
plan `docs/superpowers/plans/2026-07-18-internet-public-entities.md`

---

## 1. Why this lands here and not in the fork

The `@agora-sdk/*` fork's entire value is that its divergence from upstream Replyke is tiny and
documented (eight numbered divergences; see the fork's `SYNCING.md`). The decision rule we applied:

> **If it could ever be upstreamed to Replyke, it belongs in the fork. If it is Agora-only, it
> belongs in agora-sdk-plus.**

The `/public/*` surface is unambiguously the latter. Upstream Replyke serves *all* reads publicly
and has no `is_public` flag, no visibility ladder, and no `/public/*` namespace. There is no
upstream counterpart to track, so there is nothing that could ever merge back — the exact charter
in this repo's `CLAUDE.md`.

Three additional facts pushed the same way:

1. **It cannot reuse the fork's comment machinery anyway.** `useCommentSectionData` in
   `@agora-sdk/core` instantiates five *write* hooks unconditionally (`useCreateComment`,
   `useUpdateComment`, `useDeleteComment`, `useAddReaction`, plus the entity mutators), each of
   which calls `useAxiosPrivate()` → `useAuth()`. A read-only anonymous variant must bypass it
   entirely. Nothing is shared, so nothing is saved by co-location.
2. **This is the most standalone feature in this repo.** Secure Chat and Social take `baseUrl` +
   an access token. This one is **tokenless**: `baseUrl` + `projectId` and nothing else. No
   `useAuth`, no store, no boot latch, no interceptors, no `@agora-sdk/core` peer dep. It does
   *not* need the scoped exception `auth-react-js` carries.
3. **The types already have a home.** `@agora-server/contract` exports `Entity` and `Comment`
   (`packages/contract/src/types.ts:70`), and `Entity` gains `public: boolean` in this same server
   change. Depend on the contract exactly as `secure-chat-core` and `social-core` already do —
   dependency arrow stays **SDK → contract**.

---

## 2. What the server ships (the wire contract you're coding against)

All three routes are **GET-only, anonymous, read-only**, mounted at `/v7/:projectId/public/*`,
allowlisted past the auth wall by the single prefix `"/public/"`.

| Route | Returns |
|---|---|
| `GET /public/entities/:id` | shaped `Entity` |
| `GET /public/entities/:id/comments` | `{ data: Comment[], pagination }` — one level; `?parentId=` pages replies |
| `GET /public/entities/:id/comments/thread` | `{ data: CommentNode[] }` — **server-nested**, each node carrying `replies[]` |

Query params on the list route mirror the walled `GET /comments`: `page`, `limit`, `parentId`,
`sortBy`. The thread route reads `limit`/`offset` (defaults `page: 1, limit: 50`).

**Behavioral contract you must design around:**

- **404, never 403.** The gate is re-derived live on *every* request from the conjunction
  `entity exists ∧ public ∧ not deleted ∧ not draft ∧ not moderation-removed ∧ (spaceless ∨ space
  is reading_permission='anyone')`. Any failure is `404 common/not-found`. **The client must never
  interpret a 404 as "unpublished" vs "missing" vs "space went private"** — the server deliberately
  makes them indistinguishable. Surface one neutral empty state; do not guess.
- **Fail-closed and instantaneous.** Flipping the space to members-only, soft-deleting the entity,
  or a moderation removal un-exposes the thread immediately. Do not cache gate results client-side
  beyond a normal request lifecycle.
- **Anonymous shapes.** `userReaction` is `null`, `isSaved` is `false`/absent. Removed comments are
  pruned; deleted comments are omitted from the list entirely (not blanked in place). With
  `?include=user`, the server nulls `birthdate` and empties profile `metadata` before responding.
- **CORS is wide open** (`Access-Control-Allow-Origin: *`, no credentials) on `/public/*` only —
  that's the point, third-party blogs embed this. Send **no** `Authorization` header and **no**
  cookies; a credentialed request against a wildcard ACAO fails CORS preflight in the browser.

⚠️ **The thread route is not shaped like anything the fork consumes.** `@agora-sdk/core` assembles
threads *client-side* (`helpers/addCommentsToTree.ts`) from repeated flat `GET /comments` calls, and
has no `/comments/thread` consumer at all. The public thread arrives already nested. **Do not port
`addCommentsToTree`** — you don't need it, and copying it would create a drift liability against a
fork you don't depend on.

---

## 3. Requested scope

### 3.1 Packages

Following the repo's `packages/<feature>/{core,react-js,…}` convention:

```
packages/public-read/core      @agora-sdk/public-read-core      transport + provider + hooks (platform-agnostic, tokenless)
packages/public-read/react-js  @agora-sdk/public-read-react-js  web components; re-exports core
```

**Web-only at v1**, following the `auth-react-js` precedent rather than social's full four. A
native app has a login; an anonymous internet reader is a browser. `core` stays platform-agnostic
so `react-native`/`expo` can be added later if a real use case appears — but don't build them now.

> 🏷️ **Naming is open.** `public-read` was chosen because it states the security posture in the
> package name (read-only), which we consider a feature. `embed` (states the use case) and `public`
> (shorter, vaguer) were the alternatives. Your call — settle it in the spec.

`public-read-core` dependencies: `@agora-server/contract` (types), `axios`, `react` peer. Mirror
`social-core`'s `package.json` shape. **No `@agora-sdk/*` dependency of any kind.**

### 3.2 Surface

Sketch, not a mandate — shape it properly during your brainstorm:

- `<PublicReadProvider baseUrl projectId>` — holds config, constructs the REST client. Deliberately
  parallel to `SocialProvider`, minus the token and the feature-gate fetch.
- `usePublicEntity(entityId)` → `{ entity, loading, notFound }`
- `usePublicComments(entityId, { parentId, page, limit, sortBy })` → paginated flat list
- `usePublicCommentThread(entityId, { limit, offset })` → the nested tree
- `<PublicComments entityId />` in `react-js` — the drop-in a blog page mounts.

### 3.3 The auth-swap contract (this is the important bit)

The consuming app renders **one or the other**, never both, and a login **remounts**:

```tsx
{user
  ? <CommentSection entityId={id} />        // @agora-sdk/react-js — authed, full read+write
  : <PublicComments  entityId={id} />}      // @agora-sdk/public-read-react-js — anonymous, read-only
```

**Design implications you must honor:**

- **Zero shared state between the two.** No shared cache, no handoff, no attempt to preserve scroll
  position or expanded replies across the swap. The public tree unmounts and the authed one fetches
  from scratch. We evaluated a seamless in-place upgrade and **rejected it** — it would force a
  shared tree/state layer straddling both repos, which is precisely the coupling this split exists
  to avoid.
- **`<PublicComments>` must render correctly with no `<ReplykeProvider>` anywhere in the tree.** A
  third-party blog embedding a thread has no Agora SDK installed at all. This is a hard requirement
  and worth an explicit test.
- **It must also render correctly *inside* a `<ReplykeProvider>`** without picking up its token,
  latch, or interceptors — the common case is one app that renders both depending on auth state.
- **Read-only means read-only.** No comment box, no reaction buttons, no reply affordance. Provide
  an optional `onSignInRequired` callback so the host app can render its own "sign in to join the
  conversation" CTA, but ship no auth UI and no auth dependency.

---

## 4. Explicitly out of scope

- **`PATCH /entities/:id/visibility`** — the privileged publish toggle. It is an *authed* mutation
  and does not belong in a tokenless read package. Our recommendation is that `agora-admin` calls
  it directly with its existing authed client, and that no library wraps it at v1. **Open decision,
  owned by the agora-sdk side — not a blocker for you.**
- Any write path whatsoever.
- Single-comment public permalinks — parked v2 on the server; the route does not exist.
- Public discovery listings (space-level or project-level "all public posts") — deliberately not
  built server-side. v1 is **by-direct-link only**: the caller must already know the entity id.
- Realtime. The public surface is REST-only; there is no anonymous socket namespace.

---

## 5. Testing expectations

Per this repo's engineering standard #5, unit tests ship in the same change. Mock the transport at
its boundary; no live server in the unit suite.

The **negative cases are the point** — mirror the server's security posture:

- 404 on every route renders the same neutral empty state, with **no** message distinguishing
  unpublished / missing / space-went-private.
- No `Authorization` header and no credentials are ever sent (assert on the outgoing request).
- Renders with no `ReplykeProvider` in the tree.
- Renders inside a `ReplykeProvider` without inheriting its token.
- Nested thread renders from the server's `replies[]` shape directly.
- Pagination: empty list, `hasMore` boundary, `parentId` reply paging.
- `userReaction: null` / absent `isSaved` do not crash the renderer.

An **opt-in e2e** against a locally running `agora-server` (`e2e/**`, gated on env vars like the
existing secure-chat e2e) would be valuable given the CORS and gate behavior can't be faithfully
unit-tested — but it's a nice-to-have, not a gate on v1.

---

## 6. Sequencing

The server work is planned but **not yet merged** (`feat/internet-public-entities`). Nothing here is
buildable until that lands and `@agora-server/contract` publishes a version carrying
`Entity.public`. Confirm the published contract version before starting; `social-core` currently
pins `^0.12.1` and `secure-chat-core` `^0.13.0`, while the contract is at `0.21.0` in-tree.

---

## 7. Open decisions for your spec

1. **Package naming** — `public-read` vs `embed` vs `public` (§3.1).
2. **`react-js` only, or the full four platforms?** We recommend web-only at v1.
3. **Thread vs. list as the default component fetch strategy** — the nested `/thread` route is one
   round trip and simpler; the paginated `/comments` route scales to long threads. A hybrid (thread
   for the first N roots, `?parentId=` paging for deep replies) may be right, but is more surface.
   Pick one deliberately.
4. **Does `<PublicComments>` ship unstyled, minimally styled, or fully styled?** The `social-react-js`
   components are a precedent worth matching, whatever they do.

---

## 8. References

- Server spec: `agora-server/docs/superpowers/specs/2026-07-18-internet-public-entities-design.md`
- Server plan: `agora-server/docs/superpowers/plans/2026-07-18-internet-public-entities.md`
- Fork divergence ledger (why this isn't divergence #9): `agora-sdk/SYNCING.md`, `agora-sdk/CLAUDE.md`
- Charter for this repo: `agora-sdk-plus/CLAUDE.md` §"What this repo is"
