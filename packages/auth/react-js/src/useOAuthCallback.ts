// P1 (emulated) + P3 — the persistence gate. The SDK's handleOAuthCallback() is fire-and-forget with
// DEFERRED persistence: it stages tokens in Redux and starts an async user fetch, but the session
// isn't written to localStorage until useAccountSync's effects run several render cycles later. An MPA
// callback that navigates on the synchronous return tears down the tree before persistence lands and
// loses the session. This hook gates navigation on OBSERVED persistence (store state AND the
// localStorage row), never a timer — so the next document boots into a real session.
import { useEffect, useRef, useState } from "react";
import { useOAuthSignIn, useAuth, useUser, useProject } from "@agora-sdk/react-js";
import { hasPersistedRefreshToken } from "./accountStorage";

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
};

/** Return value of {@link useOAuthCallback}. */
export type UseOAuthCallbackReturn = {
  /** `pending` while waiting for persistence; `success` just before navigation; `error` on a provider error. */
  status: OAuthCallbackStatus;
  /** Human-readable provider error, when `status === "error"`. */
  error: string | null;
};

/**
 * Drive an MPA OAuth callback page: parse the redirect once, wait until the session is actually
 * persisted to localStorage, then full-page-navigate to `redirectTo`. Resolves the persist→navigate
 * race so the destination document boots authenticated.
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
  const { redirectTo, onTimeout, timeoutMs = 15000 } = options;
  const { handleOAuthCallback, error: providerError } = useOAuthSignIn();
  const { accessToken } = useAuth();
  const { user } = useUser();
  const { projectId } = useProject();

  const [status, setStatus] = useState<OAuthCallbackStatus>("pending");
  const [error, setError] = useState<string | null>(null);
  const parsedRef = useRef(false);
  const doneRef = useRef(false);

  // Parse the redirect exactly once. This only stages tokens + starts the async user fetch.
  useEffect(() => {
    if (parsedRef.current) return;
    parsedRef.current = true;
    const ok = handleOAuthCallback();
    if (!ok) {
      doneRef.current = true;
      setError(providerError);
      setStatus("error");
    }
  }, [handleOAuthCallback, providerError]);

  // Navigate ONLY once store state (accessToken + user) AND the persisted localStorage row agree.
  useEffect(() => {
    if (doneRef.current) return;
    if (!accessToken || !user?.id || !projectId) return; // user fetch still in flight
    if (!hasPersistedRefreshToken(projectId, user.id)) return; // write hasn't landed yet
    doneRef.current = true;
    setStatus("success");
    window.location.replace(redirectTo);
  }, [accessToken, user, projectId, redirectTo]);

  // Escape hatch: if persistence never lands, tell the caller instead of hanging forever.
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
