// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { SocialProvider, useSocial, ALL_DISABLED_SOCIAL_CONFIG } from "../context/social-context.js";
import { useSocialWeather } from "./useSocialWeather.js";
import { SocialRestClient, SocialApiError } from "../transport/rest.js";
import type { ResolvedSocialConfig, SocialWeather } from "../contract/index.js";

const config = (over: Partial<ResolvedSocialConfig>): ResolvedSocialConfig => ({
  ...ALL_DISABLED_SOCIAL_CONFIG,
  graphEnabled: true,
  warmthHalfLifeDays: 30,
  frictionHalfLifeDays: 14,
  constellationKFloor: 5,
  ...over,
});

const WEATHER: SocialWeather = { value: 0.7, band: "fine", trend: 0.02, asOf: "2026-06-16T00:00:00Z" };

const wrap = () =>
  ({ children }: { children: React.ReactNode }) => (
    <SocialProvider projectId="p" baseUrl="http://localhost:4000/v7" accessToken="t">
      {children}
    </SocialProvider>
  );

afterEach(() => vi.restoreAllMocks());

describe("useSocialWeather", () => {
  it("returns null and never fetches when the lens is disabled", async () => {
    vi.spyOn(SocialRestClient.prototype, "getTransparency").mockResolvedValue(
      config({ weatherEnabled: false })
    );
    const getWeather = vi.spyOn(SocialRestClient.prototype, "getWeather").mockResolvedValue(WEATHER);

    const { result } = renderHook(() => ({ w: useSocialWeather(), s: useSocial() }), {
      wrapper: wrap(),
    });
    await waitFor(() => expect(result.current.s.configLoading).toBe(false));

    expect(result.current.w.weather).toBeNull();
    expect(getWeather).not.toHaveBeenCalled();
  });

  it("fetches and exposes the reading when enabled", async () => {
    vi.spyOn(SocialRestClient.prototype, "getTransparency").mockResolvedValue(
      config({ weatherEnabled: true })
    );
    vi.spyOn(SocialRestClient.prototype, "getWeather").mockResolvedValue(WEATHER);

    const { result } = renderHook(() => useSocialWeather(), { wrapper: wrap() });
    await waitFor(() => expect(result.current.weather).toEqual(WEATHER));
  });

  it("captures fetch errors and leaves weather null", async () => {
    vi.spyOn(SocialRestClient.prototype, "getTransparency").mockResolvedValue(
      config({ weatherEnabled: true })
    );
    vi.spyOn(SocialRestClient.prototype, "getWeather").mockRejectedValue(new Error("boom"));

    const { result } = renderHook(() => useSocialWeather(), { wrapper: wrap() });
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
    expect(result.current.weather).toBeNull();
  });

  it("fails soft on a degradation error (lens disabled mid-session): hides, no error", async () => {
    vi.spyOn(SocialRestClient.prototype, "getTransparency").mockResolvedValue(
      config({ weatherEnabled: true })
    );
    vi.spyOn(SocialRestClient.prototype, "getWeather").mockRejectedValue(
      new SocialApiError("disabled", 400, "social/weather-disabled")
    );

    const { result } = renderHook(() => useSocialWeather(), { wrapper: wrap() });
    await waitFor(() => expect(SocialRestClient.prototype.getWeather).toHaveBeenCalled());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.weather).toBeNull();
    expect(result.current.error).toBeNull();
  });
});
