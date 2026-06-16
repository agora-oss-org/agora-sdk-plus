// <SocialTransparency /> — an opt-in "how it works" disclosure for the social graph (React Native).
//
// Native port of the web component. Reads the resolved config from the provider (no extra request) and
// renders a plain-language summary of which lenses are on and the factors that shape them (decay
// half-lives, the Constellation k-floor). This is the member-facing transparency surface (SOCIAL.md §4):
// the graph is a commons, so how it works is shown openly. Returns `null` until config resolves.

import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { useSocialTransparency } from "@agora-sdk/social-core";

/** Props for {@link SocialTransparency}. */
export interface SocialTransparencyProps {
  /** Optional style for the root element. */
  style?: object;
}

/** One labeled row in the disclosure panel. */
function Row({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
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
  style,
}: SocialTransparencyProps): React.ReactElement | null {
  const { config } = useSocialTransparency();
  if (!config) return null;

  const lenses = [
    config.weatherEnabled && "Weather",
    config.constellationEnabled && "Constellation",
    config.neighborhoodEnabled && "Neighborhood",
  ].filter(Boolean) as string[];

  return (
    <View style={style} accessibilityLabel="How the social graph works">
      <Text style={styles.heading}>How your community graph works</Text>
      <Row label="Active lenses" value={lenses.length ? lenses.join(", ") : "None"} />
      <Row label="Warmth memory" value={`~${config.warmthHalfLifeDays}-day half-life`} />
      <Row label="Friction memory" value={`~${config.frictionHalfLifeDays}-day half-life`} />
      <Row label="Smallest visible cluster" value={`${config.constellationKFloor}+ members`} />
      <Row
        label="Neighborhood includes interactions"
        value={config.neighborhoodIncludeInteractions ? "By default" : "Only if you opt in"}
      />
      <Text style={styles.footnote}>
        Warmth fades gently over time, so the graph reflects how things are now — not a permanent score.
        Clusters smaller than the floor are never shown. Your Neighborhood is yours alone.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: 14, fontWeight: "600", marginBottom: 8 },
  row: { flexDirection: "row", justifyContent: "space-between", gap: 16, paddingVertical: 4 },
  rowLabel: { fontSize: 13, color: "#9ca3af" },
  rowValue: { fontSize: 13, fontWeight: "600" },
  footnote: { fontSize: 12, color: "#9ca3af", marginTop: 10, lineHeight: 18 },
});
