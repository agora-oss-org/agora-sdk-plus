// Climate palette + brightness mapping for native — the privacy-critical visual vocabulary.
//
// This is the React Native PORT of the web sibling (`@agora-sdk/social-react-js`'s `palette.ts`). It
// keeps the SAME SOCIAL.md §5 band colors and the SAME §6 brightness thresholds (the `isSprout`
// floor at 0.24, the `[0.15, 1.0]` clamp) — those are privacy-critical and must not drift between
// platforms — but `brightnessTreatment` returns RN shadow/elevation props instead of values tuned for
// a CSS `box-shadow` string. The rule still holds on every surface: a sky/climate register, **never
// red** for low warmth, and the floor band rendered as a hopeful sprout glow, never a grey absence.
//
// No `react-native` import here on purpose: this module is pure logic so it unit-tests under plain
// vitest (node env) without an RN renderer.

import type { WeatherBand } from "@agora-sdk/social-core";

/** A band's rendering colors: a `core` fill/ink and a softer `glow` for shadows/auras. */
export interface BandColors {
  /** The primary fill or text color for this band. */
  core: string;
  /** A translucent glow/aura color (for shadows, radial-gradient edges). */
  glow: string;
}

/**
 * Maps each {@link WeatherBand} to its calm climate colors. Kept deliberately in the amber/slate/grey
 * register — **no red anywhere** — so low warmth never reads as an alarm (SOCIAL.md §5). These are the
 * exact same hex/rgba constants as the web palette, so a native and a web client tint warmth identically.
 *
 * - `quiet` — soft grey-blue, "still forming" (the no-data sentinel)
 * - `stormy` — muted slate-blue (low warmth, NOT danger)
 * - `overcast` — cool grey (below average)
 * - `fine` — warm amber-gold (above average)
 * - `sunny` — bright golden-yellow (high warmth)
 */
export const bandPalette: Record<WeatherBand, BandColors> = {
  quiet: { core: "#8a94a6", glow: "rgba(138, 148, 166, 0.35)" },
  stormy: { core: "#5b6b86", glow: "rgba(91, 107, 134, 0.40)" },
  overcast: { core: "#8d96a3", glow: "rgba(141, 150, 163, 0.40)" },
  fine: { core: "#e0a955", glow: "rgba(224, 169, 85, 0.55)" },
  sunny: { core: "#f4c64a", glow: "rgba(244, 198, 74, 0.70)" },
};

/**
 * Resolve the climate colors for a band, defaulting to `quiet` for any unexpected value (fail-soft to
 * the neutral "forming" look rather than throwing on malformed server data).
 *
 * @param band - The weather/warmth band to color.
 * @returns The {@link BandColors} for that band.
 */
export function bandColors(band: WeatherBand): BandColors {
  return bandPalette[band] ?? bandPalette.quiet;
}

/**
 * A tie's brightness expressed as React Native visual WEIGHT — shadow glow, elevation, and scale —
 * never as a number. The shadow *color* is chosen by the component (amber for sprouts, golden
 * otherwise); this carries only the magnitude props plus the sprout flag.
 */
export interface BrightnessTreatment {
  /** iOS `shadowRadius` in px (higher = warmer, closer). */
  shadowRadius: number;
  /** iOS `shadowOpacity` in `[0, 1]`. */
  shadowOpacity: number;
  /** Android `elevation` (a coarse glow proxy, since Android has no tunable shadow blur). */
  elevation: number;
  /** Node scale multiplier (brighter ties read slightly larger). */
  scale: number;
  /**
   * True for ties at the floor band (`[0.15, 0.24]`): render the warm, hopeful "sprout" treatment, not
   * a grey absence. New ≠ lonely ≠ deficient (SOCIAL.md §6).
   */
  isSprout: boolean;
}

/**
 * Map a dyadic `brightness` in `[0.15, 1.0]` to an RN visual treatment — shadow glow, elevation, scale,
 * and the sprout flag. The brightness number itself is **never** returned for display; it is a rendering
 * input only. The clamp floor and the `isSprout` threshold are identical to the web palette so the
 * privacy semantics never diverge across platforms.
 *
 * @param brightness - Dyadic brightness in `[0.15, 1.0]` (values outside are clamped).
 * @returns The {@link BrightnessTreatment} for that tie.
 */
export function brightnessTreatment(brightness: number): BrightnessTreatment {
  const b = Math.min(1, Math.max(0.15, brightness));
  // Same curve as the web sibling: a linear glow within the meaningful range, with the floor band
  // special-cased as the sprout state. Mapped onto RN shadow/elevation props instead of a box-shadow.
  const shadowRadius = 6 + Math.round(b * 22); // ~9px at floor → 28px at full glow
  const shadowOpacity = 0.25 + b * 0.55; // ~0.33 at floor → 0.8 at full glow
  const elevation = 2 + Math.round(b * 10); // Android proxy: ~4 at floor → 12 at full glow
  const scale = 0.94 + b * 0.12; // subtle: brighter ties read slightly larger
  const isSprout = b <= 0.24;
  return { shadowRadius, shadowOpacity, elevation, scale, isSprout };
}
