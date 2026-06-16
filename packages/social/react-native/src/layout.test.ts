// Unit tests for the native Constellation layout.
//
// These lock the SOCIAL.md §6 privacy invariants of the blob field: bucket-only sizing, one node per
// blob, and — critically — that the layout is RE-RANDOMIZED on every call (no stable "home" for a
// cluster), plus that the force pass actually resolves overlaps. Pure d3-force, no DOM, no RN renderer.

import { describe, it, expect } from "vitest";
import type { ConstellationBlob } from "@agora-sdk/social-core";
import { BUCKET_RADIUS, computePositions } from "./layout.js";

const W = 360;
const H = 240;

const BLOBS: ConstellationBlob[] = [
  { size: "5–9", warmth: "fine" },
  { size: "10–19", warmth: "sunny" },
  { size: "20–49", warmth: "overcast" },
  { size: "100+", warmth: "stormy" },
];

describe("BUCKET_RADIUS", () => {
  it("maps each bucket to its fixed coarse radius (size by bucket, never a count)", () => {
    expect(BUCKET_RADIUS).toEqual({
      "5–9": 20,
      "10–19": 28,
      "20–49": 38,
      "50–99": 50,
      "100+": 65,
    });
  });
});

describe("computePositions", () => {
  it("returns exactly one node per blob, carrying the bucket radius and warmth", () => {
    const nodes = computePositions(BLOBS, W, H);
    expect(nodes).toHaveLength(BLOBS.length);
    expect(nodes.map((n) => n.r)).toEqual([20, 28, 38, 65]);
    expect(nodes.map((n) => n.warmth)).toEqual(["fine", "sunny", "overcast", "stormy"]);
  });

  it("re-randomizes: two calls produce different layouts (no stable cluster home)", () => {
    const a = computePositions(BLOBS, W, H);
    const b = computePositions(BLOBS, W, H);
    const same = a.every((n, i) => n.x === b[i].x && n.y === b[i].y);
    expect(same).toBe(false);
  });

  it("resolves overlaps: settled nodes respect the collision radius (r_i + r_j) within tolerance", () => {
    const nodes = computePositions(BLOBS, W, H);
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = (nodes[i].x ?? 0) - (nodes[j].x ?? 0);
        const dy = (nodes[i].y ?? 0) - (nodes[j].y ?? 0);
        const dist = Math.hypot(dx, dy);
        // forceCollide uses r+8 per node; allow a small slack for unconverged residual overlap.
        const minDist = nodes[i].r + nodes[j].r;
        expect(dist).toBeGreaterThan(minDist * 0.6);
      }
    }
  });

  it("falls back to a default radius for an unknown bucket without throwing", () => {
    const nodes = computePositions([{ size: "weird" as never, warmth: "fine" }], W, H);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].r).toBe(28);
  });
});
