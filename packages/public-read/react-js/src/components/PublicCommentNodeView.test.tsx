// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
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

// The root vitest config does not enable `globals`, so @testing-library/react never registers its
// automatic afterEach(cleanup) — without this, every render stays mounted in document.body and
// queries match elements left behind by earlier tests.
afterEach(cleanup);

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
