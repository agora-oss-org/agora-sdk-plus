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
export { PublicComments } from "./components/PublicComments.js";
export type { PublicCommentsProps, PublicCommentsMode } from "./components/PublicComments.js";

// ── core (provider, hooks, transport, types) ─────────────────────────────────
export * from "@agora-sdk/public-read-core";
