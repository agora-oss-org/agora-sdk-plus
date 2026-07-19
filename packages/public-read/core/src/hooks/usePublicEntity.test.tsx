// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { PublicReadProvider } from "../context/public-read-context.js";
import { usePublicEntity } from "./usePublicEntity.js";
import { PublicReadRestClient, PublicReadApiError } from "../transport/rest.js";
import type { Entity } from "../contract/index.js";

const ENTITY = { id: "e1", public: true, title: "Hello" } as unknown as Entity;

const wrap =
  () =>
  ({ children }: { children: React.ReactNode }) => (
    <PublicReadProvider projectId="p1" baseUrl="http://host/v7">
      {children}
    </PublicReadProvider>
  );

afterEach(() => vi.restoreAllMocks());

describe("usePublicEntity", () => {
  it("fetches and exposes the entity", async () => {
    vi.spyOn(PublicReadRestClient.prototype, "getEntity").mockResolvedValue(ENTITY);
    const { result } = renderHook(() => usePublicEntity("e1"), { wrapper: wrap() });

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.entity).toEqual(ENTITY);
    expect(result.current.notFound).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("maps the gate's 404 to notFound with NO error — the neutral empty state", async () => {
    vi.spyOn(PublicReadRestClient.prototype, "getEntity").mockRejectedValue(
      new PublicReadApiError("gone", 404, "entities/not-found")
    );
    const { result } = renderHook(() => usePublicEntity("e1"), { wrapper: wrap() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.notFound).toBe(true);
    expect(result.current.entity).toBeNull();
    // An error here would tempt a renderer into showing a message that guesses WHY — the server
    // deliberately makes unpublished/missing/draft/removed/space-went-private indistinguishable.
    expect(result.current.error).toBeNull();
  });

  it("surfaces project/not-found as a real error (host misconfiguration, not an empty page)", async () => {
    vi.spyOn(PublicReadRestClient.prototype, "getEntity").mockRejectedValue(
      new PublicReadApiError("bad project", 404, "project/not-found")
    );
    const { result } = renderHook(() => usePublicEntity("e1"), { wrapper: wrap() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeInstanceOf(PublicReadApiError);
    expect(result.current.notFound).toBe(false);
  });

  it("surfaces a 500 as a real error", async () => {
    vi.spyOn(PublicReadRestClient.prototype, "getEntity").mockRejectedValue(
      new PublicReadApiError("boom", 500, null)
    );
    const { result } = renderHook(() => usePublicEntity("e1"), { wrapper: wrap() });

    await waitFor(() => expect(result.current.error).toBeInstanceOf(PublicReadApiError));
    expect(result.current.entity).toBeNull();
    expect(result.current.notFound).toBe(false);
  });

  it("does not fetch and is not loading when the target is absent", async () => {
    const getEntity = vi.spyOn(PublicReadRestClient.prototype, "getEntity");
    const { result } = renderHook(() => usePublicEntity(null), { wrapper: wrap() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getEntity).not.toHaveBeenCalled();
    expect(result.current.entity).toBeNull();
  });

  it("clears a previous notFound when the entityId changes", async () => {
    const spy = vi
      .spyOn(PublicReadRestClient.prototype, "getEntity")
      .mockRejectedValueOnce(new PublicReadApiError("gone", 404, null))
      .mockResolvedValueOnce(ENTITY);

    const { result, rerender } = renderHook(({ id }: { id: string }) => usePublicEntity(id), {
      wrapper: wrap(),
      initialProps: { id: "e1" },
    });
    await waitFor(() => expect(result.current.notFound).toBe(true));

    rerender({ id: "e2" });
    await waitFor(() => expect(result.current.entity).toEqual(ENTITY));
    expect(result.current.notFound).toBe(false);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("resolves by foreignId and exposes the resolved uuid for chaining", async () => {
    const byForeign = vi
      .spyOn(PublicReadRestClient.prototype, "getEntityByForeignId")
      .mockResolvedValue(ENTITY);
    const byId = vi.spyOn(PublicReadRestClient.prototype, "getEntity");

    const { result } = renderHook(() => usePublicEntity({ foreignId: "homepage-comments" }), {
      wrapper: wrap(),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(byForeign).toHaveBeenCalledWith("homepage-comments", undefined);
    expect(byId).not.toHaveBeenCalled();
    // The uuid the comment hooks need — the whole point of returning it.
    expect(result.current.entityId).toBe("e1");
  });

  it("treats a bare string and { entityId } identically, as a uuid", async () => {
    const byId = vi.spyOn(PublicReadRestClient.prototype, "getEntity").mockResolvedValue(ENTITY);
    const byForeign = vi.spyOn(PublicReadRestClient.prototype, "getEntityByForeignId");

    const { result } = renderHook(() => usePublicEntity({ entityId: "e1" }), { wrapper: wrap() });
    await waitFor(() => expect(result.current.entityId).toBe("e1"));

    expect(byId).toHaveBeenCalledWith("e1", undefined);
    expect(byForeign).not.toHaveBeenCalled();
  });

  it("surfaces a missing-foreign-id 400 as a real error, not notFound", async () => {
    // An empty foreignId is a CALLER bug. Rendering "no comments" for it would hide an integration
    // mistake behind a state that looks intentional.
    vi.spyOn(PublicReadRestClient.prototype, "getEntityByForeignId").mockRejectedValue(
      new PublicReadApiError("missing", 400, "entities/missing-foreign-id")
    );
    const { result } = renderHook(() => usePublicEntity({ foreignId: "" }), { wrapper: wrap() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeInstanceOf(PublicReadApiError);
    expect(result.current.notFound).toBe(false);
  });

  it("maps an unknown foreignId's 404 to the same neutral notFound", async () => {
    vi.spyOn(PublicReadRestClient.prototype, "getEntityByForeignId").mockRejectedValue(
      new PublicReadApiError("gone", 404, "entities/not-found")
    );
    const { result } = renderHook(() => usePublicEntity({ foreignId: "nope" }), { wrapper: wrap() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.notFound).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.entityId).toBeNull();
  });
});
