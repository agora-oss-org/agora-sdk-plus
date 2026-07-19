// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { PublicComments } from "./PublicComments.js";
import {
  PublicReadProvider,
  PublicReadRestClient,
  PublicReadApiError,
  type Comment,
  type Entity,
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

// See PublicCommentNodeView.test.tsx — the root vitest config has no `globals`, so RTL's automatic
// cleanup never registers and renders would otherwise leak between tests.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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
    const text = (container.textContent ?? "").toLowerCase();
    // The gate makes these indistinguishable on purpose — leaking a guess would build the existence
    // oracle the server's 404-never-403 posture exists to deny.
    for (const forbidden of ["unpublish", "draft", "removed", "private", "deleted", "permission"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("renders the same neutral empty state for an empty thread as for a 404", async () => {
    vi.spyOn(PublicReadRestClient.prototype, "getThread").mockResolvedValue({ data: [] });
    const { container: emptyC } = mount(<PublicComments entityId="e1" />);
    await waitFor(() => expect(emptyC.textContent).toBeTruthy());
    const emptyText = emptyC.textContent;

    cleanup();
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

    mount(<PublicComments entityId="e1" />);
    await waitFor(() => expect(screen.getByText("body-a")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /sign in/i })).toBeNull();

    cleanup();
    const onSignInRequired = vi.fn();
    mount(<PublicComments entityId="e1" onSignInRequired={onSignInRequired} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /sign in/i })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    expect(onSignInRequired).toHaveBeenCalledTimes(1);
  });

  it("passes renderComment through to the node renderer", async () => {
    vi.spyOn(PublicReadRestClient.prototype, "getThread").mockResolvedValue({ data: [node("a")] });
    mount(<PublicComments entityId="e1" renderComment={(c) => <span>{`custom-${c.id}`}</span>} />);
    await waitFor(() => expect(screen.getByText("custom-a")).toBeTruthy());
  });

  it("ships no compose affordance in either mode", async () => {
    vi.spyOn(PublicReadRestClient.prototype, "getThread").mockResolvedValue({ data: [node("a")] });
    const { container } = mount(<PublicComments entityId="e1" />);
    await waitFor(() => expect(screen.getByText("body-a")).toBeTruthy());
    expect(container.querySelectorAll("form, input, textarea")).toHaveLength(0);
  });

  it("resolves foreignId first, then fetches the thread by the returned uuid", async () => {
    const byForeign = vi
      .spyOn(PublicReadRestClient.prototype, "getEntityByForeignId")
      .mockResolvedValue({ id: "resolved-uuid", public: true } as unknown as Entity);
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
});
