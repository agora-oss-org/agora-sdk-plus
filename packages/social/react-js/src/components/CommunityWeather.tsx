// <CommunityWeather /> — the Weather lens as an ambient climate indicator.
//
// Renders the aggregate community warmth as a calm sky/climate chip (SOCIAL.md §5): a band-tinted
// orb with a soft glow, an optional subtle trend cue (warming/cooling — never alarming text), and a
// "still forming" treatment for the `quiet` no-data sentinel. The raw `value` number is NEVER shown —
// warmth is communicated only as color/glow. Returns `null` when the lens is disabled or still loading,
// so a host can drop it in unconditionally and have it disappear when off.

import React from "react";
import { useSocialWeather } from "@agora-sdk/social-core";
import { bandColors } from "../palette.js";

/** Props for {@link CommunityWeather}. */
export interface CommunityWeatherProps {
  /** Optional class for the root element (for host-app layout/spacing). */
  className?: string;
}

/** Human-readable, non-alarming captions per band. `stormy` stays gentle by design (SOCIAL.md §5). */
const BAND_CAPTION: Record<string, string> = {
  quiet: "Still forming",
  stormy: "Could use more warmth",
  overcast: "Settling in",
  fine: "Warm",
  sunny: "Glowing",
};

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
 * <SocialProvider projectId={id} accessToken={token}>
 *   <CommunityWeather />
 * </SocialProvider>
 * ```
 */
export function CommunityWeather({ className }: CommunityWeatherProps): React.ReactElement | null {
  const { weather } = useSocialWeather();
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
    <div
      className={className}
      role="img"
      aria-label={`Community weather: ${caption.toLowerCase()}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 14px",
        borderRadius: 999,
        background: "rgba(15, 15, 24, 0.04)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 22,
          height: 22,
          borderRadius: "50%",
          background: `radial-gradient(circle at 35% 30%, ${colors.core}, ${colors.glow})`,
          boxShadow: `0 0 ${forming ? 10 : 18}px ${colors.glow}`,
          filter: forming ? "blur(0.5px)" : undefined,
          opacity: forming ? 0.8 : 1,
        }}
      />
      <span style={{ fontSize: 13, color: colors.core, fontWeight: 600 }}>{caption}</span>
      {trendArrow && (
        <span
          aria-hidden
          title={weather.trend! > 0 ? "warming" : "cooling"}
          style={{ fontSize: 13, color: colors.core, opacity: 0.7 }}
        >
          {trendArrow}
        </span>
      )}
    </div>
  );
}
