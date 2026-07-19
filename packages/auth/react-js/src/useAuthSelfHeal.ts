// P6 — self-heal a stale-only session. A returning user whose only stored refresh token has been
// rotated away server-side boots → `unknown token` 401 → stuck logged out, because the dead entry
// stays in the map with no prune-on-failure. We heal by OBSERVING the SDK's settled outcome (it ended
// up unauthenticated despite a stored active account) and pruning that one account — never by issuing
// our own refresh call, which would duplicate the SDK's and re-create the "two refresh tokens in play"
// race. pruneAccount() also dispatches a synthetic storage event so the SDK re-evaluates remaining
// accounts in-session.
import { useEffect, useRef } from "react";
import { useProject } from "@agora-sdk/react-js";
import { useAuthStatus } from "./useAuthStatus.js";
import { readAccountMap, pruneAccount } from "./accountStorage.js";

/**
 * Mount this once inside `<ReplykeProvider>` (alongside the comment/thread UI) to prune a stale-only
 * session that left the user logged out. Prunes the active account only when the SDK settled
 * `unauthenticated` while a stored active account exists, and at most once per dead id.
 *
 * @example
 * function App() { useAuthSelfHeal(); return <Thread />; }
 */
export function useAuthSelfHeal(): void {
  const { projectId } = useProject();
  const { status } = useAuthStatus();
  const healedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (status !== "unauthenticated" || !projectId) return; // wait until the SDK has settled
    const map = readAccountMap(projectId);
    const activeId = map?.activeAccountId;
    if (!activeId || !map?.accounts[activeId]) return; // nothing stored to heal
    if (healedRef.current.has(activeId)) return; // already pruned this dead id once
    healedRef.current.add(activeId);
    pruneAccount(projectId, activeId);
  }, [status, projectId]);
}
