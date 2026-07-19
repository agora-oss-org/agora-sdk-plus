// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { PublicReadProvider } from "../context/public-read-context.js";
import { usePublicComments } from "./usePublicComments.js";
import { PublicReadRestClient, PublicReadApiError } from "../transport/rest.js";
import type { Comment, PaginatedResponse } from "../contract/index.js";

const comment = (id: string): Comment => ({ id, content: `c-${id}` }) as unknown as Comment;

const envelope = (
  data: Comment[],
  over?: Partial<PaginatedResponse<Comment>["pagination"]>
): PaginatedResponse<Comment> => ({
  data,
  pagination: {
    page: 1,
    pageSize: 20,
    totalPages: 1,
    totalItems: data.length,
    hasMore: false,
    ...over,
  },
});

const wrap =
  () =>
  ({ children }: { children: React.ReactNode }) => (
    <PublicReadProvider projectId="p1" baseUrl="http://host/v7">
      {children}
    </PublicReadProvider>
  );

afterEach(() => vi.restoreAllMocks());

describe("usePublicComments", () => {
  it("fetches page 1 and exposes the list plus hasMore", async () => {
    vi.spyOn(PublicReadRestClient.prototype, "getComments").mockResolvedValue(
      envelope([comment("a"), comment("b")], { hasMore: true, totalPages: 2 })
    );
    const { result } = renderHook(() => usePublicComments("e1"), { wrapper: wrap() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.comments.map((c) => c.id)).toEqual(["a", "b"]);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.page).toBe(1);
  });

  it("appends on loadMore rather than replacing", async () => {
    const spy = vi
      .spyOn(PublicReadRestClient.prototype, "getComments")
      .mockResolvedValueOnce(envelope([comment("a")], { hasMore: true, totalPages: 2 }))
      .mockResolvedValueOnce(envelope([comment("b")], { page: 2, hasMore: false, totalPages: 2 }));

    const { result } = renderHook(() => usePublicComments("e1"), { wrapper: wrap() });
    await waitFor(() => expect(result.current.comments).toHaveLength(1));

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.comments).toHaveLength(2));

    expect(result.current.comments.map((c) => c.id)).toEqual(["a", "b"]);
    expect(result.current.hasMore).toBe(false);
    expect(spy).toHaveBeenLastCalledWith("e1", expect.objectContaining({ page: 2 }));
  });

  it("is a no-op when loadMore is called with hasMore false", async () => {
    const spy = vi
      .spyOn(PublicReadRestClient.prototype, "getComments")
      .mockResolvedValue(envelope([comment("a")]));
    const { result } = renderHook(() => usePublicComments("e1"), { wrapper: wrap() });
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("handles an empty list without setting notFound", async () => {
    vi.spyOn(PublicReadRestClient.prototype, "getComments").mockResolvedValue(envelope([]));
    const { result } = renderHook(() => usePublicComments("e1"), { wrapper: wrap() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.comments).toEqual([]);
    expect(result.current.hasMore).toBe(false);
    // A published entity with zero comments is NOT a 404 — the distinction matters for the renderer.
    expect(result.current.notFound).toBe(false);
  });

  it("pages replies when parentId is set", async () => {
    const spy = vi
      .spyOn(PublicReadRestClient.prototype, "getComments")
      .mockResolvedValue(envelope([comment("r1")]));
    const { result } = renderHook(() => usePublicComments("e1", { parentId: "c1" }), {
      wrapper: wrap(),
    });

    await waitFor(() => expect(result.current.comments).toHaveLength(1));
    expect(spy).toHaveBeenCalledWith("e1", expect.objectContaining({ parentId: "c1" }));
  });

  it("maps a malformed-parentId 404 to notFound with no error", async () => {
    vi.spyOn(PublicReadRestClient.prototype, "getComments").mockRejectedValue(
      new PublicReadApiError("bad parent", 404, "entities/not-found")
    );
    const { result } = renderHook(() => usePublicComments("e1", { parentId: "nope" }), {
      wrapper: wrap(),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.notFound).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.comments).toEqual([]);
  });

  it("resets to page 1 and refetches when sortBy changes", async () => {
    const spy = vi
      .spyOn(PublicReadRestClient.prototype, "getComments")
      .mockResolvedValue(envelope([comment("a")], { hasMore: true, totalPages: 3 }));
    const { result } = renderHook(() => usePublicComments("e1"), { wrapper: wrap() });
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.page).toBe(2));

    act(() => result.current.setSortBy("top"));
    await waitFor(() => expect(result.current.page).toBe(1));
    expect(spy).toHaveBeenLastCalledWith("e1", expect.objectContaining({ page: 1, sortBy: "top" }));
  });

  it("never sends spaceReputation params", async () => {
    const spy = vi
      .spyOn(PublicReadRestClient.prototype, "getComments")
      .mockResolvedValue(envelope([]));
    renderHook(() => usePublicComments("e1"), { wrapper: wrap() });

    await waitFor(() => expect(spy).toHaveBeenCalled());
    const sent = JSON.stringify(spy.mock.calls[0]?.[1] ?? {});
    expect(sent).not.toMatch(/spaceReputation/i);
  });

  it("does not fetch when entityId is null (the pre-resolution state of a foreignId chain)", async () => {
    const spy = vi.spyOn(PublicReadRestClient.prototype, "getComments");
    const { result } = renderHook(() => usePublicComments(null), { wrapper: wrap() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(spy).not.toHaveBeenCalled();
    expect(result.current.comments).toEqual([]);
  });
});
