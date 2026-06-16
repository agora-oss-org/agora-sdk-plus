// @agora-sdk/social-react-js — web (browser) bindings for the Agora social graph.
//
// Re-exports the platform-agnostic core (provider + hooks + transport + types) and adds the web visual
// components for the three lenses plus the transparency disclosure. Use this package (not core
// directly) in browser apps so the components ship. The shared climate palette is exported too, so host
// apps can match the SDK's warmth vocabulary in their own chrome.

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
