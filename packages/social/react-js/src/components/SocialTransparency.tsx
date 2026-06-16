// <SocialTransparency /> — an opt-in "how it works" disclosure for the social graph.
//
// Reads the resolved config from the provider (no extra request) and renders a plain-language summary
// of which lenses are on and the factors that shape them (decay half-lives, the Constellation k-floor).
// This is the member-facing transparency surface (SOCIAL.md §4): the graph is a commons, so how it
// works is shown openly. Returns `null` until config resolves.

import React from "react";
import { useSocialTransparency } from "@agora-sdk/social-core";

/** Props for {@link SocialTransparency}. */
export interface SocialTransparencyProps {
  /** Optional class for the root element. */
  className?: string;
}

/** One labeled row in the disclosure panel. */
function Row({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 16, fontSize: 13, padding: "4px 0" }}>
      <span style={{ color: "#9ca3af" }}>{label}</span>
      <span style={{ fontWeight: 600 }}>{value}</span>
    </div>
  );
}

/**
 * Render the social-graph transparency panel.
 *
 * Self-contained: reads {@link useSocialTransparency} from the provider. Lists the enabled lenses and
 * the tuning that shapes them, in member-safe terms.
 *
 * @param props - {@link SocialTransparencyProps}.
 * @returns The disclosure panel, or `null` until the config has resolved.
 *
 * @example
 * ```tsx
 * <SocialTransparency />
 * ```
 */
export function SocialTransparency({
  className,
}: SocialTransparencyProps): React.ReactElement | null {
  const { config } = useSocialTransparency();
  if (!config) return null;

  const lenses = [
    config.weatherEnabled && "Weather",
    config.constellationEnabled && "Constellation",
    config.neighborhoodEnabled && "Neighborhood",
  ].filter(Boolean) as string[];

  return (
    <section className={className} aria-label="How the social graph works">
      <h3 style={{ fontSize: 14, margin: "0 0 8px" }}>How your community graph works</h3>
      <Row label="Active lenses" value={lenses.length ? lenses.join(", ") : "None"} />
      <Row label="Warmth memory" value={`~${config.warmthHalfLifeDays}-day half-life`} />
      <Row label="Friction memory" value={`~${config.frictionHalfLifeDays}-day half-life`} />
      <Row label="Smallest visible cluster" value={`${config.constellationKFloor}+ members`} />
      <Row
        label="Neighborhood includes interactions"
        value={config.neighborhoodIncludeInteractions ? "By default" : "Only if you opt in"}
      />
      <p style={{ fontSize: 12, color: "#9ca3af", marginTop: 10, lineHeight: 1.5 }}>
        Warmth fades gently over time, so the graph reflects how things are now — not a permanent score.
        Clusters smaller than the floor are never shown. Your Neighborhood is yours alone.
      </p>
    </section>
  );
}
