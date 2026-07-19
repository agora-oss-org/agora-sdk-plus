// P1 (emulated) + P3 — the persistence gate. The SDK's handleOAuthCallback() is fire-and-forget with
// DEFERRED persistence: it stages tokens in Redux and starts an async user fetch, but the session
// isn't written to localStorage until useAccountSync's effects run several render cycles later. An MPA
// callback that navigates on the synchronous return tears down the tree before persistence lands and
// loses the session.
//
// We gate navigation on the PERSISTED localStorage row — the exact state the next document boots from —
// NOT on volatile in-store Redux auth. That distinction is load-bearing (field report A8): when a
// STALE account already sits in localStorage, the SDK's boot-refresh of it fails 401 and resets the
// in-store accessToken that the fresh OAuth just set, so any gate keyed on in-store auth hangs to
// timeout even though the fresh account persisted correctly. Reading the persisted row sidesteps the
// race entirely. Because the SDK's same-tab writes don't emit a `storage` event, we poll.
import { useEffect, useRef, useState } from "react";
import { useOAuthSignIn, useProject } from "@agora-sdk/react-js";
import { readActiveAccount, pruneAllAccounts } from "./accountStorage.js";

/** How often (ms) we re-read the persisted row while waiting. Imperceptible for a one-shot login gate. */
const POLL_MS = 50;

/** Lifecycle of an OAuth callback page. */
export type OAuthCallbackStatus = "pending" | "success" | "error";

/** Options for {@link useOAuthCallback}. */
export type UseOAuthCallbackOptions = {
  /** Where to navigate (full-page) once the session is truly persisted. */
  redirectTo: string;
  /** Called if persistence never lands within `timeoutMs` (e.g. the user fetch failed). */
  onTimeout?: () => void;
  /** How long to wait for persistence before giving up. Default 15000ms. */
  timeoutMs?: number;
  /**
   * Clear any pre-existing stored accounts on mount, before parsing the callback. Off by default. A
   * single-session app can enable it to silence the cosmetic `401` from the SDK boot-refreshing a
   * stale account (field report A8): with nothing stale to refresh, no competing request runs. Leave
   * it off for multi-account apps, where a pre-existing account may still be valid — the gate already
   * tolerates the race without it.
   */
  pruneStaleOnMount?: boolean;
};

/** Return value of {@link useOAuthCallback}. */
export type UseOAuthCallbackReturn = {
  /** `pending` while waiting for persistence; `success` just before navigation; `error` on a provider error. */
  status: OAuthCallbackStatus;
  /** Human-readable provider error, when `status === "error"`. */
  error: string | null;
};

/**
 * Drive an MPA OAuth callback page: parse the redirect once, wait until a fresh session is actually
 * persisted to localStorage, then full-page-navigate to `redirectTo`. Resolves the persist→navigate
 * race so the destination document boots authenticated — and, per field report A8, survives a stale
 * account's boot-refresh clobbering in-store auth, because it gates on the persisted row rather than
 * Redux state.
 *
 * @param options - {@link UseOAuthCallbackOptions}
 * @returns the {@link OAuthCallbackStatus} and any provider error.
 * @example
 * function Callback() {
 *   const { status, error } = useOAuthCallback({ redirectTo: "/#comments" });
 *   if (status === "error") return <p>Sign-in failed: {error}</p>;
 *   return <Spinner />; // success navigates away
 * }
 */
export function useOAuthCallback(options: UseOAuthCallbackOptions): UseOAuthCallbackReturn {
  const { redirectTo, onTimeout, timeoutMs = 15000, pruneStaleOnMount = false } = options;
  const { handleOAuthCallback, error: providerError } = useOAuthSignIn();
  const { projectId } = useProject();

  const [status, setStatus] = useState<OAuthCallbackStatus>("pending");
  const [error, setError] = useState<string | null>(null);
  const parsedRef = useRef(false);
  const doneRef = useRef(false);
  // The active persisted account at boot (after any prune). A fresh login is detected as a change
  // against this snapshot, so a pre-existing/stale account never counts as success.
  const priorRef = useRef<{ id: string; tokenExpiresAt: number } | null>(null);

  // Parse the redirect exactly once. This only stages tokens + starts the async user fetch.
  useEffect(() => {
    if (parsedRef.current) return;
    parsedRef.current = true;

    if (projectId) {
      if (pruneStaleOnMount) pruneAllAccounts(projectId);
      priorRef.current = readActiveAccount(projectId);
    }

    const ok = handleOAuthCallback();
    if (!ok) {
      doneRef.current = true;
      setError(providerError);
      setStatus("error");
    }
  }, [handleOAuthCallback, providerError, projectId, pruneStaleOnMount]);

  // Gate on the PERSISTED row. Poll, because the SDK's same-tab writes don't emit a `storage` event,
  // and because the store state we'd otherwise watch is exactly what's unreliable here (A8).
  useEffect(() => {
    if (doneRef.current || !projectId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = () => {
      if (doneRef.current) return;
      const active = readActiveAccount(projectId);
      const prior = priorRef.current;
      // Fresh = an active account with a token that differs from the boot snapshot: a new active id,
      // or the same id with an advanced token expiry (same-user re-login), or no prior session at all.
      const isFresh =
        active != null &&
        (prior == null ||
          prior.id !== active.id ||
          prior.tokenExpiresAt !== active.tokenExpiresAt);

      if (isFresh) {
        doneRef.current = true;
        setStatus("success");
        window.location.replace(redirectTo);
        return;
      }
      timer = setTimeout(tick, POLL_MS);
    };

    tick();
    return () => clearTimeout(timer);
  }, [projectId, redirectTo]);

  // Escape hatch: if a fresh session never persists, tell the caller instead of hanging forever.
  useEffect(() => {
    if (doneRef.current) return;
    const id = setTimeout(() => {
      if (doneRef.current) return;
      doneRef.current = true;
      onTimeout?.();
    }, timeoutMs);
    return () => clearTimeout(id);
  }, [onTimeout, timeoutMs]);

  return { status, error };
}
