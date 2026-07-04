// P5 — the logout integrators actually want. The SDK's useAuth().signOut() is active-account-only: with
// more than one stored account it SWITCHES to a remaining account instead of ending the session, and
// can't clear a corrupt map. useSignOutAll() wipes the whole map — the reliable full logout. This wraps
// it under an intent-revealing name and adds a pending flag for button state.
import { useCallback, useEffect, useRef, useState } from "react";
import { useSignOutAll } from "@agora-sdk/react-js";

/** Return value of {@link useSignOutEverywhere}. */
export type UseSignOutEverywhereReturn = {
  /**
   * End the session on every stored account and clear the map. The SDK's `signOutAll` treats each
   * account's server-side revoke as best-effort — a failed revoke is logged, not thrown — so local
   * state is cleared even when the server call fails. This only rejects on an unexpected failure
   * (e.g. no active project, or the underlying dispatch itself throwing).
   */
  signOutEverywhere: () => Promise<void>;
  /** True while the sign-out is in flight. */
  isPending: boolean;
};

/**
 * Reliable full logout for a single-session app — wraps the SDK's `useSignOutAll`.
 *
 * @returns {@link UseSignOutEverywhereReturn}
 * @example
 * const { signOutEverywhere, isPending } = useSignOutEverywhere();
 * <button disabled={isPending} onClick={() => void signOutEverywhere().catch(() => {})}>Sign out</button>
 */
export function useSignOutEverywhere(): UseSignOutEverywhereReturn {
  const { signOutAll } = useSignOutAll();
  const [isPending, setIsPending] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const signOutEverywhere = useCallback(async () => {
    setIsPending(true);
    try {
      await signOutAll();
    } finally {
      if (mounted.current) setIsPending(false);
    }
  }, [signOutAll]);

  return { signOutEverywhere, isPending };
}
