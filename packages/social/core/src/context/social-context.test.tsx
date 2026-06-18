// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { SocialProvider, useSocial, ALL_DISABLED_SOCIAL_CONFIG } from "./social-context.js";
import { SocialRestClient, SocialApiError } from "../transport/rest.js";
import type { ResolvedSocialConfig } from "../contract/index.js";

const CONFIG: ResolvedSocialConfig = {
  ...ALL_DISABLED_SOCIAL_CONFIG,
  graphEnabled: true,
  weatherEnabled: true,
  neighborhoodEnabled: true,
  constellationEnabled: true,
  warmthHalfLifeDays: 30,
  frictionHalfLifeDays: 14,
  constellationKFloor: 5,
};

const wrap = () =>
  ({ children }: { children: React.ReactNode }) => (
    <SocialProvider projectId="p" baseUrl="http://localhost:4000/v7" accessToken="t">
      {children}
    </SocialProvider>
  );

afterEach(() => vi.restoreAllMocks());

describe("SocialProvider", () => {
  it("auto-fetches transparency on mount and exposes the resolved config", async () => {
    vi.spyOn(SocialRestClient.prototype, "getTransparency").mockResolvedValue(CONFIG);
    const { result } = renderHook(() => useSocial(), { wrapper: wrap() });

    expect(result.current.configLoading).toBe(true);
    expect(result.current.config).toBeNull();

    await waitFor(() => expect(result.current.configLoading).toBe(false));
    expect(result.current.config).toEqual(CONFIG);
    expect(result.current.configError).toBeNull();
  });

  it("treats 503 graph-unavailable as the all-disabled sentinel, not an error", async () => {
    vi.spyOn(SocialRestClient.prototype, "getTransparency").mockRejectedValue(
      new SocialApiError("graph off", 503, "social/graph-unavailable")
    );
    const { result } = renderHook(() => useSocial(), { wrapper: wrap() });

    await waitFor(() => expect(result.current.configLoading).toBe(false));
    expect(result.current.config).toEqual(ALL_DISABLED_SOCIAL_CONFIG);
    expect(result.current.configError).toBeNull();
  });

  it("surfaces a non-degradation error via configError (config stays null)", async () => {
    vi.spyOn(SocialRestClient.prototype, "getTransparency").mockRejectedValue(
      new SocialApiError("boom", 500, null)
    );
    const { result } = renderHook(() => useSocial(), { wrapper: wrap() });

    await waitFor(() => expect(result.current.configLoading).toBe(false));
    expect(result.current.config).toBeNull();
    expect(result.current.configError).toBeInstanceOf(SocialApiError);
  });

  it("throws when useSocial is used outside a provider", () => {
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
      expect(() => renderHook(() => useSocial())).toThrow(/within a <SocialProvider>/);
    } finally {
      window.removeEventListener("error", swallowError);
      errSpy.mockRestore();
    }
  });
});
