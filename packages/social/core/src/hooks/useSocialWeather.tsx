// useSocialWeather — load the Community Weather scalar, gated on the project's feature config.
//
// Self-gates on `config.weatherEnabled` from the provider: when the lens is disabled (or the graph is
// unavailable) the hook returns `weather: null` and never issues a request, so a host app can render
// `<CommunityWeather />` unconditionally and have it disappear when off (SOCIAL.md §7). Weather is a
// ~1h server-cached aggregate, so a single fetch on enable is enough; `refresh()` is exposed for
// manual refetch (e.g. pull-to-refresh).

import { useCallback, useEffect, useState } from "react";
import { SocialWeather } from "../contract/index.js";
import { isSocialDegradation } from "../transport/rest.js";
import { useSocial } from "../context/social-context.js";

/** The state and actions returned by {@link useSocialWeather}. */
export interface UseSocialWeatherValues {
  /** The current Weather reading, or `null` while loading, when disabled, or on error. */
  weather: SocialWeather | null;
  /** True while a fetch is in flight (always `false` when the lens is disabled). */
  loading: boolean;
  /** The last error thrown by the fetch, or `null`. */
  error: unknown;
  /** Re-fetch the Weather reading. No-op when the lens is disabled. */
  refresh: () => Promise<void>;
}

/**
 * Load the Community Weather scalar for the current project.
 *
 * Waits for the provider's transparency config, then fetches `GET /social/weather` only when
 * `weatherEnabled` is true. When the lens is disabled it returns `{ weather: null, loading: false }`
 * and issues no request.
 *
 * @returns {@link UseSocialWeatherValues} — the reading, load state, and a `refresh` action.
 *
 * @example
 * ```tsx
 * const { weather, loading } = useSocialWeather();
 * if (!weather) return null; // disabled or still loading
 * ```
 */
export function useSocialWeather(): UseSocialWeatherValues {
  const { rest, config, configLoading } = useSocial();
  const enabled = config?.weatherEnabled ?? false;

  const [weather, setWeather] = useState<SocialWeather | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    try {
      setWeather(await rest.getWeather());
    } catch (err) {
      // Fail soft on degradation (graph off, or the lens disabled mid-session): hide the surface —
      // clear the reading and swallow the error rather than surface it to members (SOCIAL.md §7). Real
      // errors still propagate via `error`.
      if (isSocialDegradation(err)) {
        setWeather(null);
        setError(null);
      } else {
        setError(err);
      }
    } finally {
      setLoading(false);
    }
  }, [enabled, rest]);

  // Fetch once the config has resolved and the lens is enabled. When disabled, clear any stale reading
  // so a config flip to off (or a project switch) doesn't leave the previous community's weather on screen.
  useEffect(() => {
    if (configLoading) return;
    if (!enabled) {
      setWeather(null);
      return;
    }
    void refresh();
  }, [configLoading, enabled, refresh]);

  return { weather, loading, error, refresh };
}
