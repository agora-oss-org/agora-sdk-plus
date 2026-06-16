// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { SocialProvider, useSocial, ALL_DISABLED_SOCIAL_CONFIG } from "../context/social-context.js";
import { useSocialNeighborhood } from "./useSocialNeighborhood.js";
import { SocialRestClient } from "../transport/rest.js";
import type { ResolvedSocialConfig } from "../contract/index.js";

const config = (over: Partial<ResolvedSocialConfig>): ResolvedSocialConfig => ({
  ...ALL_DISABLED_SOCIAL_CONFIG,
  graphEnabled: true,
  warmthHalfLifeDays: 30,
  frictionHalfLifeDays: 14,
  constellationKFloor: 5,
  ...over,
});

const wrap = () =>
  ({ children }: { children: React.ReactNode }) => (
    <SocialProvider projectId="p" accessToken="t">
      {children}
    </SocialProvider>
  );

afterEach(() => vi.restoreAllMocks());

describe("useSocialNeighborhood", () => {
  it("returns null and never fetches when the lens is disabled", async () => {
    vi.spyOn(SocialRestClient.prototype, "getTransparency").mockResolvedValue(
      config({ neighborhoodEnabled: false })
    );
    const get = vi.spyOn(SocialRestClient.prototype, "getNeighborhood");

    const { result } = renderHook(() => ({ n: useSocialNeighborhood(), s: useSocial() }), {
      wrapper: wrap(),
    });
    await waitFor(() => expect(result.current.s.configLoading).toBe(false));

    expect(result.current.n.neighborhood).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it("seeds the toggle from the project default and fetches with it", async () => {
    vi.spyOn(SocialRestClient.prototype, "getTransparency").mockResolvedValue(
      config({ neighborhoodEnabled: true, neighborhoodIncludeInteractions: false })
    );
    const get = vi
      .spyOn(SocialRestClient.prototype, "getNeighborhood")
      .mockImplementation(async (opts) => ({
        ties: [],
        includesInteractions: !!opts?.includeInteractions,
        asOf: "x",
      }));

    const { result } = renderHook(() => useSocialNeighborhood(), { wrapper: wrap() });
    await waitFor(() => expect(result.current.neighborhood).not.toBeNull());

    expect(result.current.includeInteractions).toBe(false);
    expect(get).toHaveBeenCalledWith({ includeInteractions: false });
  });

  it("re-fetches when the interactions toggle flips", async () => {
    vi.spyOn(SocialRestClient.prototype, "getTransparency").mockResolvedValue(
      config({ neighborhoodEnabled: true, neighborhoodIncludeInteractions: false })
    );
    const get = vi
      .spyOn(SocialRestClient.prototype, "getNeighborhood")
      .mockImplementation(async (opts) => ({
        ties: [],
        includesInteractions: !!opts?.includeInteractions,
        asOf: "x",
      }));

    const { result } = renderHook(() => useSocialNeighborhood(), { wrapper: wrap() });
    await waitFor(() => expect(result.current.neighborhood).not.toBeNull());

    act(() => result.current.setIncludeInteractions(true));
    await waitFor(() => expect(result.current.includeInteractions).toBe(true));
    expect(get).toHaveBeenLastCalledWith({ includeInteractions: true });
  });
});
