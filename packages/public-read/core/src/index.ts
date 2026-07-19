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

// ── hooks ────────────────────────────────────────────────────────────────────
export { usePublicEntity } from "./hooks/usePublicEntity.js";
export type { UsePublicEntityValues, PublicEntityTarget } from "./hooks/usePublicEntity.js";
export { usePublicComments } from "./hooks/usePublicComments.js";
export type {
  UsePublicCommentsOptions,
  UsePublicCommentsValues,
} from "./hooks/usePublicComments.js";

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
