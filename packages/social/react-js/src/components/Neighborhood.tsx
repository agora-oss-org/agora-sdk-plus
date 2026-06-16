// <Neighborhood /> — the caller's own named ties, lit by dyadic brightness.
//
// Renders the self-view tie list (brightest-first, as the server sorts it). Brightness drives a glow
// treatment ONLY — the number is never shown, labeled, or compared between ties (SOCIAL.md §6). Ties at
// the floor band render as a warm "sprout" (hopeful/new), not a grey absence. An optional toggle wires
// the `includeInteractions` switch. Returns `null` when the lens is disabled or still loading.
//
// Privacy note: the underlying hook keeps ties in component state only and clears them on a user/project
// switch — this component adds no cache of its own, so the self-view never lingers across sign-outs.

import React from "react";
import { useSocialNeighborhood } from "@agora-sdk/social-core";
import type { NeighborhoodTie, NeighborhoodTieKind } from "@agora-sdk/social-core";
import { brightnessTreatment } from "../palette.js";

/** Props for {@link Neighborhood}. */
export interface NeighborhoodProps {
  /** Render the "include interactions" toggle (wires to the hook's setter). Defaults to `false`. */
  showInteractionsToggle?: boolean;
  /** Optional class for the root element. */
  className?: string;
}

/** Subtle glyphs for the tie-kind chips. Hints, not labels. */
const TIE_KIND_GLYPH: Record<NeighborhoodTieKind, string> = {
  follow: "→",
  connection: "↔",
  interaction: "·",
};

/** Best available display label for a tie, falling back gracefully when fields are null. */
function displayName(tie: NeighborhoodTie): string {
  return tie.name ?? tie.username ?? "Someone";
}

/** First glyph for the avatar fallback. */
function initial(tie: NeighborhoodTie): string {
  const label = displayName(tie);
  return label.charAt(0).toUpperCase();
}

/** One tie card — avatar (or initial) + name + tie-kind chips, lit by brightness glow. */
function TieCard({ tie }: { tie: NeighborhoodTie }): React.ReactElement {
  const t = brightnessTreatment(tie.brightness);
  // Sprout ties get a warm amber halo (hopeful/new); brighter ties get a golden glow. Never grey.
  const glowColor = t.isSprout ? "rgba(224, 169, 85, " : "rgba(244, 198, 74, ";
  const shadow = `0 0 ${t.glowRadius}px ${glowColor}${t.glowOpacity})`;

  return (
    <li
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "8px 4px",
        listStyle: "none",
      }}
    >
      <div
        aria-hidden
        style={{
          width: 40,
          height: 40,
          borderRadius: "50%",
          transform: `scale(${t.scale})`,
          boxShadow: shadow,
          background: tie.avatar
            ? `center / cover no-repeat url(${tie.avatar})`
            : "linear-gradient(135deg, #e0a955, #f4c64a)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#1b1b24",
          fontWeight: 700,
          fontSize: 16,
        }}
      >
        {tie.avatar ? "" : initial(tie)}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{displayName(tie)}</span>
        <span style={{ display: "flex", gap: 6, fontSize: 11, color: "#9ca3af" }}>
          {tie.tieKinds.map((kind) => (
            <span key={kind} title={kind} aria-label={kind}>
              {TIE_KIND_GLYPH[kind]} {kind}
            </span>
          ))}
        </span>
      </div>
    </li>
  );
}

/**
 * Render the caller's Neighborhood — their named ties, lit by dyadic brightness.
 *
 * Self-contained: reads {@link useSocialNeighborhood} and gates on the feature config. Ties render in
 * the server's brightest-first order; brightness becomes glow/scale, never a number. Optionally shows
 * the interactions toggle.
 *
 * @param props - {@link NeighborhoodProps}.
 * @returns The tie list, or `null` when the lens is disabled or still loading.
 *
 * @example
 * ```tsx
 * <Neighborhood showInteractionsToggle />
 * ```
 */
export function Neighborhood({
  showInteractionsToggle = false,
  className,
}: NeighborhoodProps): React.ReactElement | null {
  const { neighborhood, includeInteractions, setIncludeInteractions } = useSocialNeighborhood();
  if (!neighborhood) return null;

  return (
    <div className={className}>
      {showInteractionsToggle && (
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 8 }}>
          <input
            type="checkbox"
            checked={includeInteractions}
            onChange={(e) => setIncludeInteractions(e.target.checked)}
          />
          Include people I&rsquo;ve interacted with
        </label>
      )}
      <ul style={{ margin: 0, padding: 0 }}>
        {neighborhood.ties.map((tie) => (
          <TieCard key={tie.userId} tie={tie} />
        ))}
      </ul>
    </div>
  );
}
