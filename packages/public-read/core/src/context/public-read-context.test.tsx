// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { PublicReadProvider, usePublicRead } from "./public-read-context.js";
import { PublicReadRestClient } from "../transport/rest.js";

const wrap =
  (props?: { projectId?: string; baseUrl?: string }) =>
  ({ children }: { children: React.ReactNode }) => (
    <PublicReadProvider
      projectId={props?.projectId ?? "p1"}
      baseUrl={props?.baseUrl ?? "http://host/v7"}
    >
      {children}
    </PublicReadProvider>
  );

afterEach(() => vi.restoreAllMocks());

describe("PublicReadProvider", () => {
  it("exposes a REST client and the project id, with no config fetch on mount", () => {
    // Unlike SocialProvider there is no transparency endpoint on the public surface, so mounting
    // must issue ZERO requests — a network call here would be a design regression.
    const getEntity = vi.spyOn(PublicReadRestClient.prototype, "getEntity");
    const getComments = vi.spyOn(PublicReadRestClient.prototype, "getComments");
    const getThread = vi.spyOn(PublicReadRestClient.prototype, "getThread");

    const { result } = renderHook(() => usePublicRead(), { wrapper: wrap() });

    expect(result.current.rest).toBeInstanceOf(PublicReadRestClient);
    expect(result.current.projectId).toBe("p1");
    expect(getEntity).not.toHaveBeenCalled();
    expect(getComments).not.toHaveBeenCalled();
    expect(getThread).not.toHaveBeenCalled();
  });

  it("keeps the same client identity across re-renders with unchanged props", () => {
    const { result, rerender } = renderHook(() => usePublicRead(), { wrapper: wrap() });
    const first = result.current.rest;
    rerender();
    expect(result.current.rest).toBe(first);
  });

  it("throws when used outside a provider", () => {
    // Suppress the two channels React 18's dev build uses to surface the (expected) render-time
    // throw, so this negative case stays quiet:
    //  1. console.error — React's "The above error occurred" boundary suggestion.
    //  2. The window "error" event — React re-dispatches the throw onto a detached node, jsdom
    //     catches it and reports via its `jsdomError` virtual-console channel (NOT console.error).
    //     jsdom's reportException honors defaultPrevented, so a preventDefault listener silences it.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const swallowError = (event: ErrorEvent) => event.preventDefault();
    window.addEventListener("error", swallowError);
    try {
      expect(() => renderHook(() => usePublicRead())).toThrow(/within a <PublicReadProvider>/);
    } finally {
      window.removeEventListener("error", swallowError);
      errSpy.mockRestore();
    }
  });

  it("renders with no ReplykeProvider anywhere in the tree (the third-party embed case)", () => {
    // This is the whole point of the package: a blog embedding a thread has no Agora SDK installed.
    // The test asserts it by simply not providing one — if any code path reached for SDK context or
    // its boot latch, this would throw or hang.
    const { result } = renderHook(() => usePublicRead(), { wrapper: wrap() });
    expect(result.current.rest).toBeInstanceOf(PublicReadRestClient);
  });
});
