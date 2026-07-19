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

/** Indentation per nesting level, and the depth past which it stops growing. */
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
  // Indentation stops growing past MAX_INDENT_DEPTH so a deep thread stays readable inside a narrow
  // blog column instead of marching off the right edge.
  const nested = depth > 0;
  const indent = nested ? Math.min(depth, MAX_INDENT_DEPTH) * INDENT_PX : 0;

  return (
    <div
      data-depth={depth}
      style={{
        marginLeft: indent,
        paddingLeft: nested ? 12 : 0,
        borderLeft: nested ? "1px solid rgba(128,128,128,0.25)" : "none",
        marginTop: 12,
      }}
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
    </div>
  );
}
