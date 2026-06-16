// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import {
  SocialProvider,
  SocialRestClient,
  type ResolvedSocialConfig,
  type SocialConstellation,
} from "@agora-sdk/social-core";
import { Constellation } from "./Constellation.js";

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

const SNAPSHOT: SocialConstellation = {
  blobs: [
    { size: "5–9", warmth: "fine" },
    { size: "20–49", warmth: "sunny" },
    { size: "100+", warmth: "overcast" },
    { size: "10–19", warmth: "fine" },
  ],
  asOf: "2026-05-01T00:00:00Z",
  method: "louvain",
};

const tree = () => (
  <SocialProvider projectId="p" accessToken="t">
    <Constellation width={300} height={200} />
  </SocialProvider>
);

function circlePositions(container: HTMLElement): string {
  return Array.from(container.querySelectorAll("circle"))
    .map((c) => `${c.getAttribute("cx")},${c.getAttribute("cy")}`)
    .join("|");
}

afterEach(() => vi.restoreAllMocks());

describe("<Constellation />", () => {
  it("renders a nebula (not an error) when the snapshot is still forming", async () => {
    vi.spyOn(SocialRestClient.prototype, "getTransparency").mockResolvedValue(
      config({ constellationEnabled: true })
    );
    vi.spyOn(SocialRestClient.prototype, "getConstellation").mockResolvedValue({
      blobs: [],
      asOf: null,
      method: null,
    });

    const { container } = render(tree());
    await waitFor(() =>
      expect(container.querySelector("[aria-label*='still forming']")).not.toBeNull()
    );
    expect(container.querySelectorAll("circle").length).toBe(0);
  });

  it("renders one blob circle per cluster, sized by bucket, with no exact count text", async () => {
    vi.spyOn(SocialRestClient.prototype, "getTransparency").mockResolvedValue(
      config({ constellationEnabled: true })
    );
    vi.spyOn(SocialRestClient.prototype, "getConstellation").mockResolvedValue(SNAPSHOT);

    const { container } = render(tree());
    await waitFor(() => expect(container.querySelectorAll("circle").length).toBe(4));

    // Privacy: the bucket is the only size signal — no exact count is ever drawn as text.
    expect(container.textContent ?? "").not.toMatch(/\d/);
  });

  it("re-randomizes blob positions across mounts (no stable layout)", async () => {
    vi.spyOn(SocialRestClient.prototype, "getTransparency").mockResolvedValue(
      config({ constellationEnabled: true })
    );
    vi.spyOn(SocialRestClient.prototype, "getConstellation").mockResolvedValue(SNAPSHOT);

    const first = render(tree());
    await waitFor(() => expect(first.container.querySelectorAll("circle").length).toBe(4));
    const layoutA = circlePositions(first.container);
    first.unmount();

    const second = render(tree());
    await waitFor(() => expect(second.container.querySelectorAll("circle").length).toBe(4));
    const layoutB = circlePositions(second.container);

    expect(layoutA).not.toEqual(layoutB);
  });
});
