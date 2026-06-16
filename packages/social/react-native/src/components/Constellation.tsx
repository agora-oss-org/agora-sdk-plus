// <Constellation /> — the anonymous community "shape" as a field of warm, glowing blobs (React Native).
//
// Native port of the web component, drawn with react-native-svg. The privacy rules from SOCIAL.md §6
// are enforced structurally, identically to web:
//   • No stable layout — positions are re-randomized on every mount / whenever the blob data changes
//     (see `computePositions` in ../layout), so no cluster has a "home" a viewer could track.
//   • Size by BUCKET, never an exact count — radius comes from a fixed bucket→px map.
//   • Warmth-only tint — blobs use the same calm climate palette as Weather; friction never renders.
//   • `asOf === null` is the valid "still forming" state — a wispy nebula, not an error or empty list.
//
// Each blob is an SVG <Circle> filled by a per-band radial gradient that fades to transparent at the
// edge, giving the soft "glow" look without an SVG blur filter (feGaussianBlur is not reliably
// supported on react-native-svg across platforms).

import React, { useEffect, useMemo, useState } from "react";
import Svg, { Defs, RadialGradient, Stop, Circle, Rect } from "react-native-svg";
import { useSocialConstellation } from "@agora-sdk/social-core";
import { bandColors } from "../palette.js";
import { computePositions, type BlobNode } from "../layout.js";

/** Props for {@link Constellation}. */
export interface ConstellationProps {
  /** Canvas width in px. Defaults to 360. */
  width?: number;
  /** Canvas height in px. Defaults to 240. */
  height?: number;
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
}: ConstellationProps): React.ReactElement | null {
  const { constellation } = useSocialConstellation();
  // react-native-svg references gradients by id; strip the colons React.useId emits so `url(#id)` is valid.
  const gid = `cn-${React.useId().replace(/:/g, "")}`;

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

  // One gradient per band actually present — referenced by the circles below.
  const bandsPresent = useMemo(
    () => Array.from(new Set((blobs ?? []).map((b) => b.warmth))),
    [blobs]
  );

  if (!constellation) return null;

  // Still-forming: a gentle nebula, never an error or empty state.
  if (constellation.asOf === null) {
    return (
      <Svg width={width} height={height} accessibilityRole="image" accessibilityLabel="Community constellation: still forming">
        <Defs>
          <RadialGradient id={`${gid}-nebula`} cx="50%" cy="50%" r="60%">
            <Stop offset="0%" stopColor="#8a94a6" stopOpacity={0.3} />
            <Stop offset="100%" stopColor="#8a94a6" stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x={0} y={0} width={width} height={height} fill={`url(#${gid}-nebula)`} />
      </Svg>
    );
  }

  return (
    <Svg width={width} height={height} accessibilityRole="image" accessibilityLabel="Community constellation">
      <Defs>
        {bandsPresent.map((band) => {
          const colors = bandColors(band);
          return (
            <RadialGradient key={band} id={`${gid}-${band}`} cx="50%" cy="50%" r="50%">
              <Stop offset="0%" stopColor={colors.core} stopOpacity={0.9} />
              <Stop offset="100%" stopColor={colors.core} stopOpacity={0} />
            </RadialGradient>
          );
        })}
      </Defs>
      {nodes.map((n, i) => (
        <Circle key={i} cx={n.x} cy={n.y} r={n.r} fill={`url(#${gid}-${n.warmth})`} />
      ))}
    </Svg>
  );
}
