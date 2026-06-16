// <Constellation /> — the anonymous community "shape" as a field of warm, glowing blobs.
//
// Renders the Constellation snapshot (cluster blobs) on an SVG canvas. The privacy rules from
// SOCIAL.md §6 are enforced structurally here:
//   • No stable layout — positions are re-randomized on every mount / whenever the blob data changes,
//     so no cluster has a "home" a viewer could track across loads. We seed random (x, y) and resolve
//     overlaps with a synchronous d3-force pass (collision + center gravity).
//   • Size by BUCKET, never an exact count — radius comes from a fixed bucket→px map; no count is read
//     or shown.
//   • Warmth-only tint — blobs use the same calm climate palette as Weather; friction never renders.
//   • `asOf === null` is the valid "still forming" state — a wispy nebula, not an error or empty list.

import React, { useEffect, useId, useMemo, useState } from "react";
import {
  forceCenter,
  forceCollide,
  forceSimulation,
  type SimulationNodeDatum,
} from "d3-force";
import { useSocialConstellation } from "@agora-sdk/social-core";
import type { BlobSizeBucket, ConstellationBlob, WeatherBand } from "@agora-sdk/social-core";
import { bandColors } from "../palette.js";

/** Props for {@link Constellation}. */
export interface ConstellationProps {
  /** Canvas width in px. Defaults to 360. */
  width?: number;
  /** Canvas height in px. Defaults to 240. */
  height?: number;
  /** Optional class for the root SVG. */
  className?: string;
}

/**
 * Fixed bucket → blob radius (px). Deliberately coarse: the bucket IS the privacy protection, so the
 * visual never encodes more precision than the bucket itself (SOCIAL.md §6).
 */
const BUCKET_RADIUS: Record<BlobSizeBucket, number> = {
  "5–9": 20,
  "10–19": 28,
  "20–49": 38,
  "50–99": 50,
  "100+": 65,
};

/** A blob with a force-resolved position. d3-force mutates `x`/`y` in place during simulation. */
interface BlobNode extends SimulationNodeDatum {
  r: number;
  warmth: WeatherBand;
}

/**
 * Lay out blobs with fresh random positions resolved by a synchronous force pass. Re-randomization is
 * a privacy requirement, so this runs from scratch each time the blob set changes — never memoized to
 * a stable layout. Uses `Math.random()` only for visual placement (no security relevance).
 */
function computePositions(
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

/**
 * Render the Constellation as a randomized field of warm blobs.
 *
 * Self-contained: reads {@link useSocialConstellation} and gates on the feature config. Returns `null`
 * when disabled, a nebula when the snapshot is still forming (`asOf === null`), and otherwise a
 * re-randomized SVG blob field. Blobs are sized by bucket and tinted by warmth only.
 *
 * @param props - {@link ConstellationProps}.
 * @returns The blob canvas, a nebula, or `null`.
 *
 * @example
 * ```tsx
 * <Constellation width={420} height={280} />
 * ```
 */
export function Constellation({
  width = 360,
  height = 240,
  className,
}: ConstellationProps): React.ReactElement | null {
  const { constellation } = useSocialConstellation();
  const gradPrefix = useId();

  const blobs = constellation?.blobs ?? null;

  // Positions live in state, seeded once per blob-set and re-seeded whenever the blobs change (or the
  // canvas resizes). NOT recomputed on every render — only when the data/size actually changes — but
  // also never a *stable* layout across mounts, since each fresh mount re-runs computePositions.
  const [nodes, setNodes] = useState<BlobNode[]>(() =>
    blobs ? computePositions(blobs, width, height) : []
  );
  useEffect(() => {
    if (blobs) setNodes(computePositions(blobs, width, height));
  }, [blobs, width, height]);

  // One gradient per band actually present, plus a shared blur — referenced by the circles below.
  const bandsPresent = useMemo(
    () => Array.from(new Set((blobs ?? []).map((b) => b.warmth))),
    [blobs]
  );

  if (!constellation) return null;

  // Still-forming: a gentle nebula, never an error or empty state.
  if (constellation.asOf === null) {
    return (
      <svg
        className={className}
        width={width}
        height={height}
        role="img"
        aria-label="Community constellation: still forming"
      >
        <defs>
          <radialGradient id={`${gradPrefix}-nebula`} cx="50%" cy="50%" r="60%">
            <stop offset="0%" stopColor="rgba(138,148,166,0.30)" />
            <stop offset="100%" stopColor="rgba(138,148,166,0)" />
          </radialGradient>
          <filter id={`${gradPrefix}-nblur`}>
            <feGaussianBlur stdDeviation="10" />
          </filter>
        </defs>
        <rect
          x={0}
          y={0}
          width={width}
          height={height}
          fill={`url(#${gradPrefix}-nebula)`}
          filter={`url(#${gradPrefix}-nblur)`}
        />
      </svg>
    );
  }

  return (
    <svg
      className={className}
      width={width}
      height={height}
      role="img"
      aria-label="Community constellation"
    >
      <defs>
        {bandsPresent.map((band) => {
          const colors = bandColors(band);
          return (
            <radialGradient key={band} id={`${gradPrefix}-${band}`} cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor={colors.core} stopOpacity={0.9} />
              <stop offset="100%" stopColor={colors.core} stopOpacity={0} />
            </radialGradient>
          );
        })}
        <filter id={`${gradPrefix}-glow`}>
          <feGaussianBlur stdDeviation="4" />
        </filter>
      </defs>
      {nodes.map((n, i) => (
        <circle
          key={i}
          cx={n.x}
          cy={n.y}
          r={n.r}
          fill={`url(#${gradPrefix}-${n.warmth})`}
          filter={`url(#${gradPrefix}-glow)`}
        />
      ))}
    </svg>
  );
}
