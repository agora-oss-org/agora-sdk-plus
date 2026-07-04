// <CommunityWeather /> — the Weather lens as an ambient climate indicator (React Native).
//
// Native port of the web component: the aggregate community warmth as a calm sky/climate chip
// (SOCIAL.md §5) — a band-tinted orb with a soft glow, a subtle trend cue (warming/cooling, never
// alarming text), and a "still forming" treatment for the `quiet` no-data sentinel. The raw `value`
// number is NEVER shown — warmth is communicated only as color/glow. Returns `null` when the lens is
// disabled or still loading, so a host can drop it in unconditionally and have it disappear when off.
//
// The orb's radial gradient is drawn with react-native-svg (the only cross-platform way to get a soft
// gradient orb in RN); the ambient glow is an RN View shadow/elevation around it.

import React from "react";
import { View, Text, StyleSheet } from "react-native";
import Svg, { Defs, RadialGradient, Stop, Circle } from "react-native-svg";
import { useSocialWeather } from "@agora-sdk/social-core";
import { bandColors } from "../palette.js";

/** Props for {@link CommunityWeather}. */
export interface CommunityWeatherProps {
  /** Optional style for the root chip (for host-app layout/spacing). */
  style?: object;
}

/** Human-readable, non-alarming captions per band. `stormy` stays gentle by design (SOCIAL.md §5). */
const BAND_CAPTION: Record<string, string> = {
  quiet: "Still forming",
  stormy: "Could use more warmth",
  overcast: "Settling in",
  fine: "Warm",
  sunny: "Glowing",
};

const ORB = 22;

/**
 * Render the Community Weather as an ambient climate chip.
 *
 * Self-contained: reads {@link useSocialWeather} internally and gates on the feature config. Shows a
 * band-tinted glowing orb plus a soft trend arrow when history is available. The warmth `value` is
 * never displayed.
 *
 * @param props - {@link CommunityWeatherProps}.
 * @returns The weather chip, or `null` when the lens is disabled or still loading.
 *
 * @example
 * ```tsx
 * <SocialProvider projectId={id} accessToken={token} baseUrl="https://your-api.example.com/v7">
 *   <CommunityWeather />
 * </SocialProvider>
 * ```
 */
export function CommunityWeather({ style }: CommunityWeatherProps): React.ReactElement | null {
  const { weather } = useSocialWeather();
  // react-native-svg references gradients by id; strip the colons React.useId emits so `url(#id)` is valid.
  const gid = `cw-${React.useId().replace(/:/g, "")}`;
  if (!weather) return null;

  const colors = bandColors(weather.band);
  const caption = BAND_CAPTION[weather.band] ?? "Still forming";
  const forming = weather.band === "quiet" || weather.value === null;

  // Trend → a subtle directional cue, never alarming text. Tiny magnitudes are treated as steady.
  const trendArrow =
    weather.trend === null || Math.abs(weather.trend) < 0.005
      ? null
      : weather.trend > 0
        ? "↗"
        : "↘";

  return (
    <View style={[styles.chip, style]} accessibilityRole="image" accessibilityLabel={`Community weather: ${caption.toLowerCase()}`}>
      <View
        style={[
          styles.orbWrap,
          {
            shadowColor: colors.glow,
            shadowRadius: forming ? 10 : 18,
            elevation: forming ? 4 : 8,
            opacity: forming ? 0.8 : 1,
          },
        ]}
      >
        <Svg width={ORB} height={ORB}>
          <Defs>
            {/* Offset focal point (35%/30%) gives the orb a soft top-left highlight, matching web. */}
            <RadialGradient id={gid} cx="35%" cy="30%" r="70%">
              <Stop offset="0%" stopColor={colors.core} stopOpacity={1} />
              <Stop offset="100%" stopColor={colors.core} stopOpacity={0.2} />
            </RadialGradient>
          </Defs>
          <Circle cx={ORB / 2} cy={ORB / 2} r={ORB / 2} fill={`url(#${gid})`} />
        </Svg>
      </View>
      <Text style={[styles.caption, { color: colors.core }]}>{caption}</Text>
      {trendArrow && (
        <Text style={[styles.trend, { color: colors.core }]} accessibilityElementsHidden>
          {trendArrow}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: "rgba(15, 15, 24, 0.04)",
  },
  // iOS shadow needs a non-transparent shadowOpacity; the color already carries its own alpha.
  orbWrap: {
    width: ORB,
    height: ORB,
    shadowOpacity: 1,
    shadowOffset: { width: 0, height: 0 },
  },
  caption: { fontSize: 13, fontWeight: "600" },
  trend: { fontSize: 13, opacity: 0.7 },
});
