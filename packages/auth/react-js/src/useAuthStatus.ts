// P4 — a first-class auth-ready signal so integrators stop re-deriving `Boolean(accessToken && user)`
// and stop guessing when the two settle. Observes the SDK's own state via its public hooks; reads
// storage only to answer "is the session durable (in localStorage), not just in Redux?".
import { useAuth, useUser, useProject } from "@agora-sdk/react-js";
import { hasPersistedRefreshToken } from "./accountStorage.js";

/** Coarse, settled auth state derived once for the whole app. */
export type AuthReadyStatus = "initializing" | "authenticated" | "unauthenticated";

/** Return value of {@link useAuthStatus}. */
export type UseAuthStatusReturn = {
  /** `initializing` until the SDK has booted; then `authenticated` / `unauthenticated`. */
  status: AuthReadyStatus;
  /** True when the active session is written to localStorage (survives a reload), not just held in Redux. */
  isPersisted: boolean;
};

/**
 * Derive a single, first-class auth-ready signal from the SDK's auth + user slices.
 *
 * @returns the coarse {@link AuthReadyStatus} and whether the session is persisted.
 * @example
 * const { status } = useAuthStatus();
 * if (status === "initializing") return <Spinner />;
 * return status === "authenticated" ? <App /> : <Login />;
 */
export function useAuthStatus(): UseAuthStatusReturn {
  const { initialized, accessToken } = useAuth();
  const { user } = useUser();
  const { projectId } = useProject();

  const status: AuthReadyStatus = !initialized
    ? "initializing"
    : accessToken && user?.id
    ? "authenticated"
    : "unauthenticated";

  const isPersisted = Boolean(
    projectId && user?.id && hasPersistedRefreshToken(projectId, user.id)
  );

  return { status, isPersisted };
}
