// useSocialTransparency — read the project's resolved social config from the provider.
//
// The provider already fetches `GET /social/transparency` once on mount, so this hook issues no
// request of its own — it just surfaces the cached config + load state. Use it to render a how-it-works
// panel (which lenses are on, decay half-lives, k-floor) or to drive nav-entry visibility.

import { ResolvedSocialConfig } from "../contract/index.js";
import { useSocial } from "../context/social-context.js";

/** The state returned by {@link useSocialTransparency}. */
export interface UseSocialTransparencyValues {
  /** The resolved config, or `null` until the provider's transparency fetch resolves. */
  config: ResolvedSocialConfig | null;
  /** True while the provider's initial transparency fetch is in flight. */
  loading: boolean;
  /** A non-degradation error from the transparency fetch, or `null`. */
  error: unknown;
}

/**
 * Read the project's resolved social config (which lenses are enabled, decay half-lives, k-floor).
 *
 * Reads straight from the provider — no extra request. Returns `config: null` until the provider's
 * mount-time transparency fetch resolves.
 *
 * @returns {@link UseSocialTransparencyValues} — the resolved config and its load state.
 *
 * @example
 * ```tsx
 * const { config } = useSocialTransparency();
 * if (config?.weatherEnabled) renderWeatherNavEntry();
 * ```
 */
export function useSocialTransparency(): UseSocialTransparencyValues {
  const { config, configLoading, configError } = useSocial();
  return { config, loading: configLoading, error: configError };
}
