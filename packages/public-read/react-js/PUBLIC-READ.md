# Agora Public Read — SDK Integration Guide 🌍

> **Audience:** app developers embedding an anonymous, read-only Agora comment thread.
> **Canonical wire contract:** `agora-server` → `docs/PUBLIC-API.md`
> **Design reference (internal):** `docs/superpowers/specs/2026-07-18-public-read-design.md`
> **Implemented by:** `@agora-sdk/public-read-core`, `@agora-sdk/public-read-react-js`

---

## Overview — the open door

Agora is **private by default**. Every `/v7/:projectId/*` route requires an authenticated account,
except one deliberate, narrow, auditable hole: the `/public/*` surface. It exists so a blog,
marketing page, or third-party site can embed a thread that **anyone** can read — no account, no
token, and no Agora SDK installed on the host page.

Visibility is a ladder. Each rung is a strict superset of the audience below it:

| Rung | Who can read | Enforced by |
|---|---|---|
| **Private** | active members of the space | `space.reading_permission = 'members'` |
| **Community-public** | any signed-in account on the project | `reading_permission = 'anyone'`, behind the auth wall |
| **Internet-public** | anyone, no account | `entities.is_public` + this surface |

A post may only become internet-public if it is *already* community-public. That is not a detail —
it is what makes the feature safe. A thread whose comments were written under an expectation of
privacy can never be retroactively published to the world.

```tsx
import { PublicReadProvider, PublicComments } from "@agora-sdk/public-read-react-js";

<PublicReadProvider
  projectId="11111111-1111-1111-1111-111111111111"
  baseUrl="https://api.example.com/v7"
>
  <PublicComments foreignId="homepage-comments" />
</PublicReadProvider>;
```

That is the whole integration. No token, no `<ReplykeProvider>`, no auth wiring.

---

## 1. Setup — `<PublicReadProvider>`

| Prop | Type | Notes |
|---|---|---|
| `projectId` | `string` | **required** — path-scoped on every endpoint |
| `baseUrl` | `string` | **required** — include the version prefix, e.g. `https://api.example.com/v7` |

There is deliberately **no token prop**. `PublicReadRestConfig` has no credential field at all, so no
code path in this package can attach one — see §7.

The provider issues **no request on mount**. Unlike `SocialProvider` there is no transparency or
feature-gate endpoint to resolve, so there is nothing to wait on and no loading gate.

Two guarantees it satisfies structurally:

- **Works with no `<ReplykeProvider>` anywhere in the tree.** A third-party blog has no Agora SDK
  installed at all. This package has zero `@agora-sdk/*` dependencies.
- **Works *inside* a `<ReplykeProvider>` without inheriting its token, boot latch, or interceptors.**
  It owns a bare axios instance; there is no code path that could read the SDK's.

---

## 2. Addressing an anchor — `usePublicEntity`

```ts
usePublicEntity(target, opts?) → { entity, entityId, loading, notFound, error, refresh }
```

`target` is a uuid string, `{ entityId }`, or `{ foreignId }`.

### By `foreignId` (what an embed should use, and why)

The entity's uuid is **generated per install**, so a blog template cannot hardcode it. `foreignId` is
the key your app already chose — `"homepage-comments"`, a post slug — and it is stable everywhere.

```tsx
const { entity, entityId, notFound } = usePublicEntity({ foreignId: "homepage-comments" });
```

### The two-step, and its extra round trip

`by-foreign-id` resolves the **entity only**. The comment routes remain uuid-only, mirroring the
server exactly rather than inventing an addressing mode the API doesn't have. So a `foreignId`
costs one extra round trip on first paint, and hooks chain to sequence it:

```tsx
const { entityId } = usePublicEntity({ foreignId: "homepage-comments" });
const { nodes } = usePublicCommentThread(entityId);   // no-ops until entityId resolves
```

Every comment hook accepts `null` and no-ops, which is what makes the chain safe without a guard.
`<PublicComments foreignId="…">` does this internally so you never write it.

### Guessability — `foreignId` is not a secret

Because you choose it, a `foreignId` is often guessable (`"homepage-comments"`). The surface is
by-direct-link only — there is no discovery listing — but that is not the same as being hidden. If
you want an internet-public entity to be genuinely hard to find, address it by uuid and give it an
unguessable `foreignId` (or none).

### Error handling

| Situation | Result |
|---|---|
| Gate rejects, or unknown `foreignId` | `notFound: true`, `error: null` |
| Empty `foreignId` (`400 entities/missing-foreign-id`) | `error` set — a **caller bug**, not an empty page |
| Wrong `projectId` (`404 project/not-found`) | `error` set — host misconfiguration must stay visible |
| Network / `5xx` | `error` set |

---

## 3. The thread — `usePublicCommentThread`

```ts
usePublicCommentThread(entityId, { rootId?, limit?, include? })
  → { nodes, loading, notFound, error, hasMore, page, loadMore, refresh }
```

One round trip for the entire nested thread. Defaults: `limit: 50` root nodes (clamped to 100).

### Response — `PublicCommentNode`

```ts
type PublicCommentNode = Comment & { replies: PublicCommentNode[] };
```

Parents always arrive before children, and removed comments are pruned **along with their descendant
subtrees** (a post-filter would orphan the children).

### Why it is not reassembled client-side

The walled surface only serves flat pages, which is why `@agora-sdk/core` ships
`helpers/addCommentsToTree.ts`. This surface nests server-side, so that helper is not ported —
copying it would buy nothing and create a drift liability against a fork this package does not
depend on.

`hasMore` is **inferred** from a full page, because this route sends no pagination envelope. That
costs one wasted final request when the root count divides evenly by the page size — a better trade
than inventing a count the server never gave us.

---

## 4. The flat list — `usePublicComments`

```ts
usePublicComments(entityId, { parentId?, limit?, sortBy?, sortDir?, include? })
  → { comments, loading, notFound, error, hasMore, page, loadMore,
      sortBy, setSortBy, sortDir, setSortDir, refresh }
```

One level at a time, offset-paginated. `loadMore` **appends**. Changing sort resets to page 1 — a
page-2 offset into a re-sorted list is meaningless.

| Option | Default | Notes |
|---|---|---|
| `limit` | `20` | clamped to `100` |
| `sortBy` | `createdAt` | `createdAt` · `top` · `controversial` |
| `sortDir` | `desc` | applies to `createdAt` only |
| `include` | *(none)* | `user` |

### Reply paging via `parentId`

Replies use this same hook with `parentId` set — the endpoint and the state machine are identical,
so a separate hook would be duplication.

> ⚠️ A malformed `parentId` `404`s, while a malformed `rootId` on the thread route is treated as
> **absent** (it serves the whole thread). Same-looking params, opposite failure modes.

**An empty list is not `notFound`.** A published entity with zero comments is a success.

---

## 5. The drop-in — `<PublicComments>`

| Prop | Notes |
|---|---|
| `entityId` / `foreignId` | exactly one; passing both throws in development |
| `mode` | `"thread"` (default) or `"paged"` |
| `limit` | page size |
| `className` | for host layout/spacing |
| `renderComment` | replace the comment chrome entirely |
| `emptyState` | replace the neutral empty state — keep it neutral (§7) |
| `onSignInRequired` | renders a CTA **only** when supplied; just calls back |

### `thread` vs `paged`

`thread` is one request and renders the whole conversation recursively — right for an embed, which
is the common case. `paged` fetches one level with a "Load more" control; prefer it for threads that
outgrow the 50-root default.

### Styling and `renderComment`

Self-contained inline styles with a `className` escape hatch — it drops into a blog and looks
finished with zero CSS. When that isn't enough, one render prop hands you total control:

```tsx
<PublicComments
  foreignId="homepage-comments"
  renderComment={(comment, { depth, children }) => (
    <MyComment comment={comment} depth={depth}>{children}</MyComment>
  )}
/>
```

If you override it, check `isTombstone(comment)` before rendering `content` — see §7.

---

## 6. The auth swap

Render one or the other, never both. A login **remounts**:

```tsx
{user
  ? <CommentSection entityId={id} />   // @agora-sdk/react-js — authed, read + write
  : <PublicComments  foreignId={key} />} // this package — anonymous, read-only
```

**There is zero shared state between the two.** No shared cache, no handoff, no preserved scroll
position or expanded replies. The public tree unmounts; the authed one fetches from scratch. A
seamless in-place upgrade was considered and rejected: it would force a shared tree/state layer
straddling two repos, which is precisely the coupling this split exists to avoid.

---

## 7. What you must never render

### The 404 is deliberately ambiguous

The server's gate re-derives, live, on every request:

```
entity exists ∧ is_public ∧ not deleted ∧ not draft ∧ not moderation-removed
  ∧ (spaceless ∨ space.reading_permission = 'anyone')
```

Every failure collapses to the **same `404`** — never a `403`. Unpublished, missing, draft, removed,
and space-went-private are made indistinguishable *on purpose*, so the surface can never become an
existence oracle for private content.

So: **render one neutral empty state and never name a reason.** That is why `notFound` is a separate
boolean from `error`, and why `<PublicComments>` shows identical copy for an empty thread, a failed
anchor resolve, and a `404`.

### Never send a token or cookies

`/public/*` replies with `Access-Control-Allow-Origin: *` and never credentials. A credentialed
cross-origin request against a wildcard ACAO **fails CORS preflight**, so the embed would silently
stop working. This package makes that impossible: there is no token field in the transport config,
and the request interceptor strips any ambient `Authorization` and forces `withCredentials: false`
in case a host app set axios global defaults.

### Anonymous response shapes

| Field | On this surface |
|---|---|
| `userReaction` | always `null` — there is no viewer to attribute a reaction to |
| `user.birthdate` | always `null` |
| `user.metadata` | always `{}` |

The internet still gets `username`, `name`, `avatar`, and `bio`. Do not render a "you reacted"
affordance — there is no viewer.

### Tombstones

Author-deleted comments are **blanked in place** (Reddit-style placeholder, `userDeletedAt` set),
not omitted — on both the list and the thread. Their replies still render; the subtree outlives its
parent's content. `<PublicCommentNodeView>` handles this, but a `renderComment` override must check
`isTombstone(comment)` before rendering `content`.

---

## 8. Caching and takedown

Success responses carry:

```
Cache-Control: public, max-age=0, s-maxage=300, must-revalidate
ETag: "…"
```

| Directive | Effect |
|---|---|
| `max-age=0` | browsers revalidate every read — a reload is always authoritative |
| `s-maxage=300` | shared caches (CDN/proxy) may serve a stored copy for up to 5 minutes |
| `must-revalidate` | once stale, a cache must reach the origin; never serve stale on error |

Errors are `no-store`, so a cached `404` can never keep a freshly-published post invisible.

**This SDK adds no cache of its own, deliberately.** The browser already revalidates via
`If-None-Match` → `304` and serves the stored body transparently. Layering a client cache on top
would fight that and widen the takedown window below.

> ⚠️ **Takedown window.** An un-publish, moderation removal, or space-flip is instant at the origin
> and for any reader who reloads — but a shared cache may keep serving a stored copy for up to
> **300s**. Deployments needing hard-instant takedown should front the surface with a purgeable cache.

---

## 9. Not included

Deliberate omissions, not oversights:

- **No writes.** No reactions, no comment creation, no reporting. GET only.
- **No single-comment permalink** — the route does not exist.
- **No discovery.** There is no "all public posts" listing. By-direct-link only: you must know the
  entity's uuid or its `foreignId`.
- **No realtime.** REST only; there is no anonymous socket namespace. (The walled comment surface has
  no sockets either, so this loses nothing.)
- **No `createIfNotFound`** on `by-foreign-id`. The walled route has it; honouring it anonymously
  would hand callers a row-creation primitive.
- **No native packages.** Web-only at v1 — an anonymous internet reader is a browser. `core` is
  platform-agnostic, so `react-native`/`expo` can be added if a real use case appears.
- **No publish toggle.** `PATCH /entities/:id/visibility` is an authed mutation and does not belong
  in a tokenless read package.

---

## 10. TypeScript types quick-reference

```ts
// Provider + hooks
PublicReadProviderProps  { projectId, baseUrl, children }
PublicEntityTarget        string | { entityId } | { foreignId } | null | undefined
UsePublicEntityValues     { entity, entityId, loading, notFound, error, refresh }
UsePublicCommentsValues   { comments, loading, notFound, error, hasMore, page, loadMore,
                            sortBy, setSortBy, sortDir, setSortDir, refresh }
UsePublicCommentThreadValues { nodes, loading, notFound, error, hasMore, page, loadMore, refresh }

// Transport (SSR / non-React use)
PublicReadRestConfig      { getBaseUrl: () => string; projectId: string }   // no token field
PublicReadApiError        { status: number; code: string | null }
isNotFound(err)           → boolean   // the gate's neutral 404 only

// Wire
PublicCommentNode         Comment & { replies: PublicCommentNode[] }
PublicCommentsSortBy      "createdAt" | "top" | "controversial"
PUBLIC_COMMENTS_SORT_BY   readonly PublicCommentsSortBy[]
```

---

## 11. Package layout

| Package | Role | Status |
|---|---|---|
| `@agora-sdk/public-read-core` | transport + provider + hooks (platform-agnostic, tokenless) | ✅ shipped |
| `@agora-sdk/public-read-react-js` | web components; re-exports core (ESM-only) | ✅ shipped |

`core` has **no `@agora-sdk/*` dependency of any kind** — not a dependency, not a peer. Its only
runtime deps are `axios` and `@agora-server/contract` (types). That is what lets a third-party blog
install `@agora-sdk/public-read-react-js` alone and have a working thread.

---

*Source: `agora-server` — `apps/api/src/routes/public.ts`, `lib/public-access.ts`, `lib/public-cache.ts`, and `docs/PUBLIC-API.md`.*
