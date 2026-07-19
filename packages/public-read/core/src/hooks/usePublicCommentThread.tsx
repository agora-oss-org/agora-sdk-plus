// usePublicCommentThread — the whole nested thread in one round trip.
//
// The server assembles the tree (fetch_comment_thread RPC, parents before children) and prunes
// removed comments together with their descendant subtrees. We expose `data` VERBATIM: do not port
// the fork's `helpers/addCommentsToTree.ts`, which exists only because the walled surface serves
// flat pages.
//
// `hasMore` is INFERRED from `nodes.length >= limit`, because this route sends no pagination
// envelope. The inference costs one wasted final request when the root count divides evenly by the
// page size — the correct trade against inventing a client-side count the server never gave us.
//
// Accepts a null `entityId` and no-ops, which is what lets it sit downstream of usePublicEntity in a
// foreignId chain without the caller writing a guard.

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
 * @param entityId - The entity uuid, or `null`/`undefined` to skip fetching (the pre-resolution
 *   state when chained after {@link usePublicEntity}).
 * @param opts - `rootId`, page size, and relations.
 * @returns {@link UsePublicCommentThreadValues}.
 *
 * @example
 * ```tsx
 * const { nodes, notFound } = usePublicCommentThread(id, { include: ["user"] });
 * if (notFound) return <p>No comments to show.</p>;
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
