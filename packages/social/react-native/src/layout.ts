// Constellation layout — the d3-force blob placement, shared verbatim with the web sibling.
//
// d3-force is pure JS (no DOM), so the exact same synchronous force pass the web `<Constellation />`
// uses ports to native untouched. The SOCIAL.md §6 privacy rules are baked in here:
//   • Size by BUCKET, never an exact count — radius comes from a fixed bucket→px map.
//   • No stable layout — positions are seeded with a fresh `Math.random()` every call, so no cluster
//     has a "home" a viewer could track across mounts. `Math.random()` is layout-only (no security
//     relevance); the simulation then resolves overlaps with collision + center gravity.
//
// No `react-native` import here on purpose: this stays pure logic so it unit-tests under plain vitest.

import {
  forceCenter,
  forceCollide,
  forceSimulation,
  type SimulationNodeDatum,
} from "d3-force";
import type { BlobSizeBucket, ConstellationBlob, WeatherBand } from "@agora-sdk/social-core";

/**
 * Fixed bucket → blob radius (px). Deliberately coarse: the bucket IS the privacy protection, so the
 * visual never encodes more precision than the bucket itself (SOCIAL.md §6).
 */
export const BUCKET_RADIUS: Record<BlobSizeBucket, number> = {
  "5–9": 20,
  "10–19": 28,
  "20–49": 38,
  "50–99": 50,
  "100+": 65,
};

/** A blob with a force-resolved position. d3-force mutates `x`/`y` in place during simulation. */
export interface BlobNode extends SimulationNodeDatum {
  /** Blob radius in px (from {@link BUCKET_RADIUS}). */
  r: number;
  /** Warmth band that tints the blob. */
  warmth: WeatherBand;
}

/**
 * Lay out blobs with fresh random positions resolved by a synchronous force pass. Re-randomization is
 * a privacy requirement, so this runs from scratch each time it is called — never memoized to a stable
 * layout. Uses `Math.random()` only for visual placement (no security relevance).
 *
 * @param blobs - The constellation blobs to place.
 * @param width - Canvas width in px.
 * @param height - Canvas height in px.
 * @returns One {@link BlobNode} per blob, with settled, non-overlapping `x`/`y`.
 */
export function computePositions(
  blobs: ConstellationBlob[],
  width: number,
  height: number
): BlobNode[] {
  const nodes: BlobNode[] = blobs.map((b) => ({
    r: BUCKET_RADIUS[b.size] ?? 28,
    warmth: b.warmth,
    // Random seed placement near the center; the simulation spreads them without overlap.
    x: width / 2 + (Math.random() - 0.5) * width * 0.6,
    y: height / 2 + (Math.random() - 0.5) * height * 0.6,
  }));

  // Build a simulation, immediately stop its internal timer, and tick it synchronously so we get a
  // settled, non-overlapping layout in one render with no animation loop or async state.
  const simulation = forceSimulation(nodes)
    .force("collide", forceCollide<BlobNode>((d) => d.r + 8))
    .force("center", forceCenter(width / 2, height / 2))
    .stop();
  simulation.tick(300);

  return nodes;
}
