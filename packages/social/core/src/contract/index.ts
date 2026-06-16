// Social-graph wire types — TRANSITIONAL local stand-in for `@agora-server/contract`.
//
// The dependency arrow is **SDK → contract**: agora-server owns the social wire contract, this SDK
// depends on it (see `docs/SOCIAL.md` §8, which points at `@agora-server/contract` → `social.ts`).
// However, no published `@agora-server/contract` version ships the social surface yet (0.9.3 / 0.10.0 /
// 0.11.0 export only the secure-chat + core types). So — exactly as `secure-chat-core/src/contract`
// once did before its types published — this module holds a **byte-faithful stand-in** of the social
// types, authored from `docs/SOCIAL.md`, until the contract publishes them.
//
// Migration (one deliberate edit) once `@agora-server/contract` exports the social surface:
//   1. replace the `interface`/`type` declarations below with `export type { … } from "@agora-server/contract"`;
//   2. replace the runtime const arrays with `export { WEATHER_BANDS, BLOB_SIZE_BUCKETS, NEIGHBORHOOD_TIE_KINDS } from "@agora-server/contract"`;
//   3. keep this import path (`../contract`) stable so no call site churns.
// Until then these are the source of truth and carry TSDoc (the contract-re-export TSDoc exemption in
// CLAUDE.md §2 does NOT apply while the types are authored here).
//
// Wire conventions (owned by the contract): timestamps are ISO 8601 strings; `value`/`trend`/`brightness`
// are JSON numbers; size buckets are en-dash strings ("5–9", U+2013) matching `docs/SOCIAL.md` verbatim.

// ── Weather (GET /social/weather) ─────────────────────────────────────────────

/**
 * Bucketed label for a community's aggregate warmth, on a sky/climate scale from low to high.
 *
 * `"quiet"` is the **no-data sentinel** (`SocialWeather.value === null`, brand-new community) — render
 * as a gentle neutral, never a warning. `"stormy"` → `"sunny"` are real warmth readings low → high;
 * `"stormy"` means *low warmth* (collective distance), not danger — render it as calmly as any band.
 */
export type WeatherBand = "quiet" | "stormy" | "overcast" | "fine" | "sunny";

/** Runtime list of {@link WeatherBand} values, low → high (for iteration / validation). */
export const WEATHER_BANDS: readonly WeatherBand[] = [
  "quiet",
  "stormy",
  "overcast",
  "fine",
  "sunny",
] as const;

/**
 * The Community Weather lens: one aggregate warmth scalar for the whole project. The only place
 * friction surfaces publicly — as a dip in the collective climate, never as a per-person signal.
 */
export interface SocialWeather {
  /** Mean community warmth in `[0, 1]` (2dp), or `null` when there is no interaction data yet. */
  value: number | null;
  /** Bucketed warmth label for rendering (see {@link WeatherBand}). */
  band: WeatherBand;
  /** `value(now) − value(7d ago)` (3dp): positive = warming, negative = cooling. `null` = insufficient history. */
  trend: number | null;
  /** ISO 8601 timestamp of the server-computed reading (~1h cache). */
  asOf: string;
}

// ── Constellation (GET /social/constellation) ─────────────────────────────────

/**
 * Coarse member-count bucket for a Constellation blob. The bucket **is** the privacy protection — an
 * exact member count is never revealed. En-dash strings, matching `docs/SOCIAL.md` verbatim.
 */
export type BlobSizeBucket = "5–9" | "10–19" | "20–49" | "50–99" | "100+";

/** Runtime list of {@link BlobSizeBucket} values, small → large (for iteration / validation). */
export const BLOB_SIZE_BUCKETS: readonly BlobSizeBucket[] = [
  "5–9",
  "10–19",
  "20–49",
  "50–99",
  "100+",
] as const;

/**
 * One anonymous cluster in the Constellation: a size bucket and a warmth tint, with **no** id, name,
 * or member list. Friction never renders here — blobs are warmth-only by construction.
 */
export interface ConstellationBlob {
  /** Coarse member-count bucket (never an exact count). */
  size: BlobSizeBucket;
  /** Warmth tint on the same band scale as Weather (warmth-only — no friction). */
  warmth: WeatherBand;
}

/**
 * The Constellation lens: the anonymous *shape* of the community as cluster blobs. Materialized on a
 * slow seasonal cadence (~every 6 weeks), never per request. `asOf === null` means no snapshot exists
 * yet (new community) — render a "still forming" nebula, not an error.
 */
export interface SocialConstellation {
  /** Cluster blobs, **shuffled** — no stable order or identity across epochs. */
  blobs: ConstellationBlob[];
  /** ISO 8601 of the materialized snapshot, or `null` if not yet computed. */
  asOf: string | null;
  /** Which clustering produced this snapshot (transparency), or `null` if not yet computed. */
  method: "louvain" | "space" | null;
}

// ── Neighborhood (GET /social/neighborhood) ───────────────────────────────────

/**
 * What makes someone a Neighborhood tie. `"interaction"` ties only appear when
 * `includesInteractions` is true. A pair whose only relationship is friction never appears — friction
 * dims existing ties, it does not create them.
 */
export type NeighborhoodTieKind = "follow" | "connection" | "interaction";

/** Runtime list of {@link NeighborhoodTieKind} values (for iteration / validation). */
export const NEIGHBORHOOD_TIE_KINDS: readonly NeighborhoodTieKind[] = [
  "follow",
  "connection",
  "interaction",
] as const;

/**
 * One named tie in the caller's Neighborhood, with its **dyadic brightness** — *your* connection's
 * warmth, never the friend's global score.
 */
export interface NeighborhoodTie {
  /** The friend's profile id. */
  userId: string;
  /** The friend's username, or `null` if unset. */
  username: string | null;
  /** The friend's display name, or `null` if unset. */
  name: string | null;
  /** The friend's avatar URL, or `null` if unset. */
  avatar: string | null;
  /**
   * Dyadic brightness `B(me, them)` in `[0.15, 1.0]` (2dp). **0.15 is the floor** — `dim ≠ "bad
   * person"`. Render as visual warmth only, **never** as a number, label, or comparison.
   */
  brightness: number;
  /** What makes them a tie (follow / connection / interaction). */
  tieKinds: NeighborhoodTieKind[];
}

/**
 * The Neighborhood lens: the caller's own named ties with dyadic brightness. **Self-view only** —
 * never visible to anyone else, never cached across sign-outs or user switches.
 */
export interface SocialNeighborhood {
  /** The caller's ties, sorted brightest-first by the server. */
  ties: NeighborhoodTie[];
  /** The **effective** value of the `includeInteractions` toggle for this response. */
  includesInteractions: boolean;
  /** ISO 8601 timestamp, computed live (no server cache). */
  asOf: string;
}

// ── Transparency (GET /social/transparency) ───────────────────────────────────

/**
 * The project's resolved social config in member-safe form: which lenses are enabled, decay
 * half-lives, the Constellation k-floor, and whether interactions are included by default. Fetched at
 * app init to know which surfaces to render before showing nav entries.
 */
export interface ResolvedSocialConfig {
  /** Whether the social graph is configured at all on the server (Neo4j present). */
  graphEnabled: boolean;
  /** Whether the Weather lens is enabled for this project. */
  weatherEnabled: boolean;
  /** Whether the Neighborhood lens is enabled for this project. */
  neighborhoodEnabled: boolean;
  /** Whether the Constellation lens is enabled for this project. */
  constellationEnabled: boolean;
  /** Project default for the Neighborhood `includeInteractions` toggle (typically `false`). */
  neighborhoodIncludeInteractions: boolean;
  /** Half-life (days) of the warmth decay used in brightness/weather math (transparency). */
  warmthHalfLifeDays: number;
  /** Half-life (days) of the friction decay (transparency). */
  frictionHalfLifeDays: number;
  /** Minimum cluster size surfaced in the Constellation (clusters below this are suppressed server-side). */
  constellationKFloor: number;
}
