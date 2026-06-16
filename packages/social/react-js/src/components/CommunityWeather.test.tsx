// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import {
  SocialProvider,
  SocialRestClient,
  type ResolvedSocialConfig,
  type SocialWeather,
} from "@agora-sdk/social-core";
import { CommunityWeather } from "./CommunityWeather.js";

const config = (over: Partial<ResolvedSocialConfig>): ResolvedSocialConfig => ({
  graphEnabled: true,
  weatherEnabled: false,
  neighborhoodEnabled: false,
  constellationEnabled: false,
  neighborhoodIncludeInteractions: false,
  warmthHalfLifeDays: 30,
  frictionHalfLifeDays: 14,
  constellationKFloor: 5,
  ...over,
});

const tree = () => (
  <SocialProvider projectId="p" accessToken="t">
    <CommunityWeather />
  </SocialProvider>
);

afterEach(() => vi.restoreAllMocks());

describe("<CommunityWeather />", () => {
  it("renders nothing when the lens is disabled", async () => {
    vi.spyOn(SocialRestClient.prototype, "getTransparency").mockResolvedValue(
      config({ weatherEnabled: false })
    );
    const { container } = render(tree());
    await waitFor(() =>
      expect(SocialRestClient.prototype.getTransparency).toHaveBeenCalled()
    );
    expect(container.querySelector("[role='img']")).toBeNull();
  });

  it("renders a band caption and never the raw warmth value", async () => {
    vi.spyOn(SocialRestClient.prototype, "getTransparency").mockResolvedValue(
      config({ weatherEnabled: true })
    );
    const weather: SocialWeather = { value: 0.72, band: "fine", trend: 0.02, asOf: "2026-06-16T00:00:00Z" };
    vi.spyOn(SocialRestClient.prototype, "getWeather").mockResolvedValue(weather);

    const { container } = render(tree());
    await waitFor(() => expect(container.textContent).toContain("Warm"));

    // Privacy: the numeric `value` must never appear in the DOM.
    expect(container.textContent).not.toContain("0.72");
    expect(container.textContent).not.toContain("72");
  });

  it("renders the quiet/forming state for the no-data sentinel", async () => {
    vi.spyOn(SocialRestClient.prototype, "getTransparency").mockResolvedValue(
      config({ weatherEnabled: true })
    );
    vi.spyOn(SocialRestClient.prototype, "getWeather").mockResolvedValue({
      value: null,
      band: "quiet",
      trend: null,
      asOf: "2026-06-16T00:00:00Z",
    });

    const { container } = render(tree());
    await waitFor(() => expect(container.textContent).toContain("Still forming"));
  });
});
