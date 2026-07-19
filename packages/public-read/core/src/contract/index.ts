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
