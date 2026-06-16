// useSocialConstellation — load the anonymous Constellation snapshot, gated on the feature config.
//
// Self-gates on `config.constellationEnabled`. The Constellation is a slow seasonal snapshot
// (materialized ~every 6 weeks), so one fetch on enable is plenty; `refresh()` is exposed only for
// completeness. The returned `blobs` carry no stable identity — re-randomizing their LAYOUT on every
// render is the rendering layer's job (SOCIAL.md §6), not this hook's.

import { useCallback, useEffect, useState } from "react";
import { SocialConstellation } from "../contract/index.js";
import { isSocialDegradation } from "../transport/rest.js";
import { useSocial } from "../context/social-context.js";

/** The state and actions returned by {@link useSocialConstellation}. */
export interface UseSocialConstellationValues {
  /** The current snapshot, or `null` while loading, when disabled, or on error. `asOf: null` = still forming. */
  constellation: SocialConstellation | null;
  /** True while a fetch is in flight (always `false` when the lens is disabled). */
  loading: boolean;
  /** The last error thrown by the fetch, or `null`. */
  error: unknown;
  /** Re-fetch the snapshot. No-op when the lens is disabled. */
  refresh: () => Promise<void>;
}

/**
 * Load the Constellation snapshot (anonymous cluster blobs) for the current project.
 *
 * Waits for the provider's transparency config, then fetches `GET /social/constellation` only when
 * `constellationEnabled` is true. A snapshot with `asOf === null` is the valid "still forming" state,
 * not an error — render a nebula.
 *
 * @returns {@link UseSocialConstellationValues} — the snapshot, load state, and a `refresh` action.
 *
 * @example
 * ```tsx
 * const { constellation } = useSocialConstellation();
 * if (!constellation) return null;             // disabled or loading
 * if (constellation.asOf === null) return <Nebula />; // still forming
 * ```
 */
export function useSocialConstellation(): UseSocialConstellationValues {
  const { rest, config, configLoading } = useSocial();
  const enabled = config?.constellationEnabled ?? false;

  const [constellation, setConstellation] = useState<SocialConstellation | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    try {
      setConstellation(await rest.getConstellation());
    } catch (err) {
      // Fail soft on degradation (graph off, or the lens disabled mid-session): hide the surface —
      // clear the snapshot and swallow the error rather than surface it to members (SOCIAL.md §7). Real
      // errors still propagate via `error`.
      if (isSocialDegradation(err)) {
        setConstellation(null);
        setError(null);
      } else {
        setError(err);
      }
    } finally {
      setLoading(false);
    }
  }, [enabled, rest]);

  useEffect(() => {
    if (configLoading) return;
    if (!enabled) {
      setConstellation(null);
      return;
    }
    void refresh();
  }, [configLoading, enabled, refresh]);

  return { constellation, loading, error, refresh };
}
