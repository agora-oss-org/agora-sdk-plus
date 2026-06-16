// Climate palette + brightness mapping — the privacy-critical visual vocabulary, in one place.
//
// Every social surface that renders warmth (Weather band, Constellation blob tint) maps through
// `bandPalette` so the rules from SOCIAL.md §5/§6 hold uniformly: a sky/climate register, and
// **never red** for low-warmth bands (red reads as danger; low warmth means "could use more
// connection", not "something is wrong"). Brightness (Neighborhood) maps to visual WEIGHT only —
// never a number — via `brightnessTreatment`, with the floor band rendered as a hopeful sprout glow
// rather than a grey absence.

import type { WeatherBand } from "@agora-sdk/social-core";

/** A band's rendering colors: a `core` fill/ink and a softer `glow` for shadows/auras. */
export interface BandColors {
  /** The primary fill or text color for this band. */
  core: string;
  /** A translucent glow/aura color (for box-shadow, radial-gradient edges). */
  glow: string;
}

/**
 * Maps each {@link WeatherBand} to its calm climate colors. Kept deliberately in the amber/slate/grey
 * register — **no red anywhere** — so low warmth never reads as an alarm (SOCIAL.md §5).
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

/** The four brightness bands from SOCIAL.md §5, as visual treatment (never exposed as a number). */
export interface BrightnessTreatment {
  /** Glow radius in px for a box-shadow / drop-shadow (higher = warmer, closer). */
  glowRadius: number;
  /** Glow opacity in `[0, 1]`. */
  glowOpacity: number;
  /** Node scale multiplier (brighter ties read slightly larger). */
  scale: number;
  /**
   * True for ties at the floor band (`[0.15, 0.24]`): render the warm, hopeful "sprout" treatment, not
   * a grey absence. New ≠ lonely ≠ deficient (SOCIAL.md §6).
   */
  isSprout: boolean;
}

/**
 * Map a dyadic `brightness` in `[0.15, 1.0]` to a visual treatment — glow, scale, and the sprout flag.
 * The brightness number itself is **never** returned for display; it is a rendering input only.
 *
 * @param brightness - Dyadic brightness in `[0.15, 1.0]` (values outside are clamped).
 * @returns The {@link BrightnessTreatment} for that tie.
 */
export function brightnessTreatment(brightness: number): BrightnessTreatment {
  const b = Math.min(1, Math.max(0.15, brightness));
  // Linear glow within the meaningful range; the floor band is special-cased as the sprout state.
  const glowRadius = 6 + Math.round(b * 22); // ~9px at floor → 28px at full glow
  const glowOpacity = 0.25 + b * 0.55; // ~0.33 at floor → 0.8 at full glow
  const scale = 0.94 + b * 0.12; // subtle: brighter ties read slightly larger
  const isSprout = b <= 0.24;
  return { glowRadius, glowOpacity, scale, isSprout };
}
