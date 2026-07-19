# `public-read` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@agora-sdk/public-read-core` + `@agora-sdk/public-read-react-js` — a tokenless, read-only client for agora-server's anonymous `/v7/:projectId/public/*` surface, so a third-party blog with no Agora SDK installed can embed a comment thread.

**Architecture:** A `PublicReadRestClient` (own bare `axios.create()`, **no token field in its config type**) is constructed and memoized by `<PublicReadProvider baseUrl projectId>`. Three hooks read the three routes; each exposes `notFound` as a first-class boolean separate from `error`, because the server's 404 is deliberately ambiguous. `react-js` adds `<PublicComments>`, which defaults to the one-shot nested `/thread` route and renders recursively.

**Tech Stack:** TypeScript 5.7, React 18/19 (peer), axios ^1.4, vitest 4 + @testing-library/react + jsdom, pnpm workspace, dual ESM/CJS via two tsconfigs (core) and ESM-only (react-js).

**Spec:** `docs/superpowers/specs/2026-07-18-public-read-design.md` — read it before starting.
**Server contract:** `../agora-server/docs/PUBLIC-API.md` — the authoritative wire reference.

## Global Constraints

Every task's requirements implicitly include this section.

- **No `@agora-sdk/*` dependency of any kind** — not a dependency, not a peer, not a devDependency. This package must work with no Agora SDK installed.
- **Contract floor is `@agora-server/contract@^0.21.0`** (published; carries `Entity.public`). Do **not** bump `social-core` (`^0.12.1`) or `secure-chat-core` (`^0.13.0`) — they don't need it and pnpm resolves the versions side by side.
- **The pagination meta type is `PaginationMeta`**, not `PaginationMetadata`.
- **Tokenless by construction.** `PublicReadRestConfig` must never gain a token/credential field.
- **404 is neutral.** No user-facing string may distinguish unpublished / missing / draft / removed / space-went-private.
- **No client-side caching.** The server ships `max-age=0, s-maxage=300, must-revalidate` + `ETag`; the browser revalidates for free. Adding memoization is a regression.
- **Never send `spaceReputation*` params** — accepted and silently ignored by the server.
- **Never send `createIfNotFound`** on `by-foreign-id`. The walled route has it; the public one omits it deliberately, because honouring it anonymously would be a row-creation primitive.
- **Comment routes are uuid-only.** `by-foreign-id` resolves the entity and nothing more, so `foreignId` addressing is a two-step. Do not invent a `foreignId` form the server doesn't have.
- **Local fixture:** project `11111111-1111-1111-1111-111111111111`, anchor `foreignId: "homepage-comments"`, seeded via `pnpm seed` from `agora-server/apps/api`. The anchor's uuid is generated per install — always address it by `foreignId`.
- All relative imports inside `src/` carry an explicit **`.js` extension** (the ESM build emits specifiers verbatim; `scripts/verify-dist.mjs` lints for it).
- Every exported symbol carries TSDoc (CLAUDE.md §2). `src/contract/` is exempt for re-exported types, but locally-declared types there are original code and **do** need it.
- Add a `CHANGELOG.md` bullet under `[Unreleased]` in the **same commit** as the code (CLAUDE.md §4).
- Test files are `*.test.ts(x)`, co-located, excluded from `tsc` builds. React tests need a `// @vitest-environment jsdom` first-line pragma.
- Run `pnpm run typecheck` and `pnpm test` before every commit.

---

## File Structure

```
packages/public-read/core/
  package.json                              new — dual ESM/CJS, mirrors social-core
  tsconfig.json  tsconfig.esm.json  tsconfig.cjs.json
  src/contract/index.ts                     type-only re-export + PublicCommentNode + const arrays
  src/transport/rest.ts                     PublicReadRestClient, PublicReadApiError, isNotFound
  src/transport/rest.test.ts
  src/context/public-read-context.tsx       PublicReadProvider, usePublicRead
  src/context/public-read-context.test.tsx
  src/hooks/usePublicEntity.tsx             + .test.tsx
  src/hooks/usePublicComments.tsx           + .test.tsx
  src/hooks/usePublicCommentThread.tsx      + .test.tsx
  src/index.ts                              barrel

packages/public-read/react-js/
  package.json                              new — ESM-only, copy:docs
  tsconfig.json  tsconfig.esm.json
  README.md
  src/components/PublicCommentNodeView.tsx  recursive renderer + tombstone  + .test.tsx
  src/components/PublicComments.tsx         mode="thread" | "paged"         + .test.tsx
  src/index.ts                              barrel, re-exports core

Modified:
  tsconfig.json          root — paths entry
  vitest.config.ts       root — alias entry
  package.json           root — 5 script lists
  scripts/verify-dist.mjs  generalize past packages/secure-chat
  docs/PUBLIC-READ.md    new integration guide
  README.md  ARCHITECTURE.md  STATUS.md  CHANGELOG.md  CLAUDE.md
```

---

### Task 1: `public-read-core` package + transport

Scaffolding is folded in here because the transport is the first thing that needs it.

**Files:**
- Create: `packages/public-read/core/package.json`, `tsconfig.json`, `tsconfig.esm.json`, `tsconfig.cjs.json`
- Create: `packages/public-read/core/src/contract/index.ts`
- Create: `packages/public-read/core/src/transport/rest.ts`
- Test: `packages/public-read/core/src/transport/rest.test.ts`
- Modify: root `tsconfig.json` (paths), root `vitest.config.ts` (alias), root `package.json` (5 scripts)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `PublicReadRestClient` with `getEntity(entityId, opts?) → Promise<Entity>`, `getEntityByForeignId(foreignId, opts?) → Promise<Entity>`, `getComments(entityId, opts?) → Promise<PaginatedResponse<Comment>>`, `getThread(entityId, opts?) → Promise<{ data: PublicCommentNode[] }>`; `PublicReadRestConfig { getBaseUrl: () => string; projectId: string }`; `PublicReadApiError { status: number; code: string | null }`; `isNotFound(err: unknown): boolean`; types `PublicCommentNode`, `PublicCommentsQuery`, `PublicThreadQuery`, `PublicEntityQuery`, `PublicCommentsSortBy`, `PublicSortDir`, `PublicCommentInclude`, `PublicEntityInclude`.

- [ ] **Step 1: Create the package manifest**

`packages/public-read/core/package.json`:

```json
{
  "name": "@agora-sdk/public-read-core",
  "version": "0.10.2",
  "private": false,
  "license": "Apache-2.0",
  "author": "Agora SDK Plus, maintained by Jenova Marie",
  "description": "Tokenless, read-only client for the Agora anonymous public surface: typed REST transport, provider + hooks for internet-public entities and their comment threads. No auth, no writes.",
  "keywords": ["agora", "public", "anonymous", "comments", "embed", "read-only", "react", "typescript"],
  "bugs": { "url": "https://github.com/agora-oss-org/agora-sdk-plus/issues" },
  "homepage": "https://github.com/agora-oss-org/agora-sdk-plus",
  "repository": {
    "type": "git",
    "url": "https://github.com/agora-oss-org/agora-sdk-plus.git",
    "directory": "packages/public-read/core"
  },
  "main": "dist/cjs/index.js",
  "module": "dist/esm/index.js",
  "types": "dist/esm/index.d.ts",
  "type": "module",
  "scripts": {
    "build:esm": "tsc -p tsconfig.esm.json",
    "build:cjs": "tsc -p tsconfig.cjs.json && echo '{\"type\":\"commonjs\"}' > dist/cjs/package.json",
    "build": "rimraf dist && pnpm run build:esm && pnpm run build:cjs",
    "prepublish": "pnpm run build"
  },
  "publishConfig": { "access": "public" },
  "files": ["dist"],
  "dependencies": {
    "@agora-server/contract": "^0.21.0",
    "axios": "^1.4.0"
  },
  "peerDependencies": { "react": "^18.0.0 || ^19.0.0" }
}
```

- [ ] **Step 2: Create the three tsconfigs**

`packages/public-read/core/tsconfig.json` (byte-identical to `packages/social/core/tsconfig.json`):

```json
{
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "target": "ES2020",
    "module": "esnext",
    "lib": ["ES2020", "dom"],
    "jsx": "react-jsx",
    "declaration": true,
    "sourceMap": true,
    "strict": true,
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"],
  "exclude": ["recycle_bin", "dist", "**/*.test.ts", "**/*.test.tsx"]
}
```

`packages/public-read/core/tsconfig.esm.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "outDir": "./dist/esm", "module": "esnext" }
}
```

`packages/public-read/core/tsconfig.cjs.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist/cjs",
    "module": "commonjs",
    "moduleResolution": "node",
    "ignoreDeprecations": "5.0"
  }
}
```

- [ ] **Step 3: Write the contract re-export**

`packages/public-read/core/src/contract/index.ts`:

```ts
// Wire types for the anonymous public-read surface, re-exported from @agora-server/contract.
//
// The dependency arrow is SDK → contract: agora-server owns the wire shapes, this package consumes
// them. Types are re-exported TYPE-ONLY (`export type { … } from`) because the contract is ESM-only
// and this package emits a CJS build too — `export type` is erased at emit, so dist/cjs never
// `require()`s it at runtime.
//
// Two things are declared locally rather than re-exported:
//   • PublicCommentNode — the server nests thread replies ad hoc and the contract has no type for it.
//   • The const arrays — a value re-export would survive erasure and break the CJS build, so they are
//     re-declared but TYPED against the local unions, making drift a compile error.
//
// Per CLAUDE.md §2 the re-exported types need no per-symbol TSDoc (the docs live in the contract);
// everything declared here is original code and carries it.

export type {
  Comment,
  Entity,
  PaginatedResponse,
  PaginationMeta,
  User,
} from "@agora-server/contract";

import type { Comment } from "@agora-server/contract";

/**
 * A comment in a server-nested thread response, carrying its replies inline.
 *
 * `GET /public/entities/:id/comments/thread` returns the subtree already assembled by the
 * `fetch_comment_thread` RPC (parents always before children), unlike the flat `/comments` route
 * which pages one level at a time. Recursive by construction: a leaf has `replies: []`.
 *
 * @remarks
 * Do **not** rebuild this client-side. The fork's `helpers/addCommentsToTree.ts` exists because the
 * walled surface only serves flat pages; this surface does the nesting server-side.
 */
export type PublicCommentNode = Comment & { replies: PublicCommentNode[] };

/**
 * Sort orders accepted by the public comment list.
 *
 * The server also still accepts the legacy `new` / `old` values, but they emit an RFC 8594
 * `Deprecation` header — this package does not expose them.
 */
export type PublicCommentsSortBy = "createdAt" | "top" | "controversial";

/** The {@link PublicCommentsSortBy} values, for building a sort picker. */
export const PUBLIC_COMMENTS_SORT_BY: readonly PublicCommentsSortBy[] = [
  "createdAt",
  "top",
  "controversial",
];

/** Sort direction. The server applies it only to `sortBy: "createdAt"`. */
export type PublicSortDir = "asc" | "desc";

/** Relations the public comment routes can inline. Only `user` is supported. */
export type PublicCommentInclude = "user";

/** Relations the public entity route can inline. */
export type PublicEntityInclude = "user" | "files";
```

- [ ] **Step 4: Write the failing transport test**

`packages/public-read/core/src/transport/rest.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { AxiosError, type AxiosInstance } from "axios";
import { PublicReadRestClient, PublicReadApiError, isNotFound } from "./rest.js";

/** Reach the client's private axios instance to stub `.get` at the boundary (no real network). */
function httpOf(client: PublicReadRestClient): AxiosInstance {
  return (client as unknown as { http: AxiosInstance }).http;
}

/** Build a real AxiosError (so `axios.isAxiosError` recognizes it) carrying a status + body. */
function axiosErr(status: number, data: unknown): AxiosError {
  return new AxiosError("request failed", "ERR_BAD_RESPONSE", undefined, undefined, {
    status, data, statusText: "", headers: {}, config: {} as never,
  });
}

const client = () =>
  new PublicReadRestClient({ projectId: "p1", getBaseUrl: () => "http://host/v7" });

afterEach(() => vi.restoreAllMocks());

describe("PublicReadRestClient", () => {
  it("scopes every request to {baseUrl}/{projectId}/public and strips a trailing slash", async () => {
    const c = new PublicReadRestClient({ projectId: "p1", getBaseUrl: () => "http://host/v7/" });
    const get = vi.spyOn(httpOf(c), "get").mockResolvedValue({ data: { id: "e1" } });
    await c.getEntity("e1");

    // The interceptor sets baseURL, so assert it by running the interceptor over a bare config.
    const req = { headers: new Headers() } as never;
    const handler = (httpOf(c).interceptors.request as unknown as {
      handlers: { fulfilled: (r: unknown) => { baseURL: string } }[];
    }).handlers[0].fulfilled;
    expect(handler({ headers: { delete: () => {} } }).baseURL).toBe("http://host/v7/p1/public");
    expect(get).toHaveBeenCalled();
    void req;
  });

  it("never attaches an Authorization header and never sends credentials", () => {
    const c = client();
    const deleted: string[] = [];
    const cfg = {
      headers: { delete: (n: string) => deleted.push(n) },
    } as unknown as { withCredentials?: boolean };
    const handler = (httpOf(c).interceptors.request as unknown as {
      handlers: { fulfilled: (r: unknown) => typeof cfg }[];
    }).handlers[0].fulfilled;

    const out = handler(cfg);
    expect(deleted).toContain("Authorization");
    expect(out.withCredentials).toBe(false);
  });

  it("sends no params at all when none are provided (server defaults win)", async () => {
    const c = client();
    const get = vi.spyOn(httpOf(c), "get").mockResolvedValue({ data: { data: [], pagination: {} } });
    await c.getComments("e1");
    expect(get).toHaveBeenCalledWith("/entities/e1/comments", undefined);
  });

  it("comma-joins include arrays and omits undefined params", async () => {
    const c = client();
    const get = vi.spyOn(httpOf(c), "get").mockResolvedValue({ data: { data: [], pagination: {} } });
    await c.getComments("e1", { include: ["user"], limit: 5, sortBy: undefined });
    expect(get).toHaveBeenCalledWith("/entities/e1/comments", {
      params: { include: "user", limit: 5 },
    });
  });

  it("resolves by foreignId on the dedicated route, as a query param", async () => {
    const c = client();
    const get = vi.spyOn(httpOf(c), "get").mockResolvedValue({ data: { id: "e1" } });
    await c.getEntityByForeignId("homepage-comments", { include: ["user"] });
    expect(get).toHaveBeenCalledWith("/entities/by-foreign-id", {
      params: { foreignId: "homepage-comments", include: "user" },
    });
  });

  it("never sends createIfNotFound on the public by-foreign-id route", async () => {
    // The walled route's flag lazily INSERTS an authorless anchor. Honouring it anonymously would be
    // a row-creation primitive, so the server omits it — and we must never send it.
    const c = client();
    const get = vi.spyOn(httpOf(c), "get").mockResolvedValue({ data: { id: "e1" } });
    await c.getEntityByForeignId("homepage-comments");
    expect(JSON.stringify(get.mock.calls[0])).not.toMatch(/createIfNotFound/i);
  });

  it("passes rootId through untouched (a malformed one is the server's business, not ours)", async () => {
    const c = client();
    const get = vi.spyOn(httpOf(c), "get").mockResolvedValue({ data: { data: [] } });
    await c.getThread("e1", { rootId: "not-a-uuid" });
    expect(get).toHaveBeenCalledWith("/entities/e1/comments/thread", {
      params: { rootId: "not-a-uuid" },
    });
  });

  it("normalizes an axios failure into PublicReadApiError with status + code", async () => {
    const c = client();
    vi.spyOn(httpOf(c), "get").mockRejectedValue(
      axiosErr(404, { error: "Not found", code: "entities/not-found" })
    );
    await expect(c.getEntity("e1")).rejects.toMatchObject({
      name: "PublicReadApiError",
      status: 404,
      code: "entities/not-found",
    });
  });

  it("reports status 0 for a network-level failure", async () => {
    const c = client();
    vi.spyOn(httpOf(c), "get").mockRejectedValue(
      new AxiosError("network down", "ERR_NETWORK")
    );
    await expect(c.getThread("e1")).rejects.toMatchObject({ status: 0, code: null });
  });
});

describe("isNotFound", () => {
  it("is true for the gate's 404 — the neutral, deliberately ambiguous case", () => {
    expect(isNotFound(new PublicReadApiError("x", 404, "entities/not-found"))).toBe(true);
  });

  it("is true for a bare 404 with no code", () => {
    expect(isNotFound(new PublicReadApiError("x", 404, null))).toBe(true);
  });

  it("is FALSE for project/not-found — a wrong projectId is host misconfiguration, not an empty thread", () => {
    expect(isNotFound(new PublicReadApiError("x", 404, "project/not-found"))).toBe(false);
  });

  it("is false for other statuses and for non-PublicReadApiError values", () => {
    expect(isNotFound(new PublicReadApiError("x", 500, null))).toBe(false);
    expect(isNotFound(new Error("boom"))).toBe(false);
    expect(isNotFound(null)).toBe(false);
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `pnpm test packages/public-read/core/src/transport/rest.test.ts`
Expected: FAIL — `Failed to resolve import "./rest.js"`.

- [ ] **Step 6: Write the transport**

`packages/public-read/core/src/transport/rest.ts`:

```ts
// Typed REST client for the Agora anonymous public-read surface (internet-public entities + their
// comment threads). Covers all three routes in agora-server `docs/PUBLIC-API.md` §3, path-scoped to
// `{baseUrl}/{projectId}/public`.
//
// TOKENLESS BY CONSTRUCTION. `PublicReadRestConfig` has no token field, so no code path in this
// package can attach a credential. That is a security property, not an ergonomic one: `/public/*`
// answers with `Access-Control-Allow-Origin: *` and never credentials, and a credentialed request
// against a wildcard ACAO fails CORS preflight in the browser — the embed would simply stop working.
// The interceptor additionally strips any ambient `Authorization` and forces `withCredentials: false`,
// because a host app can set axios *global* defaults that would otherwise leak into this instance.
//
// This client also deliberately owns a BARE `axios.create()` rather than reusing @agora-sdk/core's:
// that one is wrapped in `withAuthTransport`, which blocks every request on a boot latch released
// only by the auth-init thunk — an anonymous flow would hang forever.
//
// No caching is layered here, on purpose. The server sends `max-age=0, s-maxage=300,
// must-revalidate` + `ETag`, so the browser revalidates every read for free and a takedown is
// instant for anyone who reloads. A client-side cache would fight that and widen the takedown window.

import axios, { AxiosInstance } from "axios";
import type {
  Comment,
  Entity,
  PaginatedResponse,
  PublicCommentInclude,
  PublicCommentNode,
  PublicCommentsSortBy,
  PublicEntityInclude,
  PublicSortDir,
} from "../contract/index.js";

/**
 * Configuration for {@link PublicReadRestClient}.
 *
 * The base URL is read through a resolver rather than captured once, so a late-set value takes
 * effect on the next request without rebuilding the client.
 *
 * @remarks
 * There is deliberately **no** token or credential field. See the file header.
 */
export interface PublicReadRestConfig {
  /** Resolve the API base URL incl. the version prefix (e.g. `() => "https://host/v7"`). */
  getBaseUrl: () => string;
  /** The Agora project id (path-scoped on every endpoint). */
  projectId: string;
}

/** Query options for {@link PublicReadRestClient.getEntity}. */
export interface PublicEntityQuery {
  /** Relations to inline. Omit for none. */
  include?: PublicEntityInclude[];
}

/** Query options for {@link PublicReadRestClient.getComments}. */
export interface PublicCommentsQuery {
  /**
   * Page the replies under this comment instead of top-level comments.
   *
   * @remarks
   * A malformed value makes the server respond `404` — unlike `rootId` on the thread route, which
   * the server treats as absent. The two are not interchangeable.
   */
  parentId?: string;
  /** 1-based page number. Server default `1`. */
  page?: number;
  /** Page size. Server default `20`, clamped to `100`. */
  limit?: number;
  /** Sort order. Server default `createdAt`. */
  sortBy?: PublicCommentsSortBy;
  /** Sort direction. Server default `desc`; applies to `sortBy: "createdAt"` only. */
  sortDir?: PublicSortDir;
  /** Relations to inline. */
  include?: PublicCommentInclude[];
}

/** Query options for {@link PublicReadRestClient.getThread}. */
export interface PublicThreadQuery {
  /**
   * Root of the subtree to fetch. Omit for the whole thread.
   *
   * @remarks
   * A malformed value is treated by the server as **absent** (it serves the whole thread) rather
   * than erroring — the opposite of {@link PublicCommentsQuery.parentId}. Passed through untouched.
   */
  rootId?: string;
  /** 1-based page number over root nodes. Server default `1`. */
  page?: number;
  /** Max root nodes. Server default `50`, clamped to `100`. */
  limit?: number;
  /** Relations to inline. */
  include?: PublicCommentInclude[];
}

/**
 * A failed public-read API call, carrying the HTTP `status` and the server's machine `code`.
 *
 * @remarks
 * Do not render `message` to end users on a `404`: the gate makes unpublished / missing / draft /
 * removed / space-went-private indistinguishable by design. Use {@link isNotFound} and show one
 * neutral empty state.
 */
export class PublicReadApiError extends Error {
  /** HTTP status code, or `0` when the request never got a response (network error). */
  readonly status: number;
  /** The server's machine error code (e.g. `entities/not-found`), or `null` if none was sent. */
  readonly code: string | null;

  /**
   * @param message - Human-readable summary (developer-facing; never rendered to readers).
   * @param status - HTTP status code (`0` for a network-level failure).
   * @param code - The server's machine error code, or `null`.
   */
  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = "PublicReadApiError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Whether an error is the public gate's "nothing to show here" `404`.
 *
 * The gate re-derives `exists ∧ is_public ∧ not deleted ∧ not draft ∧ not moderation-removed ∧
 * (spaceless ∨ space readable by anyone)` on every request and collapses every failure to the same
 * `404` (`PUBLIC-API.md` §4). Hooks use this to set a neutral `notFound` flag rather than an error.
 *
 * `project/not-found` is excluded on purpose: a wrong `projectId` is host **misconfiguration**, and
 * silently rendering an empty thread would hide an integration bug from the developer who caused it.
 *
 * @param err - Any caught error.
 * @returns `true` for the gate's 404; `false` for `project/not-found`, other statuses, and non-API errors.
 */
export function isNotFound(err: unknown): boolean {
  return (
    err instanceof PublicReadApiError && err.status === 404 && err.code !== "project/not-found"
  );
}

/**
 * Build an axios `params` object from a sparse source: drop `undefined` entries and comma-join
 * arrays (the server reads `include` as a comma-separated list). Returns `undefined` when nothing
 * survives, so the request carries no query string at all and every server default applies.
 */
function buildParams(src: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(",") : value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Typed REST client for the three anonymous public-read endpoints.
 *
 * @remarks
 * Construct this directly only for advanced / non-React use (SSR, static generation). Inside React,
 * prefer `<PublicReadProvider>` + the `usePublic*` hooks, which build and share one client.
 *
 * @example
 * ```typescript
 * const rest = new PublicReadRestClient({
 *   projectId,
 *   getBaseUrl: () => "https://api.example.com/v7",
 * });
 * const { data } = await rest.getThread(entityId, { include: ["user"] });
 * ```
 */
export class PublicReadRestClient {
  private readonly http: AxiosInstance;

  /** @param config - Lazy base-URL resolver plus the path-scoped project id. */
  constructor(private readonly config: PublicReadRestConfig) {
    this.http = axios.create();
    this.http.interceptors.request.use((req) => {
      const base = config.getBaseUrl().replace(/\/$/, "");
      req.baseURL = `${base}/${config.projectId}/public`;
      // Strip any ambient credential rather than trusting that nothing set one — see file header.
      req.headers.delete("Authorization");
      req.withCredentials = false;
      return req;
    });
  }

  /**
   * Fetch an internet-public entity.
   *
   * @param entityId - The entity id. The caller must already know it — this surface has no discovery.
   * @param opts - Optional relations to inline.
   * @returns The shaped entity (a bare object, not a `{ data }` envelope).
   * @throws {PublicReadApiError} `404` when the gate rejects (see {@link isNotFound}).
   */
  async getEntity(entityId: string, opts?: PublicEntityQuery): Promise<Entity> {
    return this.get<Entity>(
      `/entities/${encodeURIComponent(entityId)}`,
      buildParams({ include: opts?.include })
    );
  }

  /**
   * Resolve a published anchor by the host app's own stable key.
   *
   * The entity's uuid is generated per install, so an embed cannot hardcode it — `foreignId` (a post
   * slug, `"homepage-comments"`, …) is the handle a blog should address the thread with.
   *
   * @param foreignId - The host app's key. Required; an empty value is `400 entities/missing-foreign-id`.
   * @param opts - Optional relations to inline.
   * @returns The shaped entity — the same shape `getEntity` returns, through the same gate.
   * @throws {PublicReadApiError} `404` when the gate rejects or the key is unknown; `400
   *   entities/missing-foreign-id` when `foreignId` is empty (a caller bug, **not** {@link isNotFound}).
   *
   * @remarks
   * This resolves the **entity only** — the comment routes remain uuid-only. Chain the returned
   * `id` into {@link getThread} / {@link getComments}. Note also that there is deliberately no
   * `createIfNotFound` here (unlike the walled route): honouring it anonymously would hand callers a
   * row-creation primitive.
   */
  async getEntityByForeignId(foreignId: string, opts?: PublicEntityQuery): Promise<Entity> {
    return this.get<Entity>(
      "/entities/by-foreign-id",
      buildParams({ foreignId, include: opts?.include })
    );
  }

  /**
   * Fetch one level of comments — top-level by default, or the replies under `parentId`.
   *
   * @param entityId - The entity whose comments to read.
   * @param opts - Paging, sorting, `parentId`, and relations.
   * @returns The standard `{ data, pagination }` envelope.
   * @throws {PublicReadApiError} `404` when the gate rejects **or** when `parentId` is malformed.
   */
  async getComments(
    entityId: string,
    opts?: PublicCommentsQuery
  ): Promise<PaginatedResponse<Comment>> {
    return this.get<PaginatedResponse<Comment>>(
      `/entities/${encodeURIComponent(entityId)}/comments`,
      buildParams({
        parentId: opts?.parentId,
        page: opts?.page,
        limit: opts?.limit,
        sortBy: opts?.sortBy,
        sortDir: opts?.sortDir,
        include: opts?.include,
      })
    );
  }

  /**
   * Fetch the server-nested comment thread in one round trip.
   *
   * @param entityId - The entity whose thread to read.
   * @param opts - `rootId`, paging over root nodes, and relations.
   * @returns `{ data }` — nested nodes, parents before children. **No pagination envelope.**
   * @throws {PublicReadApiError} `404` when the gate rejects.
   */
  async getThread(
    entityId: string,
    opts?: PublicThreadQuery
  ): Promise<{ data: PublicCommentNode[] }> {
    return this.get<{ data: PublicCommentNode[] }>(
      `/entities/${encodeURIComponent(entityId)}/comments/thread`,
      buildParams({
        rootId: opts?.rootId,
        page: opts?.page,
        limit: opts?.limit,
        include: opts?.include,
      })
    );
  }

  /**
   * Shared GET helper: issues the request and normalizes any axios failure into a
   * {@link PublicReadApiError} carrying the HTTP status + the server's machine code.
   */
  private async get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    try {
      const { data } = await this.http.get<T>(path, params ? { params } : undefined);
      return data;
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status ?? 0;
        const code = extractCode(err.response?.data);
        throw new PublicReadApiError(
          code ? `Public read failed: ${code}` : `Public read failed (HTTP ${status}).`,
          status,
          code
        );
      }
      throw err;
    }
  }
}

/**
 * Pull the server's machine error code out of an arbitrary error body. agora-server error shapes
 * vary (`{ error: { code } }`, `{ code }`, or `{ error: "…" }`), so probe each defensively and fall
 * back to `null`. Never throws.
 */
function extractCode(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const body = data as Record<string, unknown>;
  const nested = body.error;
  if (
    nested &&
    typeof nested === "object" &&
    typeof (nested as Record<string, unknown>).code === "string"
  ) {
    return (nested as Record<string, unknown>).code as string;
  }
  if (typeof body.code === "string") return body.code;
  if (typeof nested === "string") return nested;
  return null;
}
```

- [ ] **Step 7: Wire the root typecheck + test resolution**

In root `tsconfig.json`, add to `compilerOptions.paths` (after the `social-core` line):

```json
      "@agora-sdk/public-read-core": ["packages/public-read/core/src/index.ts"],
```

In root `vitest.config.ts`, add inside `alias` (after the `social-core` entry):

```ts
      // Alias the public-read workspace package to its SOURCE so public-read-react-js component
      // tests can import the public `@agora-sdk/public-read-core` entry without a build.
      "@agora-sdk/public-read-core": fromHere("packages/public-read/core/src/index.ts"),
```

> Note: `src/index.ts` does not exist until Task 2. That is fine — nothing imports the alias yet, and `tsc` only resolves `paths` on demand.

- [ ] **Step 8: Add the package to all five root scripts**

In root `package.json`, insert `@agora-sdk/public-read-core` **before** `@agora-sdk/auth-react-js` in each of `build-all`, `version:patch`, `version:minor`, `publish-prod`, `publish-beta`. In `build-all` that is `&& pnpm --filter @agora-sdk/public-read-core run build`; in the other four it is `--filter @agora-sdk/public-read-core`.

- [ ] **Step 9: Install and run the test**

Run: `pnpm install && pnpm test packages/public-read/core/src/transport/rest.test.ts`
Expected: PASS, 13 tests. `pnpm install` fetches `@agora-server/contract@0.21.0` alongside the existing 0.12.1 / 0.13.0 — that is expected and correct.

- [ ] **Step 10: Typecheck**

Run: `pnpm run typecheck`
Expected: clean exit, no output.

- [ ] **Step 11: Add the changelog entry**

Under `## [Unreleased]` → `### Added` in `CHANGELOG.md`:

```markdown
- **`@agora-sdk/public-read-core` — new package: tokenless transport for the anonymous public surface.**
  `PublicReadRestClient` covers agora-server's four `/v7/:projectId/public/*` routes (entity by uuid,
  entity by `foreignId`, flat comment list, server-nested thread). Its config type has **no token
  field**, so no code path can
  attach a credential — `/public/*` replies with a wildcard `Access-Control-Allow-Origin` and never
  credentials, and a credentialed cross-origin request would fail preflight. The request interceptor
  additionally strips any ambient `Authorization` and forces `withCredentials: false`, since a host
  app can set axios global defaults. Failures normalize to `PublicReadApiError` (`status` + machine
  `code`); the exported `isNotFound` predicate isolates the gate's deliberately-ambiguous `404` while
  excluding `project/not-found`, which is host misconfiguration and must stay visible to the developer.
```

- [ ] **Step 12: Commit**

```bash
git add packages/public-read/core tsconfig.json vitest.config.ts package.json pnpm-lock.yaml CHANGELOG.md
git commit -m "feat(public-read): tokenless REST transport for the anonymous public surface"
```

---

### Task 2: `PublicReadProvider` + `usePublicRead` + barrel

**Files:**
- Create: `packages/public-read/core/src/context/public-read-context.tsx`
- Create: `packages/public-read/core/src/index.ts`
- Test: `packages/public-read/core/src/context/public-read-context.test.tsx`

**Interfaces:**
- Consumes: `PublicReadRestClient`, `PublicReadRestConfig` from Task 1.
- Produces: `<PublicReadProvider baseUrl projectId>`; `usePublicRead(): PublicReadContextValue` where `PublicReadContextValue = { rest: PublicReadRestClient; projectId: string }`; `PublicReadProviderProps`.

- [ ] **Step 1: Write the failing provider test**

`packages/public-read/core/src/context/public-read-context.test.tsx`:

```tsx
// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { PublicReadProvider, usePublicRead } from "./public-read-context.js";
import { PublicReadRestClient } from "../transport/rest.js";

const wrap =
  (props?: { projectId?: string; baseUrl?: string }) =>
  ({ children }: { children: React.ReactNode }) => (
    <PublicReadProvider
      projectId={props?.projectId ?? "p1"}
      baseUrl={props?.baseUrl ?? "http://host/v7"}
    >
      {children}
    </PublicReadProvider>
  );

afterEach(() => vi.restoreAllMocks());

describe("PublicReadProvider", () => {
  it("exposes a REST client and the project id, with no config fetch on mount", () => {
    // Unlike SocialProvider there is no transparency endpoint on the public surface, so mounting
    // must issue ZERO requests — a network call here would be a design regression.
    const getEntity = vi.spyOn(PublicReadRestClient.prototype, "getEntity");
    const getComments = vi.spyOn(PublicReadRestClient.prototype, "getComments");
    const getThread = vi.spyOn(PublicReadRestClient.prototype, "getThread");

    const { result } = renderHook(() => usePublicRead(), { wrapper: wrap() });

    expect(result.current.rest).toBeInstanceOf(PublicReadRestClient);
    expect(result.current.projectId).toBe("p1");
    expect(getEntity).not.toHaveBeenCalled();
    expect(getComments).not.toHaveBeenCalled();
    expect(getThread).not.toHaveBeenCalled();
  });

  it("keeps the same client identity across re-renders with unchanged props", () => {
    const { result, rerender } = renderHook(() => usePublicRead(), { wrapper: wrap() });
    const first = result.current.rest;
    rerender();
    expect(result.current.rest).toBe(first);
  });

  it("throws when used outside a provider", () => {
    // Suppress the two channels React 18's dev build uses to surface the (expected) render-time
    // throw, so this negative case stays quiet:
    //  1. console.error — React's "The above error occurred" boundary suggestion.
    //  2. The window "error" event — React re-dispatches the throw onto a detached node, jsdom
    //     catches it and reports via its `jsdomError` virtual-console channel (NOT console.error).
    //     jsdom's reportException honors defaultPrevented, so a preventDefault listener silences it.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const swallowError = (event: ErrorEvent) => event.preventDefault();
    window.addEventListener("error", swallowError);
    try {
      expect(() => renderHook(() => usePublicRead())).toThrow(/within a <PublicReadProvider>/);
    } finally {
      window.removeEventListener("error", swallowError);
      errSpy.mockRestore();
    }
  });

  it("renders with no ReplykeProvider anywhere in the tree (the third-party embed case)", () => {
    // This is the whole point of the package: a blog embedding a thread has no Agora SDK installed.
    // The test asserts it by simply not providing one — if any code path reached for SDK context or
    // its boot latch, this would throw or hang.
    const { result } = renderHook(() => usePublicRead(), { wrapper: wrap() });
    expect(result.current.rest).toBeInstanceOf(PublicReadRestClient);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test packages/public-read/core/src/context/public-read-context.test.tsx`
Expected: FAIL — `Failed to resolve import "./public-read-context.js"`.

- [ ] **Step 3: Write the provider**

`packages/public-read/core/src/context/public-read-context.tsx`:

```tsx
// PublicReadProvider — constructs and shares the tokenless public-read REST client.
//
// Deliberately simpler than SocialProvider: there is no token prop and NO mount-time fetch, because
// the anonymous surface has no transparency/feature-gate endpoint to resolve. There is nothing to
// load, so there is no `loading` gate and no all-disabled sentinel — this provider memoizes a client
// and stops.
//
// Two hard requirements it satisfies structurally (see docs/PUBLIC-READ.md §6):
//   • Works with NO <ReplykeProvider> in the tree — a third-party blog has no Agora SDK installed.
//   • Works INSIDE one without inheriting its token, boot latch, or interceptors — there is no code
//     path here that could read them.

import React, { createContext, useContext, useMemo } from "react";

import { PublicReadRestClient } from "../transport/rest.js";

/** The value exposed by {@link usePublicRead}. */
export interface PublicReadContextValue {
  /** REST client for the three anonymous public endpoints. */
  rest: PublicReadRestClient;
  /** The Agora project id this client is scoped to. */
  projectId: string;
}

const PublicReadContext = createContext<PublicReadContextValue | null>(null);

/** Props for {@link PublicReadProvider}. */
export interface PublicReadProviderProps {
  /** Agora project id (path-scoped on every endpoint). */
  projectId: string;
  /**
   * API base URL including the version prefix (e.g. `https://api.example.com/v7`). Required — this
   * is a standalone transport and resolves no URL from any ambient SDK runtime. Read lazily per
   * request, so re-passing a changed value takes effect on the next call.
   */
  baseUrl: string;
  children: React.ReactNode;
}

/**
 * Provides the tokenless public-read REST client to the `usePublic*` hooks and components.
 *
 * Takes no access token and issues no request on mount.
 *
 * @param props - {@link PublicReadProviderProps}.
 * @returns A context provider wrapping `children`.
 *
 * @example
 * ```tsx
 * <PublicReadProvider projectId={projectId} baseUrl="https://api.example.com/v7">
 *   <PublicComments entityId={entityId} />
 * </PublicReadProvider>
 * ```
 */
export function PublicReadProvider({ projectId, baseUrl, children }: PublicReadProviderProps) {
  const rest = useMemo(
    () => new PublicReadRestClient({ projectId, getBaseUrl: () => baseUrl }),
    [projectId, baseUrl]
  );

  const value = useMemo<PublicReadContextValue>(() => ({ rest, projectId }), [rest, projectId]);

  return <PublicReadContext.Provider value={value}>{children}</PublicReadContext.Provider>;
}

/**
 * Access the nearest {@link PublicReadContextValue}.
 *
 * @returns The shared REST client and project id.
 * @throws {Error} When called outside a `<PublicReadProvider>`.
 */
export function usePublicRead(): PublicReadContextValue {
  const ctx = useContext(PublicReadContext);
  if (!ctx) {
    throw new Error("usePublicRead must be used within a <PublicReadProvider>.");
  }
  return ctx;
}
```

- [ ] **Step 4: Write the barrel**

`packages/public-read/core/src/index.ts`:

```ts
// @agora-sdk/public-read-core — tokenless, read-only client for the Agora anonymous public surface.
//
// Typed REST transport + provider/hooks for internet-public entities and their comment threads.
// No auth, no writes, no realtime, no persistence. Platform packages
// (@agora-sdk/public-read-react-js) re-export this and add the visual components.

// ── context / provider ──────────────────────────────────────────────────────
export { PublicReadProvider, usePublicRead } from "./context/public-read-context.js";
export type {
  PublicReadProviderProps,
  PublicReadContextValue,
} from "./context/public-read-context.js";

// ── transport (for advanced / non-React use — SSR, static generation) ────────
export { PublicReadRestClient, PublicReadApiError, isNotFound } from "./transport/rest.js";
export type {
  PublicReadRestConfig,
  PublicEntityQuery,
  PublicCommentsQuery,
  PublicThreadQuery,
} from "./transport/rest.js";

// ── wire contract types + runtime const arrays ───────────────────────────────
export { PUBLIC_COMMENTS_SORT_BY } from "./contract/index.js";
export type {
  Comment,
  Entity,
  PaginatedResponse,
  PaginationMeta,
  User,
  PublicCommentNode,
  PublicCommentsSortBy,
  PublicSortDir,
  PublicCommentInclude,
  PublicEntityInclude,
} from "./contract/index.js";
```

> Hooks are appended to this barrel in Tasks 3–5.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test packages/public-read/core/src/context/public-read-context.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 6: Typecheck**

Run: `pnpm run typecheck`
Expected: clean exit.

- [ ] **Step 7: Commit**

Add to `CHANGELOG.md` under `[Unreleased]` → `### Added`:

```markdown
- **`@agora-sdk/public-read-core` — `<PublicReadProvider>` + `usePublicRead`.** Constructs and
  memoizes the tokenless REST client. Takes no token prop and issues **no** request on mount (the
  public surface has no transparency endpoint), so there is no loading gate to wait on. Renders both
  with no `<ReplykeProvider>` in the tree and inside one without inheriting its token or boot latch.
```

```bash
git add packages/public-read/core CHANGELOG.md
git commit -m "feat(public-read): PublicReadProvider + usePublicRead + core barrel"
```

---

### Task 3: `usePublicEntity`

**Files:**
- Create: `packages/public-read/core/src/hooks/usePublicEntity.tsx`
- Modify: `packages/public-read/core/src/index.ts`
- Test: `packages/public-read/core/src/hooks/usePublicEntity.test.tsx`

**Interfaces:**
- Consumes: `usePublicRead()` (Task 2), `isNotFound`, `PublicEntityQuery`, `Entity` (Task 1).
- Produces:
  ```ts
  type PublicEntityTarget = string | { entityId: string } | { foreignId: string } | null | undefined;
  interface UsePublicEntityValues {
    entity: Entity | null;
    /** The resolved uuid — chain this into the uuid-only comment hooks. */
    entityId: string | null;
    loading: boolean;
    notFound: boolean;
    error: unknown;
    refresh: () => Promise<void>;
  }
  function usePublicEntity(target: PublicEntityTarget, opts?: PublicEntityQuery): UsePublicEntityValues;
  ```
  A bare string is treated as a uuid. Returning `entityId` is what makes the `foreignId` two-step composable.

- [ ] **Step 1: Write the failing test**

`packages/public-read/core/src/hooks/usePublicEntity.test.tsx`:

```tsx
// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { PublicReadProvider } from "../context/public-read-context.js";
import { usePublicEntity } from "./usePublicEntity.js";
import { PublicReadRestClient, PublicReadApiError } from "../transport/rest.js";
import type { Entity } from "../contract/index.js";

const ENTITY = { id: "e1", public: true, title: "Hello" } as unknown as Entity;

const wrap =
  () =>
  ({ children }: { children: React.ReactNode }) => (
    <PublicReadProvider projectId="p1" baseUrl="http://host/v7">
      {children}
    </PublicReadProvider>
  );

afterEach(() => vi.restoreAllMocks());

describe("usePublicEntity", () => {
  it("fetches and exposes the entity", async () => {
    vi.spyOn(PublicReadRestClient.prototype, "getEntity").mockResolvedValue(ENTITY);
    const { result } = renderHook(() => usePublicEntity("e1"), { wrapper: wrap() });

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.entity).toEqual(ENTITY);
    expect(result.current.notFound).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("maps the gate's 404 to notFound with NO error — the neutral empty state", async () => {
    vi.spyOn(PublicReadRestClient.prototype, "getEntity").mockRejectedValue(
      new PublicReadApiError("gone", 404, "entities/not-found")
    );
    const { result } = renderHook(() => usePublicEntity("e1"), { wrapper: wrap() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.notFound).toBe(true);
    expect(result.current.entity).toBeNull();
    // An error here would tempt a renderer into showing a message that guesses WHY — the server
    // deliberately makes unpublished/missing/draft/removed/space-went-private indistinguishable.
    expect(result.current.error).toBeNull();
  });

  it("surfaces project/not-found as a real error (host misconfiguration, not an empty page)", async () => {
    vi.spyOn(PublicReadRestClient.prototype, "getEntity").mockRejectedValue(
      new PublicReadApiError("bad project", 404, "project/not-found")
    );
    const { result } = renderHook(() => usePublicEntity("e1"), { wrapper: wrap() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeInstanceOf(PublicReadApiError);
    expect(result.current.notFound).toBe(false);
  });

  it("surfaces a 500 as a real error", async () => {
    vi.spyOn(PublicReadRestClient.prototype, "getEntity").mockRejectedValue(
      new PublicReadApiError("boom", 500, null)
    );
    const { result } = renderHook(() => usePublicEntity("e1"), { wrapper: wrap() });

    await waitFor(() => expect(result.current.error).toBeInstanceOf(PublicReadApiError));
    expect(result.current.entity).toBeNull();
    expect(result.current.notFound).toBe(false);
  });

  it("does not fetch and is not loading when the target is absent", async () => {
    const getEntity = vi.spyOn(PublicReadRestClient.prototype, "getEntity");
    const { result } = renderHook(() => usePublicEntity(null), { wrapper: wrap() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getEntity).not.toHaveBeenCalled();
    expect(result.current.entity).toBeNull();
  });

  it("resolves by foreignId and exposes the resolved uuid for chaining", async () => {
    const byForeign = vi
      .spyOn(PublicReadRestClient.prototype, "getEntityByForeignId")
      .mockResolvedValue(ENTITY);
    const byId = vi.spyOn(PublicReadRestClient.prototype, "getEntity");

    const { result } = renderHook(
      () => usePublicEntity({ foreignId: "homepage-comments" }),
      { wrapper: wrap() }
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(byForeign).toHaveBeenCalledWith("homepage-comments", undefined);
    expect(byId).not.toHaveBeenCalled();
    // The uuid the comment hooks need — the whole point of returning it.
    expect(result.current.entityId).toBe("e1");
  });

  it("treats a bare string and { entityId } identically, as a uuid", async () => {
    const byId = vi.spyOn(PublicReadRestClient.prototype, "getEntity").mockResolvedValue(ENTITY);
    const byForeign = vi.spyOn(PublicReadRestClient.prototype, "getEntityByForeignId");

    const { result } = renderHook(() => usePublicEntity({ entityId: "e1" }), { wrapper: wrap() });
    await waitFor(() => expect(result.current.entityId).toBe("e1"));

    expect(byId).toHaveBeenCalledWith("e1", undefined);
    expect(byForeign).not.toHaveBeenCalled();
  });

  it("surfaces a missing-foreign-id 400 as a real error, not notFound", async () => {
    // An empty foreignId is a CALLER bug. Rendering "no comments" for it would hide an integration
    // mistake behind a state that looks intentional.
    vi.spyOn(PublicReadRestClient.prototype, "getEntityByForeignId").mockRejectedValue(
      new PublicReadApiError("missing", 400, "entities/missing-foreign-id")
    );
    const { result } = renderHook(() => usePublicEntity({ foreignId: "" }), { wrapper: wrap() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeInstanceOf(PublicReadApiError);
    expect(result.current.notFound).toBe(false);
  });

  it("maps an unknown foreignId's 404 to the same neutral notFound", async () => {
    vi.spyOn(PublicReadRestClient.prototype, "getEntityByForeignId").mockRejectedValue(
      new PublicReadApiError("gone", 404, "entities/not-found")
    );
    const { result } = renderHook(() => usePublicEntity({ foreignId: "nope" }), { wrapper: wrap() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.notFound).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.entityId).toBeNull();
  });

  it("clears a previous notFound when the entityId changes", async () => {
    const spy = vi
      .spyOn(PublicReadRestClient.prototype, "getEntity")
      .mockRejectedValueOnce(new PublicReadApiError("gone", 404, null))
      .mockResolvedValueOnce(ENTITY);

    const { result, rerender } = renderHook(({ id }: { id: string }) => usePublicEntity(id), {
      wrapper: wrap(),
      initialProps: { id: "e1" },
    });
    await waitFor(() => expect(result.current.notFound).toBe(true));

    rerender({ id: "e2" });
    await waitFor(() => expect(result.current.entity).toEqual(ENTITY));
    expect(result.current.notFound).toBe(false);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test packages/public-read/core/src/hooks/usePublicEntity.test.tsx`
Expected: FAIL — `Failed to resolve import "./usePublicEntity.js"`.

- [ ] **Step 3: Write the hook**

`packages/public-read/core/src/hooks/usePublicEntity.tsx`:

```tsx
// usePublicEntity — resolve one internet-public entity anonymously, by uuid OR by the host app's key.
//
// This hook is the RESOLVER for the whole feature. The entity's uuid is generated per install, so an
// embed addresses the anchor by `foreignId` ("homepage-comments", a post slug). But the comment
// routes are uuid-only — `by-foreign-id` resolves the entity and nothing else — so this hook returns
// the resolved `entityId` alongside the entity, and callers chain it:
//
//     foreignId → usePublicEntity → entityId → usePublicCommentThread → nodes
//
// The comment hooks no-op on a null id, which is what makes that chain safe while this leg is still
// in flight. Mirroring the server's addressing exactly (uuid-only comments) keeps the SDK from
// inventing a mode the API doesn't have.
//
// `notFound` is a first-class boolean, SEPARATE from `error`, and that separation is the point. The
// gate collapses unpublished / missing / draft / moderation-removed / space-went-private into one
// indistinguishable 404 (PUBLIC-API.md §4). Any message a renderer wrote for it would be a guess, and
// shipping that guess hands an anonymous prober the existence oracle the 404-never-403 posture exists
// to deny. So: 404 → notFound, no error, no message. A 400 missing-foreign-id is NOT that — it is a
// caller bug and stays a real error.

import { useCallback, useEffect, useState } from "react";

import { usePublicRead } from "../context/public-read-context.js";
import { isNotFound, type PublicEntityQuery } from "../transport/rest.js";
import type { Entity, PublicEntityInclude } from "../contract/index.js";

/**
 * How to address an entity: a bare uuid string, an explicit `{ entityId }`, or `{ foreignId }` —
 * the host app's own stable key. `null`/`undefined` skips fetching entirely.
 */
export type PublicEntityTarget =
  | string
  | { entityId: string }
  | { foreignId: string }
  | null
  | undefined;

/** The value returned by {@link usePublicEntity}. */
export interface UsePublicEntityValues {
  /** The entity, or `null` while loading, when absent, or on failure. */
  entity: Entity | null;
  /**
   * The resolved entity uuid, or `null` until it is known.
   *
   * Chain this into {@link usePublicCommentThread} / {@link usePublicComments}, which are uuid-only.
   */
  entityId: string | null;
  /** True while a fetch is in flight. */
  loading: boolean;
  /**
   * True when the server's gate returned its neutral `404`.
   *
   * Render one neutral empty state. Do **not** render a reason — see the module header.
   */
  notFound: boolean;
  /**
   * A real failure: network, `5xx`, `project/not-found`, or `400 entities/missing-foreign-id`.
   * Never set for the gate's `404`.
   */
  error: unknown;
  /** Re-run the fetch. */
  refresh: () => Promise<void>;
}

/** Normalize a {@link PublicEntityTarget} into a `[kind, key]` pair, or `null` when absent. */
function resolveTarget(target: PublicEntityTarget): ["uuid" | "foreign", string] | null {
  if (!target) return null;
  if (typeof target === "string") return ["uuid", target];
  if ("foreignId" in target) return ["foreign", target.foreignId];
  return ["uuid", target.entityId];
}

/**
 * Resolve a single internet-public entity, by uuid or by the host app's `foreignId`.
 *
 * @param target - {@link PublicEntityTarget}. A bare string is treated as a uuid.
 * @param opts - Optional relations to inline (`user`, `files`).
 * @returns {@link UsePublicEntityValues}, including the resolved `entityId` for chaining.
 *
 * @example
 * ```tsx
 * // Address the anchor by the key your app already uses — the uuid differs per install.
 * const { entity, entityId, notFound } = usePublicEntity({ foreignId: "homepage-comments" });
 * const { nodes } = usePublicCommentThread(entityId);   // no-ops until entityId resolves
 * if (notFound) return <p>No comments to show.</p>;
 * return <h1>{entity?.title}</h1>;
 * ```
 */
export function usePublicEntity(
  target: PublicEntityTarget,
  opts?: PublicEntityQuery
): UsePublicEntityValues {
  const { rest } = usePublicRead();
  const include = opts?.include?.join(",");
  const resolved = resolveTarget(target);
  // Destructured into primitives so the callback identity depends on values, not on a fresh object
  // literal produced by `resolveTarget` on every render.
  const kind = resolved?.[0] ?? null;
  const key = resolved?.[1] ?? null;

  const [entity, setEntity] = useState<Entity | null>(null);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const refresh = useCallback(async () => {
    if (!kind || !key) return;
    setLoading(true);
    setNotFound(false);
    setError(null);
    const query = include
      ? { include: include.split(",") as PublicEntityInclude[] }
      : undefined;
    try {
      setEntity(
        kind === "foreign"
          ? await rest.getEntityByForeignId(key, query)
          : await rest.getEntity(key, query)
      );
    } catch (err) {
      setEntity(null);
      if (isNotFound(err)) setNotFound(true);
      else setError(err);
    } finally {
      setLoading(false);
    }
    // `include` is a joined string so a fresh array literal per render does not re-trigger the fetch.
  }, [kind, key, include, rest]);

  useEffect(() => {
    if (!kind || !key) {
      setEntity(null);
      setNotFound(false);
      setError(null);
      return;
    }
    void refresh();
  }, [kind, key, refresh]);

  return { entity, entityId: entity?.id ?? null, loading, notFound, error, refresh };
}
```

- [ ] **Step 4: Export it from the barrel**

Add a `── hooks ──` section to `packages/public-read/core/src/index.ts`, between the provider and transport sections:

```ts
// ── hooks ────────────────────────────────────────────────────────────────────
export { usePublicEntity } from "./hooks/usePublicEntity.js";
export type { UsePublicEntityValues, PublicEntityTarget } from "./hooks/usePublicEntity.js";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test packages/public-read/core/src/hooks/usePublicEntity.test.tsx`
Expected: PASS, 10 tests.

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm run typecheck` — expected clean.

Add to `CHANGELOG.md` under `[Unreleased]` → `### Added`:

```markdown
- **`@agora-sdk/public-read-core` — `usePublicEntity`, the resolver.** Addresses an anchor by uuid
  **or** by the host app's `foreignId` (`"homepage-comments"`, a post slug) — necessary because the
  uuid is generated per install and cannot be hardcoded in a template. Returns the resolved
  `entityId` alongside the entity, which is what makes the two-step composable: the comment routes
  are uuid-only, mirroring the server exactly, so a caller chains
  `foreignId → entityId → thread` and the comment hooks no-op until the first leg lands.
  Exposes `notFound` as a first-class boolean separate from `error`: the gate's `404` sets `notFound`
  with a `null` error, so a renderer cannot accidentally show a message guessing between unpublished,
  missing, draft, removed, and space-went-private. `project/not-found` and
  `400 entities/missing-foreign-id` deliberately stay real errors — both are caller bugs and must not
  masquerade as an empty page.
```

```bash
git add packages/public-read/core CHANGELOG.md
git commit -m "feat(public-read): usePublicEntity with neutral notFound handling"
```

---

### Task 4: `usePublicComments` (flat list + reply paging)

**Files:**
- Create: `packages/public-read/core/src/hooks/usePublicComments.tsx`
- Modify: `packages/public-read/core/src/index.ts`
- Test: `packages/public-read/core/src/hooks/usePublicComments.test.tsx`

**Interfaces:**
- Consumes: `usePublicRead()`, `isNotFound`, `Comment`, `PaginatedResponse`, `PublicCommentsSortBy`, `PublicSortDir`.
- Produces: `usePublicComments(entityId, opts?): UsePublicCommentsValues` where
  ```ts
  interface UsePublicCommentsOptions {
    parentId?: string;
    limit?: number;
    sortBy?: PublicCommentsSortBy;
    sortDir?: PublicSortDir;
    include?: PublicCommentInclude[];
  }
  interface UsePublicCommentsValues {
    comments: Comment[];
    loading: boolean;
    notFound: boolean;
    error: unknown;
    hasMore: boolean;
    page: number;
    loadMore: () => void;
    sortBy: PublicCommentsSortBy;
    setSortBy: (v: PublicCommentsSortBy) => void;
    sortDir: PublicSortDir;
    setSortDir: (v: PublicSortDir) => void;
    refresh: () => Promise<void>;
  }
  ```
  Reply paging is this same hook with `parentId` set — there is no separate replies hook.

- [ ] **Step 1: Write the failing test**

`packages/public-read/core/src/hooks/usePublicComments.test.tsx`:

```tsx
// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { PublicReadProvider } from "../context/public-read-context.js";
import { usePublicComments } from "./usePublicComments.js";
import { PublicReadRestClient, PublicReadApiError } from "../transport/rest.js";
import type { Comment, PaginatedResponse } from "../contract/index.js";

const comment = (id: string): Comment => ({ id, content: `c-${id}` }) as unknown as Comment;

const envelope = (
  data: Comment[],
  over?: Partial<PaginatedResponse<Comment>["pagination"]>
): PaginatedResponse<Comment> => ({
  data,
  pagination: {
    page: 1,
    pageSize: 20,
    totalPages: 1,
    totalItems: data.length,
    hasMore: false,
    ...over,
  },
});

const wrap =
  () =>
  ({ children }: { children: React.ReactNode }) => (
    <PublicReadProvider projectId="p1" baseUrl="http://host/v7">
      {children}
    </PublicReadProvider>
  );

afterEach(() => vi.restoreAllMocks());

describe("usePublicComments", () => {
  it("fetches page 1 and exposes the list plus hasMore", async () => {
    vi.spyOn(PublicReadRestClient.prototype, "getComments").mockResolvedValue(
      envelope([comment("a"), comment("b")], { hasMore: true, totalPages: 2 })
    );
    const { result } = renderHook(() => usePublicComments("e1"), { wrapper: wrap() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.comments.map((c) => c.id)).toEqual(["a", "b"]);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.page).toBe(1);
  });

  it("appends on loadMore rather than replacing", async () => {
    const spy = vi
      .spyOn(PublicReadRestClient.prototype, "getComments")
      .mockResolvedValueOnce(envelope([comment("a")], { hasMore: true, totalPages: 2 }))
      .mockResolvedValueOnce(envelope([comment("b")], { page: 2, hasMore: false, totalPages: 2 }));

    const { result } = renderHook(() => usePublicComments("e1"), { wrapper: wrap() });
    await waitFor(() => expect(result.current.comments).toHaveLength(1));

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.comments).toHaveLength(2));

    expect(result.current.comments.map((c) => c.id)).toEqual(["a", "b"]);
    expect(result.current.hasMore).toBe(false);
    expect(spy).toHaveBeenLastCalledWith("e1", expect.objectContaining({ page: 2 }));
  });

  it("is a no-op when loadMore is called with hasMore false", async () => {
    const spy = vi
      .spyOn(PublicReadRestClient.prototype, "getComments")
      .mockResolvedValue(envelope([comment("a")]));
    const { result } = renderHook(() => usePublicComments("e1"), { wrapper: wrap() });
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("handles an empty list without setting notFound", async () => {
    vi.spyOn(PublicReadRestClient.prototype, "getComments").mockResolvedValue(envelope([]));
    const { result } = renderHook(() => usePublicComments("e1"), { wrapper: wrap() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.comments).toEqual([]);
    expect(result.current.hasMore).toBe(false);
    // A published entity with zero comments is NOT a 404 — the distinction matters for the renderer.
    expect(result.current.notFound).toBe(false);
  });

  it("pages replies when parentId is set", async () => {
    const spy = vi
      .spyOn(PublicReadRestClient.prototype, "getComments")
      .mockResolvedValue(envelope([comment("r1")]));
    const { result } = renderHook(() => usePublicComments("e1", { parentId: "c1" }), {
      wrapper: wrap(),
    });

    await waitFor(() => expect(result.current.comments).toHaveLength(1));
    expect(spy).toHaveBeenCalledWith("e1", expect.objectContaining({ parentId: "c1" }));
  });

  it("maps a malformed-parentId 404 to notFound with no error", async () => {
    vi.spyOn(PublicReadRestClient.prototype, "getComments").mockRejectedValue(
      new PublicReadApiError("bad parent", 404, "entities/not-found")
    );
    const { result } = renderHook(() => usePublicComments("e1", { parentId: "nope" }), {
      wrapper: wrap(),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.notFound).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.comments).toEqual([]);
  });

  it("resets to page 1 and refetches when sortBy changes", async () => {
    const spy = vi
      .spyOn(PublicReadRestClient.prototype, "getComments")
      .mockResolvedValue(envelope([comment("a")], { hasMore: true, totalPages: 3 }));
    const { result } = renderHook(() => usePublicComments("e1"), { wrapper: wrap() });
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.page).toBe(2));

    act(() => result.current.setSortBy("top"));
    await waitFor(() => expect(result.current.page).toBe(1));
    expect(spy).toHaveBeenLastCalledWith("e1", expect.objectContaining({ page: 1, sortBy: "top" }));
  });

  it("never sends spaceReputation params", async () => {
    const spy = vi
      .spyOn(PublicReadRestClient.prototype, "getComments")
      .mockResolvedValue(envelope([]));
    renderHook(() => usePublicComments("e1"), { wrapper: wrap() });

    await waitFor(() => expect(spy).toHaveBeenCalled());
    const sent = JSON.stringify(spy.mock.calls[0]?.[1] ?? {});
    expect(sent).not.toMatch(/spaceReputation/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test packages/public-read/core/src/hooks/usePublicComments.test.tsx`
Expected: FAIL — `Failed to resolve import "./usePublicComments.js"`.

- [ ] **Step 3: Write the hook**

`packages/public-read/core/src/hooks/usePublicComments.tsx`:

```tsx
// usePublicComments — one level of an anonymous comment list, offset-paginated.
//
// Top-level comments by default; set `parentId` to page the replies under a comment (the endpoint
// and the state machine are identical, so there is no separate replies hook). Pagination is
// offset/page-based — `loadMore` APPENDS, matching the `{ data, pagination }` envelope the server
// sends. Changing sort resets to page 1, because a page-2 offset into a re-sorted list is meaningless.
//
// `notFound` is separate from `error` for the reason documented in usePublicEntity: the gate's 404 is
// deliberately ambiguous and must render as one neutral empty state, never a reason. Note that an
// EMPTY list is not `notFound` — a published entity with no comments yet is a success.

import { useCallback, useEffect, useState } from "react";

import { usePublicRead } from "../context/public-read-context.js";
import { isNotFound } from "../transport/rest.js";
import type {
  Comment,
  PublicCommentInclude,
  PublicCommentsSortBy,
  PublicSortDir,
} from "../contract/index.js";

/** Options for {@link usePublicComments}. */
export interface UsePublicCommentsOptions {
  /** Page the replies under this comment instead of top-level comments. */
  parentId?: string;
  /** Page size. Server default `20`, clamped to `100`. */
  limit?: number;
  /** Initial sort order. Server default `createdAt`. */
  sortBy?: PublicCommentsSortBy;
  /** Initial sort direction. Applies to `createdAt` only. */
  sortDir?: PublicSortDir;
  /** Relations to inline. */
  include?: PublicCommentInclude[];
}

/** The value returned by {@link usePublicComments}. */
export interface UsePublicCommentsValues {
  /** Comments accumulated across every page loaded so far. */
  comments: Comment[];
  /** True while a fetch is in flight. */
  loading: boolean;
  /** True when the gate returned its neutral `404`. An empty list is **not** `notFound`. */
  notFound: boolean;
  /** A real failure. Never set for the gate's `404`. */
  error: unknown;
  /** Whether another page exists, from the server's pagination envelope. */
  hasMore: boolean;
  /** The highest page loaded so far (1-based). */
  page: number;
  /** Load and append the next page. No-op while loading or when `hasMore` is false. */
  loadMore: () => void;
  /** The active sort order. */
  sortBy: PublicCommentsSortBy;
  /** Change the sort order; resets to page 1 and refetches. */
  setSortBy: (value: PublicCommentsSortBy) => void;
  /** The active sort direction. */
  sortDir: PublicSortDir;
  /** Change the sort direction; resets to page 1 and refetches. */
  setSortDir: (value: PublicSortDir) => void;
  /** Reload from page 1. */
  refresh: () => Promise<void>;
}

/**
 * Read one level of an entity's public comments, with offset pagination.
 *
 * @param entityId - The entity id, or `null`/`undefined` to skip fetching.
 * @param opts - Paging, sorting, `parentId` for replies, and relations.
 * @returns {@link UsePublicCommentsValues}.
 *
 * @example
 * ```tsx
 * const { comments, hasMore, loadMore } = usePublicComments(id, { include: ["user"] });
 * return (
 *   <>
 *     {comments.map((c) => <p key={c.id}>{c.content}</p>)}
 *     {hasMore && <button onClick={loadMore}>Load more</button>}
 *   </>
 * );
 * ```
 */
export function usePublicComments(
  entityId: string | null | undefined,
  opts?: UsePublicCommentsOptions
): UsePublicCommentsValues {
  const { rest } = usePublicRead();
  const { parentId, limit } = opts ?? {};
  const include = opts?.include?.join(",");

  const [sortBy, setSortByState] = useState<PublicCommentsSortBy>(opts?.sortBy ?? "createdAt");
  const [sortDir, setSortDirState] = useState<PublicSortDir>(opts?.sortDir ?? "desc");

  const [comments, setComments] = useState<Comment[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<unknown>(null);

  /** Fetch one page. `append` false means "this is a fresh page 1" and replaces the list. */
  const fetchPage = useCallback(
    async (targetPage: number, append: boolean) => {
      if (!entityId) return;
      setLoading(true);
      if (!append) {
        setNotFound(false);
        setError(null);
      }
      try {
        const res = await rest.getComments(entityId, {
          parentId,
          page: targetPage,
          limit,
          sortBy,
          sortDir,
          include: include ? (include.split(",") as PublicCommentInclude[]) : undefined,
        });
        setComments((prev) => (append ? [...prev, ...res.data] : res.data));
        setHasMore(res.pagination?.hasMore ?? false);
        setPage(targetPage);
      } catch (err) {
        if (!append) setComments([]);
        if (isNotFound(err)) setNotFound(true);
        else setError(err);
      } finally {
        setLoading(false);
      }
    },
    [entityId, parentId, limit, sortBy, sortDir, include, rest]
  );

  const refresh = useCallback(async () => {
    await fetchPage(1, false);
  }, [fetchPage]);

  // Reset to page 1 whenever the query identity changes (entity, parent, sort, limit, includes).
  // `fetchPage` carries all of those in its dependency list, so depending on it is sufficient.
  useEffect(() => {
    if (!entityId) {
      setComments([]);
      setHasMore(false);
      setNotFound(false);
      setError(null);
      setPage(1);
      return;
    }
    void fetchPage(1, false);
  }, [entityId, fetchPage]);

  const loadMore = useCallback(() => {
    if (loading || !hasMore) return;
    void fetchPage(page + 1, true);
  }, [loading, hasMore, page, fetchPage]);

  const setSortBy = useCallback((value: PublicCommentsSortBy) => {
    setPage(1);
    setSortByState(value);
  }, []);

  const setSortDir = useCallback((value: PublicSortDir) => {
    setPage(1);
    setSortDirState(value);
  }, []);

  return {
    comments,
    loading,
    notFound,
    error,
    hasMore,
    page,
    loadMore,
    sortBy,
    setSortBy,
    sortDir,
    setSortDir,
    refresh,
  };
}
```

- [ ] **Step 4: Export it from the barrel**

Add to the `── hooks ──` section of `packages/public-read/core/src/index.ts`:

```ts
export { usePublicComments } from "./hooks/usePublicComments.js";
export type {
  UsePublicCommentsOptions,
  UsePublicCommentsValues,
} from "./hooks/usePublicComments.js";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test packages/public-read/core/src/hooks/usePublicComments.test.tsx`
Expected: PASS, 8 tests.

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm run typecheck` — expected clean.

Add to `CHANGELOG.md` under `[Unreleased]` → `### Added`:

```markdown
- **`@agora-sdk/public-read-core` — `usePublicComments`.** Offset-paginated flat comment list;
  `loadMore` appends, and changing sort resets to page 1 (a page-2 offset into a re-sorted list is
  meaningless). Reply paging is the same hook with `parentId` set — no separate hook. An empty list
  is explicitly **not** `notFound`: a published entity with no comments yet is a success, and
  conflating the two would render "unavailable" on a perfectly healthy thread.
```

```bash
git add packages/public-read/core CHANGELOG.md
git commit -m "feat(public-read): usePublicComments with offset paging and reply support"
```

---

### Task 5: `usePublicCommentThread`

**Files:**
- Create: `packages/public-read/core/src/hooks/usePublicCommentThread.tsx`
- Modify: `packages/public-read/core/src/index.ts`
- Test: `packages/public-read/core/src/hooks/usePublicCommentThread.test.tsx`

**Interfaces:**
- Consumes: `usePublicRead()`, `isNotFound`, `PublicCommentNode`.
- Produces: `usePublicCommentThread(entityId, opts?): UsePublicCommentThreadValues` where
  ```ts
  interface UsePublicCommentThreadOptions {
    rootId?: string;
    limit?: number;
    include?: PublicCommentInclude[];
  }
  interface UsePublicCommentThreadValues {
    nodes: PublicCommentNode[];
    loading: boolean;
    notFound: boolean;
    error: unknown;
    hasMore: boolean;
    page: number;
    loadMore: () => void;
    refresh: () => Promise<void>;
  }
  ```

- [ ] **Step 1: Write the failing test**

`packages/public-read/core/src/hooks/usePublicCommentThread.test.tsx`:

```tsx
// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { PublicReadProvider } from "../context/public-read-context.js";
import { usePublicCommentThread } from "./usePublicCommentThread.js";
import { PublicReadRestClient, PublicReadApiError } from "../transport/rest.js";
import type { PublicCommentNode } from "../contract/index.js";

const node = (id: string, replies: PublicCommentNode[] = []): PublicCommentNode =>
  ({ id, content: `c-${id}`, replies }) as unknown as PublicCommentNode;

const wrap =
  () =>
  ({ children }: { children: React.ReactNode }) => (
    <PublicReadProvider projectId="p1" baseUrl="http://host/v7">
      {children}
    </PublicReadProvider>
  );

afterEach(() => vi.restoreAllMocks());

describe("usePublicCommentThread", () => {
  it("exposes the server's nested shape verbatim (no client-side assembly)", async () => {
    const tree = [node("a", [node("a1", [node("a1a")])]), node("b")];
    vi.spyOn(PublicReadRestClient.prototype, "getThread").mockResolvedValue({ data: tree });

    const { result } = renderHook(() => usePublicCommentThread("e1"), { wrapper: wrap() });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.nodes).toEqual(tree);
    expect(result.current.nodes[0]?.replies[0]?.replies[0]?.id).toBe("a1a");
  });

  it("maps the gate's 404 to notFound with no error", async () => {
    vi.spyOn(PublicReadRestClient.prototype, "getThread").mockRejectedValue(
      new PublicReadApiError("gone", 404, "entities/not-found")
    );
    const { result } = renderHook(() => usePublicCommentThread("e1"), { wrapper: wrap() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.notFound).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.nodes).toEqual([]);
  });

  it("infers hasMore from a full page, since the thread route sends no pagination envelope", async () => {
    const full = Array.from({ length: 3 }, (_, i) => node(`n${i}`));
    vi.spyOn(PublicReadRestClient.prototype, "getThread").mockResolvedValue({ data: full });

    const { result } = renderHook(() => usePublicCommentThread("e1", { limit: 3 }), {
      wrapper: wrap(),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasMore).toBe(true);
  });

  it("infers hasMore false from a short page", async () => {
    vi.spyOn(PublicReadRestClient.prototype, "getThread").mockResolvedValue({
      data: [node("a"), node("b")],
    });
    const { result } = renderHook(() => usePublicCommentThread("e1", { limit: 3 }), {
      wrapper: wrap(),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasMore).toBe(false);
  });

  it("appends root nodes on loadMore", async () => {
    const spy = vi
      .spyOn(PublicReadRestClient.prototype, "getThread")
      .mockResolvedValueOnce({ data: [node("a"), node("b")] })
      .mockResolvedValueOnce({ data: [node("c")] });

    const { result } = renderHook(() => usePublicCommentThread("e1", { limit: 2 }), {
      wrapper: wrap(),
    });
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.nodes).toHaveLength(3));
    expect(result.current.nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(spy).toHaveBeenLastCalledWith("e1", expect.objectContaining({ page: 2 }));
  });

  it("passes rootId through untouched (the server treats a malformed one as absent)", async () => {
    const spy = vi
      .spyOn(PublicReadRestClient.prototype, "getThread")
      .mockResolvedValue({ data: [] });
    renderHook(() => usePublicCommentThread("e1", { rootId: "not-a-uuid" }), { wrapper: wrap() });

    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith("e1", expect.objectContaining({ rootId: "not-a-uuid" }));
  });

  it("does not fetch when entityId is absent", async () => {
    const spy = vi.spyOn(PublicReadRestClient.prototype, "getThread");
    const { result } = renderHook(() => usePublicCommentThread(undefined), { wrapper: wrap() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(spy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test packages/public-read/core/src/hooks/usePublicCommentThread.test.tsx`
Expected: FAIL — `Failed to resolve import "./usePublicCommentThread.js"`.

- [ ] **Step 3: Write the hook**

`packages/public-read/core/src/hooks/usePublicCommentThread.tsx`:

```tsx
// usePublicCommentThread — the whole nested thread in one round trip.
//
// The server assembles the tree (fetch_comment_thread RPC, parents before children) and prunes
// removed comments together with their descendant subtrees. We expose `data` VERBATIM: do not port
// the fork's `helpers/addCommentsToTree.ts`, which exists only because the walled surface serves
// flat pages.
//
// `hasMore` is INFERRED from `nodes.length === limit`, because this route sends no pagination
// envelope. The inference costs one wasted final request when the root count divides evenly by the
// page size — the correct trade against inventing a client-side count the server never gave us.

import { useCallback, useEffect, useState } from "react";

import { usePublicRead } from "../context/public-read-context.js";
import { isNotFound } from "../transport/rest.js";
import type { PublicCommentInclude, PublicCommentNode } from "../contract/index.js";

/** The server's default page size for the thread route (`PUBLIC-API.md` §3). */
const DEFAULT_THREAD_LIMIT = 50;

/** Options for {@link usePublicCommentThread}. */
export interface UsePublicCommentThreadOptions {
  /**
   * Root of the subtree to fetch. Omit for the whole thread.
   *
   * @remarks
   * A malformed value is treated by the server as absent (it serves the whole thread) rather than
   * erroring — unlike `parentId` on the flat list, which `404`s. Passed through untouched.
   */
  rootId?: string;
  /** Max root nodes per page. Server default `50`, clamped to `100`. */
  limit?: number;
  /** Relations to inline. */
  include?: PublicCommentInclude[];
}

/** The value returned by {@link usePublicCommentThread}. */
export interface UsePublicCommentThreadValues {
  /** Root nodes, each carrying its `replies` inline, exactly as the server sent them. */
  nodes: PublicCommentNode[];
  /** True while a fetch is in flight. */
  loading: boolean;
  /** True when the gate returned its neutral `404`. An empty thread is **not** `notFound`. */
  notFound: boolean;
  /** A real failure. Never set for the gate's `404`. */
  error: unknown;
  /** Inferred from a full page — see the module header. */
  hasMore: boolean;
  /** The highest page of root nodes loaded so far (1-based). */
  page: number;
  /** Load and append the next page of root nodes. No-op while loading or when `hasMore` is false. */
  loadMore: () => void;
  /** Reload from page 1. */
  refresh: () => Promise<void>;
}

/**
 * Read an entity's public comment thread, already nested by the server.
 *
 * @param entityId - The entity id, or `null`/`undefined` to skip fetching.
 * @param opts - `rootId`, page size, and relations.
 * @returns {@link UsePublicCommentThreadValues}.
 *
 * @example
 * ```tsx
 * const { nodes, notFound } = usePublicCommentThread(id, { include: ["user"] });
 * if (notFound) return <p>This conversation isn’t available.</p>;
 * return <>{nodes.map((n) => <Node key={n.id} node={n} />)}</>;
 * ```
 */
export function usePublicCommentThread(
  entityId: string | null | undefined,
  opts?: UsePublicCommentThreadOptions
): UsePublicCommentThreadValues {
  const { rest } = usePublicRead();
  const { rootId, limit } = opts ?? {};
  const include = opts?.include?.join(",");
  const effectiveLimit = limit ?? DEFAULT_THREAD_LIMIT;

  const [nodes, setNodes] = useState<PublicCommentNode[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const fetchPage = useCallback(
    async (targetPage: number, append: boolean) => {
      if (!entityId) return;
      setLoading(true);
      if (!append) {
        setNotFound(false);
        setError(null);
      }
      try {
        const res = await rest.getThread(entityId, {
          rootId,
          page: targetPage,
          limit,
          include: include ? (include.split(",") as PublicCommentInclude[]) : undefined,
        });
        const data = res.data ?? [];
        setNodes((prev) => (append ? [...prev, ...data] : data));
        setHasMore(data.length >= effectiveLimit);
        setPage(targetPage);
      } catch (err) {
        if (!append) setNodes([]);
        if (isNotFound(err)) setNotFound(true);
        else setError(err);
      } finally {
        setLoading(false);
      }
    },
    [entityId, rootId, limit, include, effectiveLimit, rest]
  );

  const refresh = useCallback(async () => {
    await fetchPage(1, false);
  }, [fetchPage]);

  useEffect(() => {
    if (!entityId) {
      setNodes([]);
      setHasMore(false);
      setNotFound(false);
      setError(null);
      setPage(1);
      return;
    }
    void fetchPage(1, false);
  }, [entityId, fetchPage]);

  const loadMore = useCallback(() => {
    if (loading || !hasMore) return;
    void fetchPage(page + 1, true);
  }, [loading, hasMore, page, fetchPage]);

  return { nodes, loading, notFound, error, hasMore, page, loadMore, refresh };
}
```

- [ ] **Step 4: Export it from the barrel**

Add to the `── hooks ──` section of `packages/public-read/core/src/index.ts`:

```ts
export { usePublicCommentThread } from "./hooks/usePublicCommentThread.js";
export type {
  UsePublicCommentThreadOptions,
  UsePublicCommentThreadValues,
} from "./hooks/usePublicCommentThread.js";
```

- [ ] **Step 5: Run the whole core suite**

Run: `pnpm test packages/public-read/core`
Expected: PASS — 4 files, 25 tests.

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm run typecheck` — expected clean.

Add to `CHANGELOG.md` under `[Unreleased]` → `### Added`:

```markdown
- **`@agora-sdk/public-read-core` — `usePublicCommentThread`.** One round trip for the whole nested
  thread; exposes the server's `replies[]` shape verbatim rather than reassembling it client-side
  (the fork's `addCommentsToTree` exists only because the walled surface serves flat pages). `hasMore`
  is inferred from a full page because this route sends no pagination envelope — costing one wasted
  final request when the root count divides evenly, which beats inventing a count the server never sent.
```

```bash
git add packages/public-read/core CHANGELOG.md
git commit -m "feat(public-read): usePublicCommentThread over the server-nested route"
```

---

### Task 6: `public-read-react-js` package + recursive node renderer

**Files:**
- Create: `packages/public-read/react-js/package.json`, `tsconfig.json`, `tsconfig.esm.json`
- Create: `packages/public-read/react-js/src/components/PublicCommentNodeView.tsx`
- Create: `packages/public-read/react-js/src/index.ts`
- Test: `packages/public-read/react-js/src/components/PublicCommentNodeView.test.tsx`
- Modify: root `package.json` (5 scripts)

**Interfaces:**
- Consumes: `PublicCommentNode`, `Comment` from `@agora-sdk/public-read-core`.
- Produces:
  ```ts
  interface RenderCommentContext { depth: number; children: React.ReactNode }
  type RenderComment = (comment: Comment, ctx: RenderCommentContext) => React.ReactNode;
  interface PublicCommentNodeViewProps {
    node: PublicCommentNode;
    depth?: number;
    renderComment?: RenderComment;
  }
  function PublicCommentNodeView(props: PublicCommentNodeViewProps): React.ReactElement;
  function isTombstone(comment: Comment): boolean;
  ```

- [ ] **Step 1: Create the package manifest**

`packages/public-read/react-js/package.json`:

```json
{
  "name": "@agora-sdk/public-read-react-js",
  "version": "0.10.2",
  "private": false,
  "license": "Apache-2.0",
  "author": "Agora SDK Plus, maintained by Jenova Marie",
  "description": "Web components for the Agora anonymous public surface: a drop-in, read-only comment thread a blog can embed with no account and no Agora SDK installed. Re-exports @agora-sdk/public-read-core.",
  "keywords": ["agora", "public", "anonymous", "comments", "embed", "read-only", "react", "web", "typescript"],
  "bugs": { "url": "https://github.com/agora-oss-org/agora-sdk-plus/issues" },
  "homepage": "https://github.com/agora-oss-org/agora-sdk-plus",
  "repository": {
    "type": "git",
    "url": "https://github.com/agora-oss-org/agora-sdk-plus.git",
    "directory": "packages/public-read/react-js"
  },
  "main": "dist/esm/index.js",
  "module": "dist/esm/index.js",
  "types": "dist/esm/index.d.ts",
  "type": "module",
  "comment:esm-only": "ESM-only to match social-react-js and secure-chat-react-js: web/React consumers always bundle (Vite/webpack), so a CJS build would be dead weight.",
  "scripts": {
    "build:esm": "tsc -p tsconfig.esm.json",
    "build": "rimraf dist && pnpm run build:esm && pnpm run copy:docs",
    "prepublish": "pnpm run build",
    "copy:docs": "cp ../../../docs/PUBLIC-READ.md ./PUBLIC-READ.md"
  },
  "publishConfig": { "access": "public" },
  "files": ["dist", "PUBLIC-READ.md"],
  "dependencies": {
    "@agora-sdk/public-read-core": "workspace:*"
  },
  "peerDependencies": {
    "@types/react": "^18.0.0 || ^19.0.0",
    "react": "^18.0.0 || ^19.0.0",
    "react-dom": "^18.0.0 || ^19.0.0"
  }
}
```

> `copy:docs` references `docs/PUBLIC-READ.md`, created in Task 9. Until then `pnpm --filter @agora-sdk/public-read-react-js run build` fails at the copy step — that is expected and is fixed by Task 9. `pnpm test` and `pnpm run typecheck` are unaffected.

- [ ] **Step 2: Create the two tsconfigs**

`packages/public-read/react-js/tsconfig.json` — identical to the core one from Task 1 Step 2.

`packages/public-read/react-js/tsconfig.esm.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "outDir": "./dist/esm", "module": "esnext" }
}
```

There is deliberately **no** `tsconfig.cjs.json` — this package is ESM-only.

- [ ] **Step 3: Add the package to all five root scripts**

In root `package.json`, insert `@agora-sdk/public-read-react-js` immediately after `@agora-sdk/public-read-core` in `build-all`, `version:patch`, `version:minor`, `publish-prod`, and `publish-beta`.

- [ ] **Step 4: Write the failing renderer test**

`packages/public-read/react-js/src/components/PublicCommentNodeView.test.tsx`:

```tsx
// @vitest-environment jsdom
import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PublicCommentNodeView, isTombstone } from "./PublicCommentNodeView.js";
import type { Comment, PublicCommentNode } from "@agora-sdk/public-read-core";

const node = (
  id: string,
  over: Partial<Comment> = {},
  replies: PublicCommentNode[] = []
): PublicCommentNode =>
  ({
    id,
    content: `body-${id}`,
    userDeletedAt: null,
    userReaction: null,
    createdAt: "2026-07-18T00:00:00Z",
    user: { id: `u-${id}`, username: `user-${id}` },
    replies,
    ...over,
  }) as unknown as PublicCommentNode;

describe("isTombstone", () => {
  it("is true only when the author deleted the comment", () => {
    expect(isTombstone(node("a", { userDeletedAt: "2026-07-18T00:00:00Z" }))).toBe(true);
    expect(isTombstone(node("a"))).toBe(false);
  });
});

describe("PublicCommentNodeView", () => {
  it("renders the comment body and author", () => {
    render(<PublicCommentNodeView node={node("a")} />);
    expect(screen.getByText("body-a")).toBeTruthy();
    expect(screen.getByText(/user-a/)).toBeTruthy();
  });

  it("renders nested replies recursively from the server's shape", () => {
    render(<PublicCommentNodeView node={node("a", {}, [node("b", {}, [node("c")])])} />);
    expect(screen.getByText("body-a")).toBeTruthy();
    expect(screen.getByText("body-b")).toBeTruthy();
    expect(screen.getByText("body-c")).toBeTruthy();
  });

  it("renders a tombstone placeholder for an author-deleted comment and never its content", () => {
    // The server blanks author-deleted comments in place (Reddit-style) rather than omitting them,
    // on BOTH the list and the thread — so this is a real state, not a defensive branch.
    render(
      <PublicCommentNodeView
        node={node("a", { userDeletedAt: "2026-07-18T00:00:00Z", content: "SHOULD NOT RENDER" })}
      />
    );
    expect(screen.getByText(/deleted/i)).toBeTruthy();
    expect(screen.queryByText("SHOULD NOT RENDER")).toBeNull();
  });

  it("still renders the replies under a tombstone (the subtree survives its parent)", () => {
    render(
      <PublicCommentNodeView
        node={node("a", { userDeletedAt: "2026-07-18T00:00:00Z" }, [node("b")])}
      />
    );
    expect(screen.getByText(/deleted/i)).toBeTruthy();
    expect(screen.getByText("body-b")).toBeTruthy();
  });

  it("does not crash when user is absent (include=user omitted)", () => {
    render(<PublicCommentNodeView node={node("a", { user: null })} />);
    expect(screen.getByText("body-a")).toBeTruthy();
  });

  it("renders no reaction, reply, or compose affordance anywhere — read-only is structural", () => {
    const { container } = render(<PublicCommentNodeView node={node("a", {}, [node("b")])} />);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.querySelectorAll("form, input, textarea")).toHaveLength(0);
  });

  it("hands renderComment the comment, its depth, and its rendered children", () => {
    render(
      <PublicCommentNodeView
        node={node("a", {}, [node("b")])}
        renderComment={(comment, { depth, children }) => (
          <div>
            <span>{`custom-${comment.id}@${depth}`}</span>
            {children}
          </div>
        )}
      />
    );
    expect(screen.getByText("custom-a@0")).toBeTruthy();
    expect(screen.getByText("custom-b@1")).toBeTruthy();
    // The default chrome is fully replaced, not wrapped.
    expect(screen.queryByText("body-a")).toBeNull();
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `pnpm test packages/public-read/react-js`
Expected: FAIL — `Failed to resolve import "./PublicCommentNodeView.js"`.

- [ ] **Step 6: Write the renderer**

`packages/public-read/react-js/src/components/PublicCommentNodeView.tsx`:

```tsx
// <PublicCommentNodeView /> — one comment plus its replies, rendered recursively.
//
// The server sends the thread already nested, so this walks `node.replies` directly; there is no
// client-side tree assembly (see usePublicCommentThread's header).
//
// Two things are structural rather than incidental:
//   1. READ-ONLY. There is no button, form, or input in this tree and no code path that adds one.
//      A reaction or reply control here would be inert at best — the public surface is GET-only.
//   2. TOMBSTONES. The server blanks author-deleted comments in place (Reddit-style placeholder,
//      `userDeletedAt` set) on both the list and the thread rather than omitting them, so a blanked
//      node is a normal state. Its replies still render: the subtree outlives its parent's content.
//
// Styling is self-contained inline styles with a `className` escape hatch, matching the
// social-react-js components — a blog can drop this in and have it look finished with no CSS. When
// that is not enough, `renderComment` replaces the chrome entirely.

import React from "react";
import type { Comment, PublicCommentNode } from "@agora-sdk/public-read-core";

/** Context handed to a {@link RenderComment} override. */
export interface RenderCommentContext {
  /** Nesting depth; `0` for a root comment. */
  depth: number;
  /** The already-rendered replies. Render them to keep the subtree. */
  children: React.ReactNode;
}

/**
 * Replace the default comment chrome.
 *
 * @param comment - The comment to render. Check `userDeletedAt` (or call {@link isTombstone}) before
 *   rendering `content` — an author-deleted comment arrives blanked and must not be shown as normal.
 * @param ctx - Depth plus the rendered replies.
 * @returns The node to render in place of the default.
 */
export type RenderComment = (comment: Comment, ctx: RenderCommentContext) => React.ReactNode;

/** Props for {@link PublicCommentNodeView}. */
export interface PublicCommentNodeViewProps {
  /** The comment and its inline replies, as the server sent them. */
  node: PublicCommentNode;
  /** Nesting depth, used for indentation. Defaults to `0`. */
  depth?: number;
  /** Optional full override of the default chrome. */
  renderComment?: RenderComment;
}

/**
 * Whether a comment is an author-deleted tombstone whose content has been blanked by the server.
 *
 * @param comment - The comment to test.
 * @returns `true` when the author deleted it; render a placeholder rather than `content`.
 */
export function isTombstone(comment: Comment): boolean {
  return comment.userDeletedAt !== null && comment.userDeletedAt !== undefined;
}

/** Indentation per nesting level, capped so a deep thread stays readable on a narrow blog column. */
const INDENT_PX = 20;
const MAX_INDENT_DEPTH = 6;

/**
 * Render one comment and its replies, recursively.
 *
 * @param props - {@link PublicCommentNodeViewProps}.
 * @returns The rendered comment subtree.
 *
 * @example
 * ```tsx
 * {nodes.map((n) => <PublicCommentNodeView key={n.id} node={n} />)}
 * ```
 */
export function PublicCommentNodeView({
  node,
  depth = 0,
  renderComment,
}: PublicCommentNodeViewProps): React.ReactElement {
  const replies = (
    <>
      {(node.replies ?? []).map((reply) => (
        <PublicCommentNodeView
          key={reply.id}
          node={reply}
          depth={depth + 1}
          renderComment={renderComment}
        />
      ))}
    </>
  );

  if (renderComment) {
    return <>{renderComment(node, { depth, children: replies })}</>;
  }

  const tombstone = isTombstone(node);
  const indent = Math.min(depth, MAX_INDENT_DEPTH) * INDENT_PX;

  return (
    <div
      style={{
        marginLeft: depth === 0 ? 0 : INDENT_PX,
        paddingLeft: depth === 0 ? 0 : 12,
        borderLeft: depth === 0 ? "none" : "1px solid rgba(128,128,128,0.25)",
        marginTop: 12,
      }}
      data-depth={depth}
    >
      <div style={{ fontSize: 13, opacity: 0.75, marginBottom: 4 }}>
        {tombstone ? "—" : (node.user?.username ?? "Someone")}
      </div>
      {tombstone ? (
        <div style={{ fontSize: 14, fontStyle: "italic", opacity: 0.55 }}>[deleted]</div>
      ) : (
        <div style={{ fontSize: 14, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{node.content}</div>
      )}
      {replies}
      {/* `indent` is computed for host overrides via data-depth; not applied twice. */}
      <span hidden data-indent={indent} />
    </div>
  );
}
```

- [ ] **Step 7: Write the barrel**

`packages/public-read/react-js/src/index.ts`:

```ts
// @agora-sdk/public-read-react-js — web components for the Agora anonymous public surface.
//
// Re-exports everything from @agora-sdk/public-read-core and adds the drop-in comment thread. Works
// with no Agora SDK installed: a third-party blog needs only this package and a baseUrl + projectId.

// ── components ───────────────────────────────────────────────────────────────
export { PublicCommentNodeView, isTombstone } from "./components/PublicCommentNodeView.js";
export type {
  PublicCommentNodeViewProps,
  RenderComment,
  RenderCommentContext,
} from "./components/PublicCommentNodeView.js";

// ── core (provider, hooks, transport, types) ─────────────────────────────────
export * from "@agora-sdk/public-read-core";
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `pnpm install && pnpm test packages/public-read/react-js`
Expected: PASS, 8 tests. (`pnpm install` links the `workspace:*` dependency.)

- [ ] **Step 9: Typecheck and commit**

Run: `pnpm run typecheck` — expected clean.

Add to `CHANGELOG.md` under `[Unreleased]` → `### Added`:

```markdown
- **`@agora-sdk/public-read-react-js` — new package + `<PublicCommentNodeView>`.** Recursive renderer
  over the server's nested `replies[]`, ESM-only like the other web packages. Handles the
  author-deleted **tombstone** as a first-class state: the server blanks those comments in place on
  both the list and the thread rather than omitting them, and their replies still render because the
  subtree outlives its parent's content. Read-only is structural — the tree contains no button, form,
  or input, and a test pins that.
```

```bash
git add packages/public-read/react-js package.json pnpm-lock.yaml CHANGELOG.md
git commit -m "feat(public-read): react-js package + recursive comment node renderer"
```

---

### Task 7: `<PublicComments>` — the drop-in

**Files:**
- Create: `packages/public-read/react-js/src/components/PublicComments.tsx`
- Modify: `packages/public-read/react-js/src/index.ts`
- Test: `packages/public-read/react-js/src/components/PublicComments.test.tsx`

**Interfaces:**
- Consumes: `PublicCommentNodeView`, `RenderComment` (Task 6); `usePublicEntity` (Task 3), `usePublicCommentThread`, `usePublicComments` (Tasks 4–5).
- Produces:
  ```ts
  interface PublicCommentsProps {
    /** Exactly one of entityId / foreignId is required. */
    entityId?: string | null;
    foreignId?: string | null;
    mode?: "thread" | "paged";
    limit?: number;
    className?: string;
    renderComment?: RenderComment;
    emptyState?: React.ReactNode;
    onSignInRequired?: () => void;
  }
  function PublicComments(props: PublicCommentsProps): React.ReactElement;
  ```

- [ ] **Step 1: Write the failing test**

`packages/public-read/react-js/src/components/PublicComments.test.tsx`:

```tsx
// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { PublicComments } from "./PublicComments.js";
import {
  PublicReadProvider,
  PublicReadRestClient,
  PublicReadApiError,
  type Comment,
  type PublicCommentNode,
} from "@agora-sdk/public-read-core";

const node = (id: string, replies: PublicCommentNode[] = []): PublicCommentNode =>
  ({
    id,
    content: `body-${id}`,
    userDeletedAt: null,
    user: { id: `u-${id}`, username: `user-${id}` },
    replies,
  }) as unknown as PublicCommentNode;

const flat = (id: string): Comment =>
  ({ id, content: `body-${id}`, userDeletedAt: null, user: null }) as unknown as Comment;

const mount = (ui: React.ReactNode) =>
  render(
    <PublicReadProvider projectId="p1" baseUrl="http://host/v7">
      {ui}
    </PublicReadProvider>
  );

afterEach(() => vi.restoreAllMocks());

describe("PublicComments", () => {
  it("defaults to thread mode: one request to the nested route, none to the flat list", async () => {
    const getThread = vi
      .spyOn(PublicReadRestClient.prototype, "getThread")
      .mockResolvedValue({ data: [node("a", [node("b")])] });
    const getComments = vi.spyOn(PublicReadRestClient.prototype, "getComments");

    mount(<PublicComments entityId="e1" />);

    await waitFor(() => expect(screen.getByText("body-a")).toBeTruthy());
    expect(screen.getByText("body-b")).toBeTruthy();
    expect(getThread).toHaveBeenCalledTimes(1);
    expect(getComments).not.toHaveBeenCalled();
  });

  it("uses the flat list in paged mode and renders a Load more control when hasMore", async () => {
    const getComments = vi.spyOn(PublicReadRestClient.prototype, "getComments").mockResolvedValue({
      data: [flat("a")],
      pagination: { page: 1, pageSize: 20, totalPages: 2, totalItems: 2, hasMore: true },
    });
    const getThread = vi.spyOn(PublicReadRestClient.prototype, "getThread");

    mount(<PublicComments entityId="e1" mode="paged" />);

    await waitFor(() => expect(screen.getByText("body-a")).toBeTruthy());
    expect(getComments).toHaveBeenCalled();
    expect(getThread).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /load more/i })).toBeTruthy();
  });

  it("loads the next page when Load more is clicked", async () => {
    const spy = vi
      .spyOn(PublicReadRestClient.prototype, "getComments")
      .mockResolvedValueOnce({
        data: [flat("a")],
        pagination: { page: 1, pageSize: 20, totalPages: 2, totalItems: 2, hasMore: true },
      })
      .mockResolvedValueOnce({
        data: [flat("b")],
        pagination: { page: 2, pageSize: 20, totalPages: 2, totalItems: 2, hasMore: false },
      });

    mount(<PublicComments entityId="e1" mode="paged" />);
    await waitFor(() => expect(screen.getByText("body-a")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /load more/i }));
    await waitFor(() => expect(screen.getByText("body-b")).toBeTruthy());
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("renders ONE neutral empty state on 404, with no reason in the copy", async () => {
    vi.spyOn(PublicReadRestClient.prototype, "getThread").mockRejectedValue(
      new PublicReadApiError("gone", 404, "entities/not-found")
    );
    const { container } = mount(<PublicComments entityId="e1" />);

    await waitFor(() => expect(container.textContent).toBeTruthy());
    const text = container.textContent ?? "";
    // The gate makes these indistinguishable on purpose — leaking a guess would build the existence
    // oracle the server's 404-never-403 posture exists to deny.
    for (const forbidden of ["unpublish", "draft", "removed", "private", "deleted", "permission"]) {
      expect(text.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("renders the same neutral empty state for an empty thread as for a 404", async () => {
    vi.spyOn(PublicReadRestClient.prototype, "getThread").mockResolvedValue({ data: [] });
    const { container: emptyC } = mount(<PublicComments entityId="e1" />);
    await waitFor(() => expect(emptyC.textContent).toBeTruthy());
    const emptyText = emptyC.textContent;

    vi.restoreAllMocks();
    vi.spyOn(PublicReadRestClient.prototype, "getThread").mockRejectedValue(
      new PublicReadApiError("gone", 404, null)
    );
    const { container: notFoundC } = mount(<PublicComments entityId="e1" />);
    await waitFor(() => expect(notFoundC.textContent).toBeTruthy());

    expect(notFoundC.textContent).toBe(emptyText);
  });

  it("honors a custom emptyState", async () => {
    vi.spyOn(PublicReadRestClient.prototype, "getThread").mockResolvedValue({ data: [] });
    mount(<PublicComments entityId="e1" emptyState={<p>Nothing yet, friend.</p>} />);
    await waitFor(() => expect(screen.getByText("Nothing yet, friend.")).toBeTruthy());
  });

  it("renders a sign-in CTA only when onSignInRequired is supplied", async () => {
    vi.spyOn(PublicReadRestClient.prototype, "getThread").mockResolvedValue({ data: [node("a")] });
    const onSignInRequired = vi.fn();
    const { rerender } = mount(<PublicComments entityId="e1" />);
    await waitFor(() => expect(screen.getByText("body-a")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /sign in/i })).toBeNull();

    rerender(
      <PublicReadProvider projectId="p1" baseUrl="http://host/v7">
        <PublicComments entityId="e1" onSignInRequired={onSignInRequired} />
      </PublicReadProvider>
    );
    await waitFor(() => expect(screen.getByRole("button", { name: /sign in/i })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    expect(onSignInRequired).toHaveBeenCalledTimes(1);
  });

  it("resolves foreignId first, then fetches the thread by the returned uuid", async () => {
    const byForeign = vi
      .spyOn(PublicReadRestClient.prototype, "getEntityByForeignId")
      .mockResolvedValue({ id: "resolved-uuid", public: true } as never);
    const getThread = vi
      .spyOn(PublicReadRestClient.prototype, "getThread")
      .mockResolvedValue({ data: [node("a")] });

    mount(<PublicComments foreignId="homepage-comments" />);

    await waitFor(() => expect(screen.getByText("body-a")).toBeTruthy());
    expect(byForeign).toHaveBeenCalledWith("homepage-comments", undefined);
    // The comment routes are uuid-only, so the second leg must use the RESOLVED id, not the key.
    expect(getThread).toHaveBeenCalledWith("resolved-uuid", expect.anything());
  });

  it("skips the resolve step entirely when given an entityId", async () => {
    const byForeign = vi.spyOn(PublicReadRestClient.prototype, "getEntityByForeignId");
    vi.spyOn(PublicReadRestClient.prototype, "getThread").mockResolvedValue({ data: [node("a")] });

    mount(<PublicComments entityId="e1" />);

    await waitFor(() => expect(screen.getByText("body-a")).toBeTruthy());
    expect(byForeign).not.toHaveBeenCalled();
  });

  it("renders the neutral empty state when the foreignId does not resolve", async () => {
    vi.spyOn(PublicReadRestClient.prototype, "getEntityByForeignId").mockRejectedValue(
      new PublicReadApiError("gone", 404, "entities/not-found")
    );
    const getThread = vi.spyOn(PublicReadRestClient.prototype, "getThread");
    const { container } = mount(<PublicComments foreignId="nope" />);

    await waitFor(() => expect(container.textContent).toContain("No comments"));
    // No point asking for a thread on an anchor that did not resolve.
    expect(getThread).not.toHaveBeenCalled();
  });

  it("passes renderComment through to the node renderer", async () => {
    vi.spyOn(PublicReadRestClient.prototype, "getThread").mockResolvedValue({ data: [node("a")] });
    mount(
      <PublicComments
        entityId="e1"
        renderComment={(c) => <span>{`custom-${c.id}`}</span>}
      />
    );
    await waitFor(() => expect(screen.getByText("custom-a")).toBeTruthy());
  });

  it("ships no compose affordance in either mode", async () => {
    vi.spyOn(PublicReadRestClient.prototype, "getThread").mockResolvedValue({ data: [node("a")] });
    const { container } = mount(<PublicComments entityId="e1" />);
    await waitFor(() => expect(screen.getByText("body-a")).toBeTruthy());
    expect(container.querySelectorAll("form, input, textarea")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test packages/public-read/react-js/src/components/PublicComments.test.tsx`
Expected: FAIL — `Failed to resolve import "./PublicComments.js"`.

- [ ] **Step 3: Write the component**

`packages/public-read/react-js/src/components/PublicComments.tsx`:

```tsx
// <PublicComments /> — the drop-in an embedding page mounts.
//
// Defaults to `mode="thread"`: one round trip to the server-nested route, rendered recursively. That
// is the embed case, which is the product. `mode="paged"` switches to the flat offset-paginated list
// with a "Load more" control, for threads that outgrow the thread route's 50-root default page.
//
// The empty state is deliberately IDENTICAL for "no comments yet" and for the gate's 404. The server
// collapses unpublished / missing / draft / removed / space-went-private into one indistinguishable
// 404 (PUBLIC-API.md §4); rendering different copy for the two — or copy that names a reason — would
// rebuild the existence oracle the 404-never-403 posture exists to deny. One neutral sentence, always.
//
// Read-only is structural: the only interactive elements this can ever render are "Load more" and the
// optional sign-in CTA, and the CTA does nothing but call the host's callback. There is no compose
// box, no reaction control, and no auth dependency — the host renders its own sign-in UI.

import React from "react";
import {
  usePublicEntity,
  usePublicCommentThread,
  usePublicComments,
  type PublicCommentNode,
} from "@agora-sdk/public-read-core";

import { PublicCommentNodeView, type RenderComment } from "./PublicCommentNodeView.js";

/** How {@link PublicComments} fetches the thread. */
export type PublicCommentsMode = "thread" | "paged";

/** Props for {@link PublicComments}. */
export interface PublicCommentsProps {
  /**
   * The entity uuid whose thread to render. Provide this **or** {@link foreignId}, not both.
   *
   * @remarks
   * Prefer `foreignId` in an embed — the uuid is generated per install, so it cannot be hardcoded.
   */
  entityId?: string | null;
  /**
   * The host app's own stable key for the anchor (e.g. `"homepage-comments"`, a post slug).
   *
   * @remarks
   * Costs one extra round trip on first paint: the component resolves the anchor, then fetches its
   * thread by the returned uuid, because the comment routes are uuid-only.
   */
  foreignId?: string | null;
  /**
   * `"thread"` (default) fetches the whole nested thread in one request. `"paged"` uses the flat
   * offset-paginated list with a "Load more" control — prefer it for very long threads.
   */
  mode?: PublicCommentsMode;
  /** Page size. Server defaults: 50 roots in `thread` mode, 20 comments in `paged` mode. */
  limit?: number;
  /** Class for the root element, for host layout/spacing. */
  className?: string;
  /** Replace the default comment chrome entirely. */
  renderComment?: RenderComment;
  /**
   * Replaces the default neutral empty state.
   *
   * @remarks
   * It is shown both when the thread is genuinely empty and when the gate `404`s. Keep it neutral —
   * do not write copy that guesses why (see the module header).
   */
  emptyState?: React.ReactNode;
  /**
   * Called when the reader activates the "sign in to join the conversation" control.
   *
   * The control renders **only** when this prop is supplied. This package ships no auth UI and takes
   * no auth dependency; the host owns the sign-in flow.
   */
  onSignInRequired?: () => void;
}

/** The one neutral message shown for both an empty thread and the gate's ambiguous 404. */
const NEUTRAL_EMPTY = "No comments to show.";

/**
 * Render an entity's public comment thread, read-only and anonymously.
 *
 * @param props - {@link PublicCommentsProps}.
 * @returns The rendered thread, a neutral empty state, or `null` while loading.
 *
 * @throws {Error} In development only, when both `entityId` and `foreignId` are supplied.
 *
 * @example
 * ```tsx
 * // The usual embed: address the anchor by the key your app already uses.
 * <PublicReadProvider projectId={projectId} baseUrl="https://api.example.com/v7">
 *   <PublicComments
 *     foreignId="homepage-comments"
 *     onSignInRequired={() => router.push("/login")}
 *   />
 * </PublicReadProvider>
 * ```
 */
export function PublicComments({
  entityId,
  foreignId,
  mode = "thread",
  limit,
  className,
  renderComment,
  emptyState,
  onSignInRequired,
}: PublicCommentsProps): React.ReactElement {
  if (process.env.NODE_ENV !== "production" && entityId && foreignId) {
    throw new Error(
      "<PublicComments> takes either entityId or foreignId, not both. Pass the uuid if you have it; otherwise pass your own key."
    );
  }

  // Leg 1 — resolve the anchor. Skipped entirely when the caller already has a uuid: passing `null`
  // makes usePublicEntity a no-op, so the common case stays a single request.
  const resolved = usePublicEntity(foreignId ? { foreignId } : null);
  const targetId = foreignId ? resolved.entityId : (entityId ?? null);

  // Leg 2 — the thread, always by uuid (the comment routes have no foreignId form). Both hooks are
  // called unconditionally to satisfy the rules of hooks; the inactive one gets a null id and never
  // issues a request. `targetId` is null until leg 1 lands, which is what sequences the two-step.
  const thread = usePublicCommentThread(mode === "thread" ? targetId : null, { limit });
  const paged = usePublicComments(mode === "paged" ? targetId : null, { limit });

  // A foreignId that does not resolve is the same neutral empty state as a thread that 404s — the
  // reader must not be able to tell which leg failed, for the same reason the gate's 404 is uniform.
  const resolveFailed = Boolean(foreignId) && (resolved.notFound || resolved.error !== null);
  const resolving = Boolean(foreignId) && resolved.loading;

  const loading = resolving || (mode === "thread" ? thread.loading : paged.loading);
  const hasMore = mode === "thread" ? false : paged.hasMore;
  const loadMore = mode === "thread" ? undefined : paged.loadMore;

  // In paged mode the flat comments have no `replies`, so adapt them to the node shape the renderer
  // takes. Reply paging is a host concern in this mode — the list is one level by definition.
  const nodes: PublicCommentNode[] =
    mode === "thread"
      ? thread.nodes
      : paged.comments.map((c) => ({ ...c, replies: [] }) as PublicCommentNode);

  const isEmpty = resolveFailed || (!loading && nodes.length === 0);

  return (
    <div className={className}>
      {isEmpty ? (
        emptyState ?? <p style={{ fontSize: 14, opacity: 0.6, margin: 0 }}>{NEUTRAL_EMPTY}</p>
      ) : (
        nodes.map((node) => (
          <PublicCommentNodeView key={node.id} node={node} renderComment={renderComment} />
        ))
      )}

      {hasMore && loadMore ? (
        <button
          type="button"
          onClick={loadMore}
          disabled={loading}
          style={{
            marginTop: 16,
            padding: "8px 14px",
            fontSize: 13,
            cursor: loading ? "default" : "pointer",
            background: "transparent",
            border: "1px solid rgba(128,128,128,0.35)",
            borderRadius: 6,
          }}
        >
          Load more
        </button>
      ) : null}

      {onSignInRequired ? (
        <button
          type="button"
          onClick={onSignInRequired}
          style={{
            marginTop: 16,
            padding: "8px 14px",
            fontSize: 13,
            cursor: "pointer",
            background: "transparent",
            border: "1px solid rgba(128,128,128,0.35)",
            borderRadius: 6,
          }}
        >
          Sign in to join the conversation
        </button>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Export it from the barrel**

Add to the `── components ──` section of `packages/public-read/react-js/src/index.ts`:

```ts
export { PublicComments } from "./components/PublicComments.js";
export type { PublicCommentsProps, PublicCommentsMode } from "./components/PublicComments.js";
```

- [ ] **Step 5: Run the full suite**

Run: `pnpm test`
Expected: PASS — the whole workspace suite green, including 12 new `PublicComments` tests.

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm run typecheck` — expected clean.

Add to `CHANGELOG.md` under `[Unreleased]` → `### Added`:

```markdown
- **`@agora-sdk/public-read-react-js` — `<PublicComments>`, the drop-in thread.** Takes either an
  `entityId` or — the mode an embed actually wants — a `foreignId` like `"homepage-comments"`, since
  the uuid is generated per install and can't be hardcoded in a template. Given a `foreignId` it
  resolves the anchor and then fetches the thread by the returned uuid, because the comment routes
  are uuid-only; given an `entityId` it skips the resolve entirely. A `foreignId` that doesn't
  resolve renders the *same* neutral empty state as a thread that 404s — a reader must not be able to
  tell which leg failed. Defaults to
  `mode="thread"` (one round trip, server-nested); `mode="paged"` switches to the flat list with a
  "Load more" control. The empty state is **identical** for "no comments yet" and for the gate's
  `404`, and a test pins that neither ever names a reason — differing copy would rebuild the
  existence oracle the server's 404-never-403 posture exists to deny. Styling is self-contained inline
  styles with a `className` hook and a `renderComment` render prop for full control. `onSignInRequired`
  renders a CTA only when supplied and only calls back — no auth UI, no auth dependency.
```

```bash
git add packages/public-read/react-js CHANGELOG.md
git commit -m "feat(public-read): PublicComments drop-in with thread and paged modes"
```

---

### Task 8: Generalize `verify-dist.mjs` past `packages/secure-chat`

The spec (§10) flags this as a pre-existing gap: line 27 hardcodes one feature group, so `social`'s dist has never been verified in CI despite `pnpm run verify:dist` running. `public-read` would inherit the same blind spot. Fixing it here covers all three groups.

**Files:**
- Modify: `scripts/verify-dist.mjs:27` and the package-scan loop

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing importable — a CI guard.

- [ ] **Step 1: Replace the hardcoded directory with a feature-group scan**

In `scripts/verify-dist.mjs`, replace line 27:

```js
const pkgsDir = fileURLToPath(new URL("../packages/secure-chat", import.meta.url));
```

with:

```js
const packagesRoot = fileURLToPath(new URL("../packages", import.meta.url));

// Feature groups are `packages/<feature>/<platform>`, so scan two levels rather than one. This used
// to hardcode `packages/secure-chat`, which silently skipped every other group — social's dist was
// never verified despite this script running in CI.
function packageDirs() {
  const out = [];
  for (const feature of readdirSync(packagesRoot)) {
    const featureDir = join(packagesRoot, feature);
    if (!statSync(featureDir).isDirectory()) continue;
    for (const platform of readdirSync(featureDir)) {
      const dir = join(featureDir, platform);
      if (statSync(dir).isDirectory() && existsSync(join(dir, "package.json"))) out.push(dir);
    }
  }
  return out;
}
```

- [ ] **Step 2: Rewrite the scan loop to consume it**

Replace the loop header:

```js
for (const dir of readdirSync(pkgsDir)) {
  const base = join(pkgsDir, dir);
  const pkgPath = join(base, "package.json");
  if (!existsSync(pkgPath)) continue;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (pkg.private) continue;
```

with:

```js
for (const base of packageDirs()) {
  const pkg = JSON.parse(readFileSync(join(base, "package.json"), "utf8"));
  if (pkg.private) continue;
```

The loop body is unchanged.

- [ ] **Step 3: Fix the crypto smoke-load paths**

The runtime load at the bottom still refers to `pkgsDir`. Replace both constants:

```js
const cryptoEsm = join(pkgsDir, "crypto", "dist", "esm", "testing.js");
const cryptoCjs = join(pkgsDir, "crypto", "dist", "cjs", "testing.js");
```

with:

```js
const cryptoEsm = join(packagesRoot, "secure-chat", "crypto", "dist", "esm", "testing.js");
const cryptoCjs = join(packagesRoot, "secure-chat", "crypto", "dist", "cjs", "testing.js");
```

- [ ] **Step 4: Build everything and run the guard**

Run: `pnpm run build-all && pnpm run verify:dist`

Expected: `✓ verify-dist: ESM specifiers extensioned, CJS marked commonjs, crypto loads (ESM + CJS).`

If it now reports problems in `social` or `auth` packages that were previously invisible, **fix them** — that is the whole point of this task. Report any such findings in the commit message rather than suppressing them.

> This step requires Task 9's `docs/PUBLIC-READ.md` to exist, because `public-read-react-js`'s `build` runs `copy:docs`. If you are executing tasks in order, run Task 9 first or create the doc file early.

- [ ] **Step 5: Commit**

Add to `CHANGELOG.md` under `[Unreleased]` → `### Fixed`:

```markdown
- **`verify:dist` only ever checked `packages/secure-chat`.** The script hardcoded that one feature
  group's directory, so `social`'s (and now `public-read`'s) emitted `dist/` was never linted for
  extensionless ESM specifiers or a missing CJS type marker — despite CI running the script on every
  push. It now scans all `packages/<feature>/<platform>` directories.
```

```bash
git add scripts/verify-dist.mjs CHANGELOG.md
git commit -m "fix(scripts): verify-dist scans every feature group, not just secure-chat"
```

---

### Task 9: Docs + repo propagation

**Files:**
- Create: `docs/PUBLIC-READ.md`
- Create: `packages/public-read/react-js/README.md`
- Modify: `README.md`, `ARCHITECTURE.md`, `STATUS.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: the full public surface from Tasks 1–7.
- Produces: nothing importable.

- [ ] **Step 1: Write `docs/PUBLIC-READ.md`**

Follow the `docs/SOCIAL-GRAPH.md` shape exactly: a `>` metadata blockquote, numbered `##` sections separated by `---` rules, and an italic `*Source: …*` footer. Required sections:

```markdown
# Agora Public Read — SDK Integration Guide 🌍

> **Audience:** app developers embedding an anonymous, read-only Agora comment thread.
> **Canonical wire contract:** `agora-server/docs/PUBLIC-API.md`
> **Design reference:** `docs/superpowers/specs/2026-07-18-public-read-design.md`
> **Implemented by:** `@agora-sdk/public-read-core`, `@agora-sdk/public-read-react-js`

---

## Overview — the open door
   (what internet-public means, the visibility ladder in one table, and a copy-paste
    <PublicReadProvider> + <PublicComments foreignId="homepage-comments" /> snippet —
    lead with foreignId, since the uuid is per-install and can't be hardcoded)

## 1. Setup — `<PublicReadProvider>`
   (props table; the no-token / no-ReplykeProvider guarantees)

## 2. Addressing an anchor — `usePublicEntity`
   ### By `foreignId` (what an embed should use, and why)
   ### By uuid · ### The two-step, and its extra round trip
   ### Guessability — `foreignId` is not a secret
   ### Response · ### Error handling

## 3. The thread — `usePublicCommentThread`
   ### Response — `PublicCommentNode` · ### Why it is not reassembled client-side

## 4. The flat list — `usePublicComments`
   ### Query options · ### Reply paging via `parentId`

## 5. The drop-in — `<PublicComments>`
   ### Props · ### `thread` vs `paged` · ### Styling and `renderComment`

## 6. The auth swap
   (the {user ? <CommentSection/> : <PublicComments/>} pattern; zero shared state
    and why a seamless upgrade was rejected)

## 7. What you must never render
   ### The 404 is deliberately ambiguous
   ### Never send a token or cookies
   ### `userReaction` is always null; `birthdate`/`metadata` are redacted

## 8. Caching and takedown
   (max-age=0 + s-maxage=300 + ETag; the bounded 300s edge window; why the SDK
    adds no cache of its own)

## 9. Not included
   (no writes, no permalinks, no discovery, no realtime, no native packages)

## 10. TypeScript types quick-reference

## 11. Package layout

---
*Source: `agora-server` `apps/api/src/routes/public.ts`, `lib/public-access.ts`, `lib/public-cache.ts`.*
```

Write real prose in every section — the numbered sections are load-bearing because source comments cite them.

- [ ] **Step 2: Write the package README**

`packages/public-read/react-js/README.md`, following `packages/social/react-js/README.md`'s shape: title, one-paragraph blurb, `## Install`, a short usage snippet, and `## Full guide` pointing at the shipped `PUBLIC-READ.md`. State plainly in the blurb that it needs **no Agora SDK and no account** — that is the package's whole reason to exist.

- [ ] **Step 3: Update the root README**

Add a Features table row (emoji + name + one-line description + link to `docs/PUBLIC-READ.md`) and a Packages block line:

```
public-read  @agora-sdk/public-read-{core,react-js}
```

- [ ] **Step 4: Update `ARCHITECTURE.md`**

Add a `subgraph` for `public-read` to the package graph Mermaid `flowchart TD`, and a `## Public-read layers & seams` section with its own `flowchart LR` modeled on the social one. The arrow worth drawing: `public-read-core → @agora-server/contract` and **no arrow at all** to any `@agora-sdk/*` — that absence is the architecture.

- [ ] **Step 5: Update `STATUS.md`**

Add `public-read-core` and `public-read-react-js` bullets under `## Built`, and record the contract floor `^0.21.0` in the artifact table.

- [ ] **Step 6: Update `CLAUDE.md`**

Two places go stale otherwise:

1. The Architecture section — add the `public-read` group to the package listing, with a one-line description matching the others' style, plus a sentence noting it is the repo's only fully tokenless feature.
2. The `build-all` bullet under "Development commands" — the prose spells out the exact build order; add `public-read` (core → react-js) before `auth-react-js`.

- [ ] **Step 7: Verify the doc-copy step now works**

Run: `pnpm --filter @agora-sdk/public-read-react-js run build`
Expected: succeeds, and `packages/public-read/react-js/PUBLIC-READ.md` exists afterward.

- [ ] **Step 8: Commit**

Add to `CHANGELOG.md` under `[Unreleased]` → `### Added`:

```markdown
- **`docs/PUBLIC-READ.md` — integration guide for the anonymous public surface.** Numbered-section
  guide covering setup, all three hooks, the `<PublicComments>` drop-in, the auth-swap pattern, the
  never-render rules, and the caching/takedown window. Shipped inside `@agora-sdk/public-read-react-js`
  via `copy:docs`. Root README, `ARCHITECTURE.md`, `STATUS.md`, and `CLAUDE.md` updated to include the
  new feature group.
```

```bash
git add docs/PUBLIC-READ.md packages/public-read/react-js/README.md README.md ARCHITECTURE.md STATUS.md CLAUDE.md CHANGELOG.md
git commit -m "docs(public-read): integration guide + repo propagation"
```

---

### Task 10: Opt-in e2e against a local server *(optional — not a v1 gate)*

The spec (§9, §13) calls this valuable but not blocking: CORS behavior, the live gate, and the ETag/304 round trip cannot be faithfully unit-tested.

**Fixture:** project `11111111-1111-1111-1111-111111111111`, anchor `foreignId: "homepage-comments"`, seeded by `pnpm seed` from `agora-server/apps/api`. The anchor's uuid is generated per install, so the test resolves it by `foreignId` rather than hardcoding one.

**Files:**
- Create: `e2e/public-read.e2e.test.ts`

**Interfaces:**
- Consumes: `PublicReadRestClient` from Task 1.
- Produces: nothing importable.

- [ ] **Step 1: Confirm the fixture is seeded**

```bash
PID=11111111-1111-1111-1111-111111111111
curl -s "http://localhost:4000/v7/$PID/public/entities/by-foreign-id?foreignId=homepage-comments"
```

Expected: a JSON entity with `"public": true`. If it returns `{"code":"entities/not-found"}`, run `pnpm seed` from `agora-server/apps/api` first (it prompts for admin credentials) — every assertion below depends on it.

- [ ] **Step 2: Write the e2e test**

`e2e/public-read.e2e.test.ts`:

```ts
// Opt-in e2e for the anonymous public-read surface, against a locally running agora-server.
//
// Covers exactly what a mocked transport cannot prove: real CORS headers, the ETag → 304
// revalidation round trip, `no-store` on the gate's 404, and that no Authorization header survives
// to the wire even when a host app sets an axios global default.
//
// Skipped unless AGORA_E2E_PUBLIC_PROJECT_ID is set, so `pnpm test` and CI stay server-free.

import { describe, it, expect, beforeAll } from "vitest";
import axios from "axios";
import { PublicReadRestClient } from "../packages/public-read/core/src/index.js";

const PROJECT_ID = process.env.AGORA_E2E_PUBLIC_PROJECT_ID;
const FOREIGN_ID = process.env.AGORA_E2E_PUBLIC_FOREIGN_ID ?? "homepage-comments";
const BASE_URL = process.env.AGORA_E2E_BASE_URL ?? "http://localhost:4000/v7";

const suite = PROJECT_ID ? describe : describe.skip;

suite("public-read e2e", () => {
  const rest = new PublicReadRestClient({
    projectId: PROJECT_ID!,
    getBaseUrl: () => BASE_URL,
  });
  const pub = `${BASE_URL}/${PROJECT_ID}/public`;
  let entityId: string;

  beforeAll(async () => {
    const entity = await rest.getEntityByForeignId(FOREIGN_ID);
    entityId = entity.id;
  });

  it("resolves the anchor by foreignId and reports it as public", async () => {
    const entity = await rest.getEntityByForeignId(FOREIGN_ID, { include: ["user"] });
    expect(entity.id).toBe(entityId);
    expect(entity.public).toBe(true);
  });

  it("redacts PII on an included user", async () => {
    const entity = await rest.getEntityByForeignId(FOREIGN_ID, { include: ["user"] });
    const user = (entity as unknown as { user?: Record<string, unknown> }).user;
    if (user) {
      expect(user.birthdate ?? null).toBeNull();
      expect(user.metadata ?? {}).toEqual({});
    }
  });

  it("returns a well-formed pagination envelope for the flat list", async () => {
    const res = await rest.getComments(entityId, { include: ["user"] });
    expect(Array.isArray(res.data)).toBe(true);
    expect(res.pagination).toMatchObject({
      page: expect.any(Number),
      pageSize: expect.any(Number),
      hasMore: expect.any(Boolean),
    });
    for (const c of res.data) expect(c.userReaction).toBeNull();
  });

  it("returns a server-nested thread with at least one reply", async () => {
    const { data } = await rest.getThread(entityId, { include: ["user"] });
    expect(data.length).toBeGreaterThan(0);
    for (const n of data) expect(Array.isArray(n.replies)).toBe(true);
    // The seed includes a nested reply — proof the nesting is server-side, not assembled here.
    expect(data.some((n) => n.replies.length > 0)).toBe(true);
  });

  it("serves wildcard CORS with no credentials and no Vary", async () => {
    const res = await axios.get(`${pub}/entities/${entityId}`, {
      headers: { Origin: "https://some-blog.example" },
    });
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(res.headers["vary"]).toBeUndefined();
  });

  it("revalidates via ETag → 304, keeping the CORS header on the 304", async () => {
    const first = await axios.get(`${pub}/entities/${entityId}`);
    const etag = first.headers["etag"];
    expect(etag).toBeTruthy();
    expect(first.headers["cache-control"]).toContain("s-maxage=300");

    const second = await axios.get(`${pub}/entities/${entityId}`, {
      headers: { "If-None-Match": etag },
      validateStatus: (s) => s === 304 || s === 200,
    });
    expect(second.status).toBe(304);
    expect(second.headers["access-control-allow-origin"]).toBe("*");
  });

  it("404s an unknown entity with no-store, so a publish is never cached away", async () => {
    const res = await axios.get(`${pub}/entities/00000000-0000-4000-8000-000000000000`, {
      validateStatus: () => true,
    });
    expect(res.status).toBe(404);
    expect(res.headers["cache-control"]).toContain("no-store");
  });

  it("sends no Authorization header even when one is an axios global default", async () => {
    // A host app doing this is the realistic leak, and it would break the embed via CORS preflight.
    axios.defaults.headers.common["Authorization"] = "Bearer leaked-token";
    try {
      const entity = await rest.getEntityByForeignId(FOREIGN_ID);
      expect(entity.id).toBe(entityId);
    } finally {
      delete axios.defaults.headers.common["Authorization"];
    }
  });

  it("still 401s the same entity behind the wall — the hole is the prefix, not the entity", async () => {
    const res = await axios.get(`${BASE_URL}/${PROJECT_ID}/entities/${entityId}`, {
      validateStatus: () => true,
    });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 3: Run it**

```bash
AGORA_E2E_PUBLIC_PROJECT_ID=11111111-1111-1111-1111-111111111111 pnpm test:e2e
```

Expected: all 9 assertions pass against the locally running server.

- [ ] **Step 4: Confirm the unit suite is still server-free**

Run: `pnpm test`
Expected: PASS, with the e2e file **not** collected (it lives under `e2e/**`, which the root vitest config does not glob).

- [ ] **Step 5: Commit**

Add to `CHANGELOG.md` under `[Unreleased]` → `### Added`:

```markdown
- **Opt-in e2e for the public-read surface.** Exercises all four routes against a locally running
  `agora-server`, plus the things a mocked transport cannot prove: wildcard CORS with no credentials
  and no `Vary`, the `ETag` → `304` revalidation round trip, `no-store` on the gate's `404`, PII
  redaction on an included user, and that no `Authorization` header reaches the wire even when a host
  app sets an axios global default. Resolves the seeded anchor by `foreignId` rather than hardcoding a
  uuid, since the uuid is generated per install. Skipped unless `AGORA_E2E_PUBLIC_PROJECT_ID` is set,
  so `pnpm test` and CI stay server-free.
```

```bash
git add e2e/public-read.e2e.test.ts CHANGELOG.md
git commit -m "test(public-read): opt-in e2e for CORS, ETag revalidation, and the live gate"
```

---

## Done criteria

- [ ] `pnpm test` green (workspace-wide).
- [ ] `pnpm run typecheck` clean.
- [ ] `pnpm run build-all` succeeds, including both new packages.
- [ ] `pnpm run verify:dist` passes and now covers all three feature groups.
- [ ] `CHANGELOG.md` has a bullet for every task under `[Unreleased]`.
- [ ] No `@agora-sdk/*` string appears anywhere in `packages/public-read/*/package.json` except the two `@agora-sdk/public-read-*` names themselves. Verify:
      `grep -rn '"@agora-sdk/' packages/public-read/*/package.json`
- [ ] No user-facing string in `packages/public-read` names a 404 reason. Verify:
      `grep -rniE 'unpublish|not published|is draft|was removed|private space|no permission' packages/public-read/*/src`
      Expected: no matches outside comments explaining why.
