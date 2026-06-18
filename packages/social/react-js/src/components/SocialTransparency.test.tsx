// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import {
  SocialProvider,
  SocialRestClient,
  ALL_DISABLED_SOCIAL_CONFIG,
  type ResolvedSocialConfig,
} from "@agora-sdk/social-core";
import { SocialTransparency } from "./SocialTransparency.js";

const CONFIG: ResolvedSocialConfig = {
  ...ALL_DISABLED_SOCIAL_CONFIG,
  graphEnabled: true,
  weatherEnabled: true,
  constellationEnabled: true,
  warmthHalfLifeDays: 30,
  frictionHalfLifeDays: 14,
  constellationKFloor: 5,
};

const tree = () => (
  <SocialProvider projectId="p" baseUrl="http://localhost:4000/v7" accessToken="t">
    <SocialTransparency />
  </SocialProvider>
);

afterEach(() => vi.restoreAllMocks());

describe("<SocialTransparency />", () => {
  it("lists the enabled lenses and the shaping factors", async () => {
    vi.spyOn(SocialRestClient.prototype, "getTransparency").mockResolvedValue(CONFIG);

    const { container } = render(tree());
    await waitFor(() => expect(container.textContent).toContain("How your community graph works"));

    expect(container.textContent).toContain("Weather");
    expect(container.textContent).toContain("Constellation");
    expect(container.textContent).not.toContain("Neighborhood,"); // disabled → not listed
    expect(container.textContent).toContain("30-day half-life");
    expect(container.textContent).toContain("5+ members");
  });
});
