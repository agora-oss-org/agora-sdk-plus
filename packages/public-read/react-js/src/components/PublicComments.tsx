// <PublicComments /> — the drop-in an embedding page mounts.
//
// Defaults to `mode="thread"`: one round trip to the server-nested route, rendered recursively. That
// is the embed case, which is the product. `mode="paged"` switches to the flat offset-paginated list
// with a "Load more" control, for threads that outgrow the thread route's 50-root default page.
//
// ADDRESSING. Takes `entityId` OR `foreignId`. Prefer `foreignId` in an embed: the entity's uuid is
// generated per install, so a blog template cannot hardcode it. Because the comment routes are
// uuid-only, a `foreignId` costs one extra round trip — resolve the anchor, then fetch its thread —
// and this component owns that dance so no host has to write it.
//
// The empty state is deliberately IDENTICAL for "no comments yet", a failed anchor resolve, and the
// gate's 404. The server collapses unpublished / missing / draft / removed / space-went-private into
// one indistinguishable 404 (PUBLIC-API.md §4); rendering different copy for those — or copy that
// names a reason — would rebuild the existence oracle the 404-never-403 posture exists to deny. One
// neutral sentence, always.
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
   * The entity uuid whose thread to render. Provide this **or** {@link PublicCommentsProps.foreignId},
   * not both.
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
   * It is shown when the thread is empty, when the anchor fails to resolve, and when the gate
   * `404`s. Keep it neutral — do not write copy that guesses why (see the module header).
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

/** The one neutral message shown for an empty thread, a failed resolve, and the gate's 404 alike. */
const NEUTRAL_EMPTY = "No comments to show.";

/** Shared chrome for the two buttons this component can render. */
const BUTTON_STYLE: React.CSSProperties = {
  marginTop: 16,
  padding: "8px 14px",
  fontSize: 13,
  background: "transparent",
  border: "1px solid rgba(128,128,128,0.35)",
  borderRadius: 6,
};

/**
 * Render an entity's public comment thread, read-only and anonymously.
 *
 * @param props - {@link PublicCommentsProps}.
 * @returns The rendered thread or a neutral empty state.
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
  const hasMore = mode === "paged" && paged.hasMore;

  // In paged mode the flat comments have no `replies`, so adapt them to the node shape the renderer
  // takes. Reply paging is a host concern in this mode — the list is one level by definition.
  const nodes: PublicCommentNode[] =
    mode === "thread"
      ? thread.nodes
      : paged.comments.map((c) => ({ ...c, replies: [] }) as PublicCommentNode);

  const isEmpty = resolveFailed || (!loading && nodes.length === 0);

  return (
    <div className={className}>
      {isEmpty
        ? (emptyState ?? <p style={{ fontSize: 14, opacity: 0.6, margin: 0 }}>{NEUTRAL_EMPTY}</p>)
        : nodes.map((node) => (
            <PublicCommentNodeView key={node.id} node={node} renderComment={renderComment} />
          ))}

      {hasMore ? (
        <button
          type="button"
          onClick={paged.loadMore}
          disabled={loading}
          style={{ ...BUTTON_STYLE, cursor: loading ? "default" : "pointer" }}
        >
          Load more
        </button>
      ) : null}

      {onSignInRequired ? (
        <button
          type="button"
          onClick={onSignInRequired}
          style={{ ...BUTTON_STYLE, cursor: "pointer" }}
        >
          Sign in to join the conversation
        </button>
      ) : null}
    </div>
  );
}
