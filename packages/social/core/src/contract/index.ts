// Social-graph wire types — re-exported from the published `@agora-server/contract` (Apache-2.0).
//
// The dependency arrow is **SDK → contract**: agora-server owns the social wire contract, this SDK
// depends on it. As of `@agora-server/contract@0.12.1` the social surface is published, so this module
// is a thin **type-only re-export** (one source of truth, zero drift) — it replaces the earlier local
// byte-faithful stand-in that stood in until the contract shipped these types.
//
// Type-only on purpose: `@agora-server/contract` is ESM-only, but `export type` re-exports are erased
// from the emitted JS, so core's dual ESM/CJS build never `require()`s it at runtime (mirrors
// `secure-chat-core/src/contract`). For the SAME reason the three runtime const arrays are re-declared
// **locally** rather than value-re-exported — a value re-export would force the CJS build to
// `require()` the ESM-only contract. They are typed against the contract's unions, so any drift in the
// bands/buckets/tie-kinds becomes a compile error here.
//
// Scope: only the three member-facing lenses (Weather, Constellation, Neighborhood) + the resolved
// config the SDK consumes. The contract's corporate-analytics surface (influence / silos / engagement,
// read-receipts) is intentionally NOT re-exported — it is outside this package's scope.
//
// Wire conventions (owned by the contract): timestamps are ISO 8601 strings; `value`/`trend`/
// `brightness` are JSON numbers; size buckets are en-dash strings ("5–9", U+2013).

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
  SocialPrivacyTier,
} from "@agora-server/contract";

import type { WeatherBand, BlobSizeBucket, NeighborhoodTieKind } from "@agora-server/contract";

/**
 * Runtime list of {@link WeatherBand} values, low → high (for iteration / validation). Mirrors the
 * contract's `WEATHER_BANDS`; re-declared locally so core's CJS build need not `require()` the
 * ESM-only contract. Typed against the contract union, so any drift is a compile error.
 */
export const WEATHER_BANDS: readonly WeatherBand[] = [
  "quiet",
  "stormy",
  "overcast",
  "fine",
  "sunny",
];

/**
 * Runtime list of {@link BlobSizeBucket} values, small → large (for iteration / validation). Mirrors
 * the contract's `BLOB_SIZE_BUCKETS` (en-dash strings); re-declared locally for the CJS-build reason
 * above.
 */
export const BLOB_SIZE_BUCKETS: readonly BlobSizeBucket[] = [
  "5–9",
  "10–19",
  "20–49",
  "50–99",
  "100+",
];

/**
 * Runtime list of {@link NeighborhoodTieKind} values (for iteration / validation). Mirrors the
 * contract's `NEIGHBORHOOD_TIE_KINDS`; re-declared locally for the CJS-build reason above.
 */
export const NEIGHBORHOOD_TIE_KINDS: readonly NeighborhoodTieKind[] = [
  "follow",
  "connection",
  "interaction",
];
