// @agora-sdk/social-core — platform-agnostic client for the Agora social graph.
//
// Typed REST transport + provider/hooks for the three member-facing lenses (Weather, Constellation,
// Neighborhood) plus the Transparency endpoint. Pure data — no crypto, no persistence, no realtime.
// Platform packages (@agora-sdk/social-react-js, etc.) re-export this and add the visual components.

// ── context / provider ──────────────────────────────────────────────────────
export { SocialProvider, useSocial, ALL_DISABLED_SOCIAL_CONFIG } from "./context/social-context.js";
export type { SocialProviderProps, SocialContextValue } from "./context/social-context.js";

// ── hooks ────────────────────────────────────────────────────────────────────
export { useSocialWeather } from "./hooks/useSocialWeather.js";
export type { UseSocialWeatherValues } from "./hooks/useSocialWeather.js";
export { useSocialConstellation } from "./hooks/useSocialConstellation.js";
export type { UseSocialConstellationValues } from "./hooks/useSocialConstellation.js";
export { useSocialNeighborhood } from "./hooks/useSocialNeighborhood.js";
export type { UseSocialNeighborhoodValues } from "./hooks/useSocialNeighborhood.js";
export { useSocialTransparency } from "./hooks/useSocialTransparency.js";
export type { UseSocialTransparencyValues } from "./hooks/useSocialTransparency.js";

// ── transport (for advanced / non-React use) ─────────────────────────────────
export { SocialRestClient, SocialApiError } from "./transport/rest.js";
export type { SocialRestConfig } from "./transport/rest.js";

// ── wire contract types + runtime const arrays (transitional — see ./contract) ──
export {
  WEATHER_BANDS,
  BLOB_SIZE_BUCKETS,
  NEIGHBORHOOD_TIE_KINDS,
} from "./contract/index.js";
export type {
  SocialWeather,
  WeatherBand,
  SocialConstellation,
  ConstellationBlob,
  BlobSizeBucket,
  SocialNeighborhood,
  NeighborhoodTie,
  NeighborhoodTieKind,
  ResolvedSocialConfig,
} from "./contract/index.js";
