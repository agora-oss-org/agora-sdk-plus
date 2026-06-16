// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import {
  SocialProvider,
  SocialRestClient,
  ALL_DISABLED_SOCIAL_CONFIG,
  type ResolvedSocialConfig,
  type SocialNeighborhood,
} from "@agora-sdk/social-core";
import { Neighborhood } from "./Neighborhood.js";

const config = (over: Partial<ResolvedSocialConfig>): ResolvedSocialConfig => ({
  ...ALL_DISABLED_SOCIAL_CONFIG,
  graphEnabled: true,
  warmthHalfLifeDays: 30,
  frictionHalfLifeDays: 14,
  constellationKFloor: 5,
  ...over,
});

const NEIGHBORHOOD: SocialNeighborhood = {
  ties: [
    { userId: "u1", username: "ada", name: "Ada", avatar: null, brightness: 0.92, tieKinds: ["connection"] },
    { userId: "u2", username: "bren", name: null, avatar: null, brightness: 0.18, tieKinds: ["follow"] },
  ],
  includesInteractions: false,
  asOf: "2026-06-16T00:00:00Z",
};

const tree = () => (
  <SocialProvider projectId="p" accessToken="t">
    <Neighborhood />
  </SocialProvider>
);

afterEach(() => vi.restoreAllMocks());

describe("<Neighborhood />", () => {
  it("renders nothing when the lens is disabled", async () => {
    vi.spyOn(SocialRestClient.prototype, "getTransparency").mockResolvedValue(
      config({ neighborhoodEnabled: false })
    );
    const { container } = render(tree());
    await waitFor(() =>
      expect(SocialRestClient.prototype.getTransparency).toHaveBeenCalled()
    );
    expect(container.querySelector("ul")).toBeNull();
  });

  it("renders tie names (falling back to username) and never a brightness number", async () => {
    vi.spyOn(SocialRestClient.prototype, "getTransparency").mockResolvedValue(
      config({ neighborhoodEnabled: true })
    );
    vi.spyOn(SocialRestClient.prototype, "getNeighborhood").mockResolvedValue(NEIGHBORHOOD);

    const { container } = render(tree());
    await waitFor(() => expect(container.querySelectorAll("li").length).toBe(2));

    expect(container.textContent).toContain("Ada"); // name
    expect(container.textContent).toContain("bren"); // username fallback (name was null)

    // Privacy: dyadic brightness values must never be rendered as text.
    expect(container.textContent).not.toContain("0.92");
    expect(container.textContent).not.toContain("0.18");
  });
});
