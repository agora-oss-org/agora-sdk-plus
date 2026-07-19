// usePublicComments — one level of an anonymous comment list, offset-paginated.
//
// Top-level comments by default; set `parentId` to page the replies under a comment (the endpoint
// and the state machine are identical, so there is no separate replies hook). Pagination is
// offset/page-based — `loadMore` APPENDS, matching the `{ data, pagination }` envelope the server
// sends. Changing sort resets to page 1, because a page-2 offset into a re-sorted list is meaningless.
//
// Accepts a null `entityId` and no-ops, which is what lets it sit downstream of usePublicEntity in a
// foreignId chain without the caller writing a guard.
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
 * @param entityId - The entity uuid, or `null`/`undefined` to skip fetching (the pre-resolution
 *   state when chained after {@link usePublicEntity}).
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
