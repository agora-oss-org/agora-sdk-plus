// Typed REST client for the Agora anonymous public-read surface (internet-public entities + their
// comment threads). Covers all four routes in agora-server `docs/PUBLIC-API.md` §3, path-scoped to
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

/**
 * Typed REST client for the four anonymous public-read endpoints.
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
 * const anchor = await rest.getEntityByForeignId("homepage-comments");
 * const { data } = await rest.getThread(anchor.id, { include: ["user"] });
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
   * Fetch an internet-public entity by its uuid.
   *
   * @param entityId - The entity uuid.
   * @param opts - Optional relations to inline.
   * @returns The shaped entity (a bare object, not a `{ data }` envelope).
   * @throws {PublicReadApiError} `404` when the gate rejects (see {@link isNotFound}).
   *
   * @remarks
   * The uuid is generated per install, so an embed usually cannot hardcode it — prefer
   * {@link getEntityByForeignId}.
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
   * @returns The shaped entity — the same shape {@link getEntity} returns, through the same gate.
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
