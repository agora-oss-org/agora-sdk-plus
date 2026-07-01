// Typed REST client for the Agora social graph (Weather / Constellation / Neighborhood / Transparency).
//
// Covers every endpoint in `docs/SOCIAL.md` §1–4. Base URL and access token are resolved **lazily per
// request** via caller-supplied resolvers, so a token refresh or a late-set baseUrl always wins. Every
// endpoint is path-scoped to `{baseUrl}/{projectId}/social` — the `:projectId`
// boundary is a privacy boundary (no cross-project social data; see SOCIAL.md §6).
//
// All four lenses are feature-gated server-side and degrade with specific error codes (SOCIAL.md §7).
// On any non-2xx, this client throws a typed {@link SocialApiError} carrying the HTTP `status` plus the
// server's machine `code` (e.g. `social/graph-unavailable`), so hooks/providers can hide a surface
// rather than surface a raw error to members.

import axios, { AxiosInstance } from "axios";
import {
  ResolvedSocialConfig,
  SocialConstellation,
  SocialNeighborhood,
  SocialPrivacyTier,
  SocialWeather,
} from "../contract/index.js";

/**
 * The shape `GET /social/transparency` actually puts on the wire — the server's member-facing
 * transparency DTO (`apps/api lib/social-config.ts` `transparencyView`). It is **NOT** the flat
 * {@link ResolvedSocialConfig} the hooks read: the feature flags are grouped under `garden` /
 * `analytics` / `decay`, and three resolver-only fields (`constellationKFloor`,
 * `neighborhoodIncludeInteractions`, `frictionVisibleToStewards`) are deliberately not exposed.
 * {@link transparencyToConfig} maps this into the flat config; never cast one to the other.
 */
export interface SocialTransparencyWire {
  privacyTier: string;
  analytics: {
    influenceScores: boolean;
    siloDetection: boolean;
    engagementScores: boolean;
    frictionAnalytics: boolean;
    readReceiptsAllowed: boolean;
  };
  garden: {
    graph: boolean;
    weather: boolean;
    constellation: boolean;
    neighborhood: boolean;
    readAffinity: boolean;
  };
  decay: { warmthHalfLifeDays: number; frictionHalfLifeDays: number };
}

/** Fail-closed boolean coercion: only a literal `true` is true; anything else (incl. truthy garbage,
 *  `undefined` from a missing field) becomes `false`, so a malformed transparency body hides surfaces
 *  rather than silently enabling them. */
const asBool = (v: unknown): boolean => v === true;

/** A finite number, else the supplied default — guards the decay half-lives against a missing/garbage
 *  field on the wire. */
const asNum = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/**
 * Map the nested {@link SocialTransparencyWire} the server returns into the flat
 * {@link ResolvedSocialConfig} the `useSocial*` hooks gate on (`config.weatherEnabled`, etc.).
 *
 * This is the fix for "every lens shows null and never fetches": the hooks read flat `*Enabled` keys
 * that do not exist on the nested wire shape, so a raw cast left every gate `undefined → disabled`.
 *
 * The three fields transparency does not carry are filled with safe, fail-closed defaults:
 * - `neighborhoodIncludeInteractions: false` — the documented project default; a member can still
 *   override it per-request via the endpoint's `?includeInteractions=` param, and the response echoes
 *   the effective value. (If a project sets this default to `true`, the server's `transparencyView`
 *   must expose it for the SDK to honor it as the initial toggle state.)
 * - `frictionVisibleToStewards: false` — steward-only, never read by these member-facing hooks.
 * - `constellationKFloor: 5` — the contract's k-anonymity floor; not read by the hooks, present only
 *   to satisfy the type.
 *
 * @param t - The server's transparency DTO.
 * @returns The flat resolved config the hooks/components consume.
 */
export function transparencyToConfig(t: SocialTransparencyWire): ResolvedSocialConfig {
  const tier: SocialPrivacyTier = t.privacyTier === "corporate" ? "corporate" : "community";
  return {
    privacyTier: tier,
    graphEnabled: asBool(t.garden?.graph),
    weatherEnabled: asBool(t.garden?.weather),
    constellationEnabled: asBool(t.garden?.constellation),
    constellationKFloor: 5,
    neighborhoodEnabled: asBool(t.garden?.neighborhood),
    neighborhoodIncludeInteractions: false,
    influenceScoresEnabled: asBool(t.analytics?.influenceScores),
    siloDetectionEnabled: asBool(t.analytics?.siloDetection),
    engagementScoresEnabled: asBool(t.analytics?.engagementScores),
    frictionVisibleToStewards: false,
    frictionAnalyticsEnabled: asBool(t.analytics?.frictionAnalytics),
    readAffinityEnabled: asBool(t.garden?.readAffinity),
    readReceiptsAllowed: asBool(t.analytics?.readReceiptsAllowed),
    warmthHalfLifeDays: asNum(t.decay?.warmthHalfLifeDays, 30),
    frictionHalfLifeDays: asNum(t.decay?.frictionHalfLifeDays, 14),
  };
}

/**
 * Configuration for {@link SocialRestClient}. The base URL and access token are read through resolver
 * callbacks rather than captured once, so a late-set `baseUrl` or a refreshed token take effect on the
 * next request without rebuilding the client.
 */
export interface SocialRestConfig {
  /** Resolve the API base URL incl. the version prefix (e.g. `() => "https://host/v7"`). */
  getBaseUrl: () => string;
  /** Resolve the current access token, or undefined when signed out. */
  getAccessToken: () => string | undefined;
  /** The Agora project id (path-scoped on every endpoint — a privacy boundary). */
  projectId: string;
}

/**
 * A failed social API call. Carries the HTTP `status` and, when the server supplied one, the machine
 * `code` (e.g. `social/graph-unavailable`, `social/weather-disabled`) so callers can distinguish
 * "hide this surface" degradation (SOCIAL.md §7) from an unexpected failure.
 */
export class SocialApiError extends Error {
  /** HTTP status code, or `0` when the request never got a response (network error). */
  readonly status: number;
  /** The server's machine error code (e.g. `social/graph-unavailable`), or `null` if none was sent. */
  readonly code: string | null;

  /**
   * @param message - Human-readable summary (never contains member PII).
   * @param status - HTTP status code (`0` for a network-level failure).
   * @param code - The server's machine error code, or `null`.
   */
  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = "SocialApiError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Server error codes that mean "this surface is unavailable / turned off" rather than "something went
 * wrong" — the graph being unconfigured (`503`) or a lens being feature-disabled (`400`). Per
 * `docs/SOCIAL.md` §7 these should make the client **hide the surface**, never show a member an error.
 */
const SOCIAL_DEGRADATION_CODES: ReadonlySet<string> = new Set([
  "social/graph-unavailable",
  "social/weather-disabled",
  "social/constellation-disabled",
  "social/neighborhood-disabled",
]);

/**
 * Whether an error is a "hide this surface" degradation (graph unavailable or a feature-disabled lens)
 * rather than a real failure. Hooks use this to fail soft — clearing data instead of surfacing the
 * error to members (`docs/SOCIAL.md` §7).
 *
 * @param err - Any caught error.
 * @returns `true` for a {@link SocialApiError} whose `code` is a known degradation code; else `false`.
 */
export function isSocialDegradation(err: unknown): boolean {
  return (
    err instanceof SocialApiError && err.code !== null && SOCIAL_DEGRADATION_CODES.has(err.code)
  );
}

/**
 * Pull the server's machine error code out of an arbitrary error body. agora-server error shapes vary
 * (`{ error: { code } }`, `{ code }`, or `{ error: "social/…" }`), so probe each defensively and fall
 * back to `null`. Never throws.
 */
function extractCode(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const body = data as Record<string, unknown>;
  const nested = body.error;
  if (nested && typeof nested === "object" && typeof (nested as Record<string, unknown>).code === "string") {
    return (nested as Record<string, unknown>).code as string;
  }
  if (typeof body.code === "string") return body.code;
  if (typeof nested === "string") return nested;
  return null;
}

/**
 * Typed REST client for the Agora social graph.
 *
 * Wraps the four social endpoints in `docs/SOCIAL.md`. Each request lazily resolves the base URL and
 * bearer token, scopes the path to `{baseUrl}/{projectId}/social`, and normalizes any failure into a
 * {@link SocialApiError}.
 *
 * @remarks
 * Construct this directly only for advanced / non-React use. Inside React, prefer the `SocialProvider`
 * + hooks, which build and share one client for you.
 *
 * @example
 * ```typescript
 * const rest = new SocialRestClient({
 *   projectId,
 *   getBaseUrl: () => "https://host/v7",
 *   getAccessToken: () => session.accessToken,
 * });
 * const weather = await rest.getWeather();
 * ```
 */
export class SocialRestClient {
  private readonly http: AxiosInstance;

  /** @param config - Lazy resolvers for base URL + token, plus the path-scoped project id. */
  constructor(private readonly config: SocialRestConfig) {
    this.http = axios.create();
    this.http.interceptors.request.use((req) => {
      const base = config.getBaseUrl().replace(/\/$/, "");
      req.baseURL = `${base}/${config.projectId}/social`;
      const token = config.getAccessToken();
      if (token) req.headers.set("Authorization", `Bearer ${token}`);
      return req;
    });
  }

  /**
   * Fetch the Community Weather scalar (aggregate warmth + band + 7-day trend).
   *
   * @returns The current {@link SocialWeather} reading (`value: null` / `band: "quiet"` when no data yet).
   * @throws {SocialApiError} `400 social/weather-disabled` (feature off) or `503 social/graph-unavailable`.
   */
  async getWeather(): Promise<SocialWeather> {
    return this.get<SocialWeather>("/weather");
  }

  /**
   * Fetch the Constellation snapshot (anonymous cluster blobs).
   *
   * @returns The current {@link SocialConstellation} (`asOf: null` when no snapshot exists yet).
   * @throws {SocialApiError} `400 social/constellation-disabled` or `503 social/graph-unavailable`.
   */
  async getConstellation(): Promise<SocialConstellation> {
    return this.get<SocialConstellation>("/constellation");
  }

  /**
   * Fetch the caller's Neighborhood (their own named ties with dyadic brightness). Self-view only.
   *
   * @param opts - Optional `includeInteractions` toggle; omit to use the project default. The response
   *   always echoes the **effective** value via `includesInteractions`.
   * @returns The caller's {@link SocialNeighborhood}, ties sorted brightest-first.
   * @throws {SocialApiError} `400 social/neighborhood-disabled` or `503 social/graph-unavailable`.
   */
  async getNeighborhood(opts?: { includeInteractions?: boolean }): Promise<SocialNeighborhood> {
    const params =
      opts?.includeInteractions === undefined
        ? undefined
        : { includeInteractions: opts.includeInteractions };
    return this.get<SocialNeighborhood>("/neighborhood", params);
  }

  /**
   * Fetch the project's resolved social config (which lenses are enabled, decay half-lives, k-floor).
   * Call this at app init to know which surfaces to render.
   *
   * @returns The project's {@link ResolvedSocialConfig}.
   * @throws {SocialApiError} `503 social/graph-unavailable` when the graph is not configured.
   */
  async getTransparency(): Promise<ResolvedSocialConfig> {
    // The endpoint returns a NESTED DTO (garden/analytics/decay), not the flat ResolvedSocialConfig
    // the hooks gate on — map it, never cast. A raw cast left every `*Enabled` key `undefined`, so the
    // hooks self-gated to disabled and never fetched any lens.
    return transparencyToConfig(await this.get<SocialTransparencyWire>("/transparency"));
  }

  /**
   * Shared GET helper: issues the request and normalizes any axios failure into a {@link SocialApiError}
   * carrying the HTTP status + server error code.
   */
  private async get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    try {
      const { data } = await this.http.get<T>(path, params ? { params } : undefined);
      return data;
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status ?? 0;
        const code = extractCode(err.response?.data);
        throw new SocialApiError(
          code ? `Social request failed: ${code}` : `Social request failed (HTTP ${status}).`,
          status,
          code
        );
      }
      throw err;
    }
  }
}
