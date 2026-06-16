// useSocialNeighborhood — load the caller's own named ties (self-view), gated on the feature config.
//
// Self-gates on `config.neighborhoodEnabled`. Owns the `includeInteractions` toggle: it seeds from the
// project default (`config.neighborhoodIncludeInteractions`) once config resolves, then re-fetches
// whenever the caller flips it. The server always echoes the EFFECTIVE value, so we sync local state to
// the response (`includesInteractions`) rather than trusting the request optimistically.
//
// Privacy (SOCIAL.md §6): the Neighborhood is self-view only and must not persist across sign-outs or
// user switches. This hook keeps ties in component state only (no cache) and clears them when the lens
// disables or the provider's client identity changes — so a project/token swap cannot leak a prior
// user's ties.

import { useCallback, useEffect, useRef, useState } from "react";
import { SocialNeighborhood } from "../contract/index.js";
import { isSocialDegradation } from "../transport/rest.js";
import { useSocial } from "../context/social-context.js";

/** The state and actions returned by {@link useSocialNeighborhood}. */
export interface UseSocialNeighborhoodValues {
  /** The caller's ties (brightest-first), or `null` while loading, when disabled, or on error. */
  neighborhood: SocialNeighborhood | null;
  /** True while a fetch is in flight (always `false` when the lens is disabled). */
  loading: boolean;
  /** The last error thrown by the fetch, or `null`. */
  error: unknown;
  /** The effective `includeInteractions` value currently in effect. */
  includeInteractions: boolean;
  /** Flip whether interaction-only ties are included; triggers a re-fetch. */
  setIncludeInteractions: (value: boolean) => void;
}

/**
 * Load the caller's Neighborhood — their own named ties with dyadic brightness. Self-view only.
 *
 * Waits for the provider's transparency config, seeds the `includeInteractions` toggle from the
 * project default, then fetches `GET /social/neighborhood` only when `neighborhoodEnabled` is true.
 * Flipping the toggle re-fetches; the hook syncs to the server's echoed effective value.
 *
 * @returns {@link UseSocialNeighborhoodValues} — the ties, load state, and the interactions toggle.
 *
 * @example
 * ```tsx
 * const { neighborhood, includeInteractions, setIncludeInteractions } = useSocialNeighborhood();
 * ```
 */
export function useSocialNeighborhood(): UseSocialNeighborhoodValues {
  const { rest, config, configLoading } = useSocial();
  const enabled = config?.neighborhoodEnabled ?? false;
  const projectDefault = config?.neighborhoodIncludeInteractions ?? false;

  const [neighborhood, setNeighborhood] = useState<SocialNeighborhood | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [includeInteractions, setIncludeInteractions] = useState(false);

  // Seed the toggle from the project default exactly once, when config first resolves. After that the
  // caller owns it. A ref guards against re-seeding (which would clobber a user's choice on re-render).
  const seeded = useRef(false);
  useEffect(() => {
    if (configLoading || seeded.current) return;
    setIncludeInteractions(projectDefault);
    seeded.current = true;
  }, [configLoading, projectDefault]);

  const fetchFor = useCallback(
    async (include: boolean) => {
      if (!enabled) return;
      setLoading(true);
      setError(null);
      try {
        const result = await rest.getNeighborhood({ includeInteractions: include });
        setNeighborhood(result);
        // Sync to the server's effective value (it may override the request, e.g. project policy).
        setIncludeInteractions(result.includesInteractions);
      } catch (err) {
        // Fail soft on degradation (graph off, or the lens disabled mid-session): hide the surface —
        // clear ties and swallow the error rather than surface it to members (SOCIAL.md §7). Real
        // errors still propagate via `error`.
        if (isSocialDegradation(err)) {
          setNeighborhood(null);
          setError(null);
        } else {
          setError(err);
        }
      } finally {
        setLoading(false);
      }
    },
    [enabled, rest]
  );

  // Fetch on enable and whenever the toggle changes. Clear ties when disabled or before re-fetch under
  // a new identity — the self-view must never linger across a user switch (SOCIAL.md §6).
  useEffect(() => {
    if (configLoading || !seeded.current) return;
    if (!enabled) {
      setNeighborhood(null);
      return;
    }
    void fetchFor(includeInteractions);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configLoading, enabled, includeInteractions, fetchFor]);

  return { neighborhood, loading, error, includeInteractions, setIncludeInteractions };
}
