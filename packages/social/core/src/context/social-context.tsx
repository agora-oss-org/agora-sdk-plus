// SocialProvider — wires the social REST transport and auto-resolves the project's feature config.
//
// Standalone transport: the caller supplies the API base URL directly — this package has NO dependency
// on @agora-sdk/core (it previously fell back to core's getApiBaseUrl runtime singleton, a coupling
// whose only purpose was auto-inheriting a Replyke app's config). On mount it fetches
// `GET /social/transparency` once and stores the resolved config so every hook/component can self-gate
// on the per-project feature flags WITHOUT each issuing its own probe (SOCIAL.md §7 — "check
// transparency at app init"). There is no crypto and no persistence here: social data is
// public/server-side and slow-moving, so the provider holds fetched config in React state only.
//
// Graceful degradation: a `503 social/graph-unavailable` is treated as "the whole graph is off" — we
// store an ALL-DISABLED sentinel rather than an error, so surfaces hide silently instead of throwing
// at members. Any other failure is surfaced via `configError` for the host app to decide on.

import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";

import { SocialRestClient } from "../transport/rest.js";
import { SocialApiError } from "../transport/rest.js";
import { ResolvedSocialConfig } from "../contract/index.js";

/**
 * The resolved-config sentinel used when the social graph is unavailable (`503
 * social/graph-unavailable`) — every lens and analytics flag disabled, so hooks/components render
 * nothing rather than erroring. Tier is the safe `"community"` default and numeric tuning fields are
 * zeroed; none of these are read while the lenses are disabled.
 */
export const ALL_DISABLED_SOCIAL_CONFIG: ResolvedSocialConfig = {
  privacyTier: "community",
  graphEnabled: false,
  weatherEnabled: false,
  constellationEnabled: false,
  constellationKFloor: 0,
  neighborhoodEnabled: false,
  neighborhoodIncludeInteractions: false,
  influenceScoresEnabled: false,
  siloDetectionEnabled: false,
  engagementScoresEnabled: false,
  frictionVisibleToStewards: false,
  frictionAnalyticsEnabled: false,
  readAffinityEnabled: false,
  readReceiptsAllowed: false,
  warmthHalfLifeDays: 0,
  frictionHalfLifeDays: 0,
};

/**
 * The value exposed by {@link useSocial}: the shared REST client, the auto-fetched feature config and
 * its load state, and the active project id.
 */
export interface SocialContextValue {
  /** REST client for the social endpoints. */
  rest: SocialRestClient;
  /**
   * The project's resolved social config, or `null` until the transparency fetch resolves. When the
   * graph is unavailable this is the {@link ALL_DISABLED_SOCIAL_CONFIG} sentinel (not `null`).
   */
  config: ResolvedSocialConfig | null;
  /** True while the initial transparency fetch is in flight. */
  configLoading: boolean;
  /** A non-degradation error from the transparency fetch (the `503` graph-off case is not an error). */
  configError: unknown;
  /** The Agora project id these clients are scoped to. */
  projectId: string;
}

const SocialContext = createContext<SocialContextValue | null>(null);

/** Props for {@link SocialProvider}. */
export interface SocialProviderProps {
  /** Agora project id (path-scoped on every endpoint — a privacy boundary). */
  projectId: string;
  /** Current access token. Re-pass on refresh; read lazily per request. */
  accessToken?: string;
  /** Override token resolution (takes precedence over `accessToken`). */
  getAccessToken?: () => string | undefined;
  /**
   * API base URL including the version prefix (e.g. `https://api.example.com/v7`). Required — social
   * is a standalone transport and does not resolve a URL from any ambient SDK runtime. Read lazily per
   * request, so re-passing a changed value takes effect on the next call.
   */
  baseUrl: string;
  children: React.ReactNode;
}

/**
 * Provides the social REST client + the project's resolved feature config to the `useSocial*` hooks
 * and components. Render inside a `ReplykeProvider`. Auto-fetches `GET /social/transparency` once on
 * mount; treats `503 social/graph-unavailable` as "all lenses disabled" rather than an error.
 *
 * @param props - {@link SocialProviderProps}.
 * @returns A context provider wrapping `children`.
 *
 * @example
 * ```tsx
 * <SocialProvider projectId={projectId} accessToken={token} baseUrl="https://your-api.example.com/v7">
 *   <CommunityWeather />
 *   <Constellation />
 * </SocialProvider>
 * ```
 */
export function SocialProvider({
  projectId,
  accessToken,
  getAccessToken,
  baseUrl,
  children,
}: SocialProviderProps) {
  const tokenRef = useRef<string | undefined>(accessToken);
  tokenRef.current = accessToken;

  const resolveToken = useMemo(
    () => getAccessToken ?? (() => tokenRef.current),
    [getAccessToken]
  );

  const rest = useMemo(
    () =>
      new SocialRestClient({
        projectId,
        getAccessToken: resolveToken,
        getBaseUrl: () => baseUrl,
      }),
    [projectId, resolveToken, baseUrl]
  );

  const [config, setConfig] = useState<ResolvedSocialConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState<unknown>(null);

  // Auto-resolve the per-project feature config once on mount (and whenever the client identity
  // changes). A `503 social/graph-unavailable` is degradation, not an error: store the all-disabled
  // sentinel so every surface hides silently (SOCIAL.md §7). A stale-guard prevents a slow first fetch
  // from clobbering a newer one after a projectId/token swap.
  useEffect(() => {
    let active = true;
    setConfigLoading(true);
    setConfigError(null);
    rest
      .getTransparency()
      .then((resolved) => {
        if (!active) return;
        setConfig(resolved);
      })
      .catch((err) => {
        if (!active) return;
        if (err instanceof SocialApiError && err.code === "social/graph-unavailable") {
          setConfig(ALL_DISABLED_SOCIAL_CONFIG);
        } else {
          setConfigError(err);
        }
      })
      .finally(() => {
        if (active) setConfigLoading(false);
      });
    return () => {
      active = false;
    };
  }, [rest]);

  const value = useMemo<SocialContextValue>(
    () => ({ rest, config, configLoading, configError, projectId }),
    [rest, config, configLoading, configError, projectId]
  );

  return <SocialContext.Provider value={value}>{children}</SocialContext.Provider>;
}

/**
 * Access the nearest {@link SocialContextValue}.
 *
 * @returns The shared rest client, resolved feature config + load state, and project id.
 * @throws {Error} When called outside a `<SocialProvider>`.
 */
export function useSocial(): SocialContextValue {
  const ctx = useContext(SocialContext);
  if (!ctx) {
    throw new Error("useSocial must be used within a <SocialProvider>.");
  }
  return ctx;
}
