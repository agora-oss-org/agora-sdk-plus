// Typed REST client for the Agora social graph (Weather / Constellation / Neighborhood / Transparency).
//
// Covers every endpoint in `docs/SOCIAL.md` §1–4. Base URL and access token are resolved **lazily per
// request** (matching the @agora-sdk/core base-URL runtime), so a token refresh or a late-set baseUrl
// always wins. Every endpoint is path-scoped to `{baseUrl}/{projectId}/social` — the `:projectId`
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
  SocialWeather,
} from "../contract/index.js";

/**
 * Configuration for {@link SocialRestClient}. The base URL and access token are read through resolver
 * callbacks rather than captured once, so a late-set `baseUrl` or a refreshed token take effect on the
 * next request without rebuilding the client.
 */
export interface SocialRestConfig {
  /** Resolve the API base URL (e.g. `getApiBaseUrl()` from @agora-sdk/core → `http://host/v7`). */
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
 *   getBaseUrl: () => getApiBaseUrl(),
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
    return this.get<ResolvedSocialConfig>("/transparency");
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
