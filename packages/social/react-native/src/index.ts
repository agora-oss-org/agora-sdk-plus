// @agora-sdk/social-react-native — bare React Native bindings for the Agora social graph.
//
// Re-exports the platform-agnostic core (provider + four feature-gated hooks + transport + wire types)
// and adds the NATIVE visual components for the three lenses plus the transparency disclosure, drawn on
// React Native primitives + react-native-svg. Use this package (not core directly) in a bare RN app so
// the components ship. The shared climate palette is exported too, so host apps can match the SDK's
// warmth vocabulary in their own chrome. The data layer is pure REST — no platform crypto involved.

export * from "@agora-sdk/social-core";

// ── components ────────────────────────────────────────────────────────────────
export { CommunityWeather } from "./components/CommunityWeather.js";
export type { CommunityWeatherProps } from "./components/CommunityWeather.js";
export { Constellation } from "./components/Constellation.js";
export type { ConstellationProps } from "./components/Constellation.js";
export { Neighborhood } from "./components/Neighborhood.js";
export type { NeighborhoodProps } from "./components/Neighborhood.js";
export { SocialTransparency } from "./components/SocialTransparency.js";
export type { SocialTransparencyProps } from "./components/SocialTransparency.js";

// ── shared visual vocabulary (palette + brightness mapping) ───────────────────
export { bandPalette, bandColors, brightnessTreatment } from "./palette.js";
export type { BandColors, BrightnessTreatment } from "./palette.js";
