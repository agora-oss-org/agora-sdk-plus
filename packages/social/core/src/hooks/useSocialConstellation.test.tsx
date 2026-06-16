// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { SocialProvider, useSocial, ALL_DISABLED_SOCIAL_CONFIG } from "../context/social-context.js";
import { useSocialConstellation } from "./useSocialConstellation.js";
import { SocialRestClient } from "../transport/rest.js";
import type { ResolvedSocialConfig, SocialConstellation } from "../contract/index.js";

const config = (over: Partial<ResolvedSocialConfig>): ResolvedSocialConfig => ({
  ...ALL_DISABLED_SOCIAL_CONFIG,
  graphEnabled: true,
  warmthHalfLifeDays: 30,
  frictionHalfLifeDays: 14,
  constellationKFloor: 5,
  ...over,
});

const SNAPSHOT: SocialConstellation = {
  blobs: [
    { size: "10–19", warmth: "fine" },
    { size: "100+", warmth: "sunny" },
  ],
  asOf: "2026-05-01T00:00:00Z",
  method: "louvain",
};

const wrap = () =>
  ({ children }: { children: React.ReactNode }) => (
    <SocialProvider projectId="p" accessToken="t">
      {children}
    </SocialProvider>
  );

afterEach(() => vi.restoreAllMocks());

describe("useSocialConstellation", () => {
  it("returns null and never fetches when the lens is disabled", async () => {
    vi.spyOn(SocialRestClient.prototype, "getTransparency").mockResolvedValue(
      config({ constellationEnabled: false })
    );
    const get = vi.spyOn(SocialRestClient.prototype, "getConstellation").mockResolvedValue(SNAPSHOT);

    const { result } = renderHook(() => ({ c: useSocialConstellation(), s: useSocial() }), {
      wrapper: wrap(),
    });
    await waitFor(() => expect(result.current.s.configLoading).toBe(false));

    expect(result.current.c.constellation).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it("fetches the snapshot when enabled", async () => {
    vi.spyOn(SocialRestClient.prototype, "getTransparency").mockResolvedValue(
      config({ constellationEnabled: true })
    );
    vi.spyOn(SocialRestClient.prototype, "getConstellation").mockResolvedValue(SNAPSHOT);

    const { result } = renderHook(() => useSocialConstellation(), { wrapper: wrap() });
    await waitFor(() => expect(result.current.constellation).toEqual(SNAPSHOT));
  });

  it("surfaces a still-forming snapshot (asOf: null) as data, not an error", async () => {
    vi.spyOn(SocialRestClient.prototype, "getTransparency").mockResolvedValue(
      config({ constellationEnabled: true })
    );
    vi.spyOn(SocialRestClient.prototype, "getConstellation").mockResolvedValue({
      blobs: [],
      asOf: null,
      method: null,
    });

    const { result } = renderHook(() => useSocialConstellation(), { wrapper: wrap() });
    await waitFor(() => expect(result.current.constellation).not.toBeNull());
    expect(result.current.constellation?.asOf).toBeNull();
    expect(result.current.error).toBeNull();
  });
});
