// <Neighborhood /> — the caller's own named ties, lit by dyadic brightness (React Native).
//
// Native port of the web component. Renders the self-view tie list (brightest-first, as the server
// sorts it). Brightness drives a glow treatment ONLY — the number is never shown, labeled, or compared
// between ties (SOCIAL.md §6). Ties at the floor band render as a warm "sprout" (hopeful/new), not a
// grey absence. An optional RN Switch wires the `includeInteractions` toggle. Returns `null` when the
// lens is disabled or still loading.
//
// Privacy note: the underlying hook keeps ties in component state only and clears them on a user/project
// switch — this component adds no cache of its own, so the self-view never lingers across sign-outs.

import React from "react";
import { View, Text, Image, Switch, ScrollView, StyleSheet } from "react-native";
import Svg, { Defs, LinearGradient, Stop, Rect } from "react-native-svg";
import { useSocialNeighborhood } from "@agora-sdk/social-core";
import type { NeighborhoodTie, NeighborhoodTieKind } from "@agora-sdk/social-core";
import { brightnessTreatment } from "../palette.js";

/** Props for {@link Neighborhood}. */
export interface NeighborhoodProps {
  /** Render the "include interactions" toggle (wires to the hook's setter). Defaults to `false`. */
  showInteractionsToggle?: boolean;
  /** Optional style for the root element. */
  style?: object;
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
  return displayName(tie).charAt(0).toUpperCase();
}

/** One tie card — avatar (or initial) + name + tie-kind chips, lit by brightness glow. */
function TieCard({ tie, gradientId }: { tie: NeighborhoodTie; gradientId: string }): React.ReactElement {
  const t = brightnessTreatment(tie.brightness);
  // Sprout ties get a warm amber halo (hopeful/new); brighter ties get a golden glow. Never grey.
  // The opacity rides on shadowOpacity, so the color itself is fully opaque.
  const glowColor = t.isSprout ? "#e0a955" : "#f4c64a";

  return (
    <View style={styles.card}>
      <View
        style={[
          styles.avatar,
          {
            transform: [{ scale: t.scale }],
            shadowColor: glowColor,
            shadowRadius: t.shadowRadius,
            shadowOpacity: t.shadowOpacity,
            elevation: t.elevation,
          },
        ]}
      >
        {tie.avatar ? (
          <Image source={{ uri: tie.avatar }} style={styles.avatarImg} />
        ) : (
          <>
            {/* Warm amber→gold fallback gradient (135°), matching the web avatar fallback. */}
            <Svg width={40} height={40} style={StyleSheet.absoluteFill}>
              <Defs>
                <LinearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
                  <Stop offset="0" stopColor="#e0a955" />
                  <Stop offset="1" stopColor="#f4c64a" />
                </LinearGradient>
              </Defs>
              <Rect width={40} height={40} rx={20} fill={`url(#${gradientId})`} />
            </Svg>
            <Text style={styles.avatarInitial}>{initial(tie)}</Text>
          </>
        )}
      </View>
      <View style={styles.cardText}>
        <Text style={styles.name}>{displayName(tie)}</Text>
        <View style={styles.kinds}>
          {tie.tieKinds.map((kind) => (
            <Text key={kind} style={styles.kind} accessibilityLabel={kind}>
              {TIE_KIND_GLYPH[kind]} {kind}
            </Text>
          ))}
        </View>
      </View>
    </View>
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
  style,
}: NeighborhoodProps): React.ReactElement | null {
  const { neighborhood, includeInteractions, setIncludeInteractions } = useSocialNeighborhood();
  // Stable per-mount prefix so each tie's fallback gradient id is unique within this component instance.
  const gid = `nb-${React.useId().replace(/:/g, "")}`;
  if (!neighborhood) return null;

  return (
    <View style={style}>
      {showInteractionsToggle && (
        <View style={styles.toggleRow}>
          <Switch value={includeInteractions} onValueChange={setIncludeInteractions} />
          <Text style={styles.toggleLabel}>Include people I’ve interacted with</Text>
        </View>
      )}
      <ScrollView>
        {neighborhood.ties.map((tie, i) => (
          <TieCard key={tie.userId} tie={tie} gradientId={`${gid}-${i}`} />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  toggleRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  toggleLabel: { fontSize: 13 },
  card: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8, paddingHorizontal: 4 },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    overflow: "visible",
    alignItems: "center",
    justifyContent: "center",
    shadowOffset: { width: 0, height: 0 },
    backgroundColor: "#e0a955", // base tint behind the SVG/Image so the glow never reads grey
  },
  avatarImg: { width: 40, height: 40, borderRadius: 20 },
  avatarInitial: { color: "#1b1b24", fontWeight: "700", fontSize: 16 },
  cardText: { flexDirection: "column", gap: 2 },
  name: { fontSize: 14, fontWeight: "600" },
  kinds: { flexDirection: "row", gap: 6 },
  kind: { fontSize: 11, color: "#9ca3af" },
});
