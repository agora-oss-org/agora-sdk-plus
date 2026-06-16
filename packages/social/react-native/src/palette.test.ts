// Unit tests for the native climate palette + brightness mapping.
//
// These lock the SOCIAL.md §5/§6 invariants that must NOT drift from the web sibling: the exact band
// colors, the `[0.15, 1.0]` clamp, the `isSprout` floor at 0.24, and — critically — that the
// brightness treatment never leaks the raw brightness number into a renderable value. Pure logic, so
// no RN renderer is needed (runs under the default node env).

import { describe, it, expect } from "vitest";
import { bandPalette, bandColors, brightnessTreatment } from "./palette.js";

describe("bandPalette / bandColors", () => {
  it("pins the exact §5 band colors (must match the web palette byte-for-byte)", () => {
    expect(bandPalette).toEqual({
      quiet: { core: "#8a94a6", glow: "rgba(138, 148, 166, 0.35)" },
      stormy: { core: "#5b6b86", glow: "rgba(91, 107, 134, 0.40)" },
      overcast: { core: "#8d96a3", glow: "rgba(141, 150, 163, 0.40)" },
      fine: { core: "#e0a955", glow: "rgba(224, 169, 85, 0.55)" },
      sunny: { core: "#f4c64a", glow: "rgba(244, 198, 74, 0.70)" },
    });
  });

  it("never uses red for any band (low warmth is never an alarm)", () => {
    for (const { core } of Object.values(bandPalette)) {
      const [r, g] = [core.slice(1, 3), core.slice(3, 5)].map((h) => parseInt(h, 16));
      // A danger-red hue has green collapse toward zero (g << r). Every band here is amber/gold/slate,
      // where green stays substantial — so green is always a healthy fraction of red, never near 0.
      expect(g).toBeGreaterThanOrEqual(r * 0.5);
    }
  });

  it("fails soft to quiet for an unknown band", () => {
    expect(bandColors("nonsense" as never)).toEqual(bandPalette.quiet);
    expect(bandColors("sunny")).toEqual(bandPalette.sunny);
  });
});

describe("brightnessTreatment", () => {
  it("clamps the floor: values below 0.15 are treated as 0.15 (a sprout)", () => {
    expect(brightnessTreatment(0)).toEqual(brightnessTreatment(0.15));
    expect(brightnessTreatment(0.15).isSprout).toBe(true);
  });

  it("clamps the ceiling: values above 1.0 are treated as 1.0", () => {
    expect(brightnessTreatment(5)).toEqual(brightnessTreatment(1));
  });

  it("marks the sprout band at and below the 0.24 floor, but not above it", () => {
    expect(brightnessTreatment(0.24).isSprout).toBe(true);
    expect(brightnessTreatment(0.2401).isSprout).toBe(false);
    expect(brightnessTreatment(1).isSprout).toBe(false);
  });

  it("grows the glow and scale monotonically with brightness", () => {
    const low = brightnessTreatment(0.2);
    const high = brightnessTreatment(1);
    expect(high.shadowRadius).toBeGreaterThan(low.shadowRadius);
    expect(high.shadowOpacity).toBeGreaterThan(low.shadowOpacity);
    expect(high.elevation).toBeGreaterThan(low.elevation);
    expect(high.scale).toBeGreaterThan(low.scale);
  });

  it("returns only visual-weight props — never the raw brightness number or a count", () => {
    const t = brightnessTreatment(0.73);
    expect(Object.keys(t).sort()).toEqual(
      ["elevation", "isSprout", "scale", "shadowOpacity", "shadowRadius"].sort()
    );
    // The input brightness (0.73) must not appear verbatim in any returned value.
    expect(Object.values(t)).not.toContain(0.73);
  });
});
