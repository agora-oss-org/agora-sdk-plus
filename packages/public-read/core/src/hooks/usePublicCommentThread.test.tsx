// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { PublicReadProvider } from "../context/public-read-context.js";
import { usePublicCommentThread } from "./usePublicCommentThread.js";
import { PublicReadRestClient, PublicReadApiError } from "../transport/rest.js";
import type { PublicCommentNode } from "../contract/index.js";

const node = (id: string, replies: PublicCommentNode[] = []): PublicCommentNode =>
  ({ id, content: `c-${id}`, replies }) as unknown as PublicCommentNode;

const wrap =
  () =>
  ({ children }: { children: React.ReactNode }) => (
    <PublicReadProvider projectId="p1" baseUrl="http://host/v7">
      {children}
    </PublicReadProvider>
  );

afterEach(() => vi.restoreAllMocks());

describe("usePublicCommentThread", () => {
  it("exposes the server's nested shape verbatim (no client-side assembly)", async () => {
    const tree = [node("a", [node("a1", [node("a1a")])]), node("b")];
    vi.spyOn(PublicReadRestClient.prototype, "getThread").mockResolvedValue({ data: tree });

    const { result } = renderHook(() => usePublicCommentThread("e1"), { wrapper: wrap() });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.nodes).toEqual(tree);
    expect(result.current.nodes[0]?.replies[0]?.replies[0]?.id).toBe("a1a");
  });

  it("maps the gate's 404 to notFound with no error", async () => {
    vi.spyOn(PublicReadRestClient.prototype, "getThread").mockRejectedValue(
      new PublicReadApiError("gone", 404, "entities/not-found")
    );
    const { result } = renderHook(() => usePublicCommentThread("e1"), { wrapper: wrap() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.notFound).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.nodes).toEqual([]);
  });

  it("infers hasMore from a full page, since the thread route sends no pagination envelope", async () => {
    const full = Array.from({ length: 3 }, (_, i) => node(`n${i}`));
    vi.spyOn(PublicReadRestClient.prototype, "getThread").mockResolvedValue({ data: full });

    const { result } = renderHook(() => usePublicCommentThread("e1", { limit: 3 }), {
      wrapper: wrap(),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasMore).toBe(true);
  });

  it("infers hasMore false from a short page", async () => {
    vi.spyOn(PublicReadRestClient.prototype, "getThread").mockResolvedValue({
      data: [node("a"), node("b")],
    });
    const { result } = renderHook(() => usePublicCommentThread("e1", { limit: 3 }), {
      wrapper: wrap(),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasMore).toBe(false);
  });

  it("appends root nodes on loadMore", async () => {
    const spy = vi
      .spyOn(PublicReadRestClient.prototype, "getThread")
      .mockResolvedValueOnce({ data: [node("a"), node("b")] })
      .mockResolvedValueOnce({ data: [node("c")] });

    const { result } = renderHook(() => usePublicCommentThread("e1", { limit: 2 }), {
      wrapper: wrap(),
    });
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.nodes).toHaveLength(3));
    expect(result.current.nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(spy).toHaveBeenLastCalledWith("e1", expect.objectContaining({ page: 2 }));
  });

  it("passes rootId through untouched (the server treats a malformed one as absent)", async () => {
    const spy = vi.spyOn(PublicReadRestClient.prototype, "getThread").mockResolvedValue({ data: [] });
    renderHook(() => usePublicCommentThread("e1", { rootId: "not-a-uuid" }), { wrapper: wrap() });

    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith("e1", expect.objectContaining({ rootId: "not-a-uuid" }));
  });

  it("does not fetch when entityId is absent", async () => {
    const spy = vi.spyOn(PublicReadRestClient.prototype, "getThread");
    const { result } = renderHook(() => usePublicCommentThread(undefined), { wrapper: wrap() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(spy).not.toHaveBeenCalled();
  });
});
