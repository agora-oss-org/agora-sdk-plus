// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { SocialProvider, ALL_DISABLED_SOCIAL_CONFIG } from "../context/social-context.js";
import { useSocialTransparency } from "./useSocialTransparency.js";
import { SocialRestClient } from "../transport/rest.js";
import type { ResolvedSocialConfig } from "../contract/index.js";

const CONFIG: ResolvedSocialConfig = {
  ...ALL_DISABLED_SOCIAL_CONFIG,
  graphEnabled: true,
  weatherEnabled: true,
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

describe("useSocialTransparency", () => {
  it("surfaces the provider's resolved config without issuing its own fetch", async () => {
    const getTransparency = vi
      .spyOn(SocialRestClient.prototype, "getTransparency")
      .mockResolvedValue(CONFIG);

    const { result } = renderHook(() => useSocialTransparency(), { wrapper: wrap() });

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.config).toEqual(CONFIG);
    expect(result.current.error).toBeNull();
    // The provider fetched exactly once; the hook adds no extra request.
    expect(getTransparency).toHaveBeenCalledTimes(1);
  });
});
