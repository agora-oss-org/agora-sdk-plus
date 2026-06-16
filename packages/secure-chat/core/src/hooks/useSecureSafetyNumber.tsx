// useSecureSafetyNumber — derive the key-verification safety number for a DM conversation.
//
// Where it sits in the blind-server model: the server is untrusted and could swap a peer's KeyPackage
// (active MITM on a TOFU system). This hook reads the two devices' PUBLIC identity keys from the local
// MLS roster (crypto.exportGroupIdentities) and computes a symmetric, human-comparable safety number
// (see util/safety-number) the two users confirm out-of-band. Headless: the styled UI lives in the app
// / demo. DM-focused — for anything other than a 2-member group it returns null rather than guess.

import { useCallback, useEffect, useRef, useState } from "react";
import { computeSafetyNumber, type SafetyNumber } from "../util/safety-number.js";
import { useSecureChat } from "../context/secure-chat-context.js";

/** The state and actions returned by {@link useSecureSafetyNumber}. */
export interface UseSecureSafetyNumberValues {
  /** The derived safety number, or `null` until ready / when the conversation is not a resolvable DM. */
  safetyNumber: SafetyNumber | null;
  /** True while the number is being (re)computed. */
  loading: boolean;
  /** The last error from resolving the roster or computing, or `null`. */
  error: unknown;
  /** Force a recompute (e.g. after the user re-verifies). */
  refresh: () => void;
}

/**
 * Compute the out-of-band key-verification safety number for a direct-message conversation.
 *
 * Resolves the conversation's MLS group, reads its two members' public signature keys, and derives a
 * symmetric {@link SafetyNumber}. Recomputes when the conversation's group handle advances (e.g. a
 * processed Commit changes the roster). Returns `safetyNumber: null` when the group is unresolved or is
 * not a 2-member DM.
 *
 * @param conversationId - The conversation to compute the safety number for.
 * @returns {@link UseSecureSafetyNumberValues}.
 *
 * @example
 * ```tsx
 * const { safetyNumber } = useSecureSafetyNumber(conversationId);
 * // render safetyNumber?.groups for the user to compare with their peer
 * ```
 */
export function useSecureSafetyNumber(conversationId: string): UseSecureSafetyNumberValues {
  const { crypto, repo, resolveGroup, getGroupVersion, subscribeGroupChange } = useSecureChat();

  const [safetyNumber, setSafetyNumber] = useState<SafetyNumber | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);

  // Recompute when this conversation's group handle advances (a roster change), without diffing handles.
  const [groupVersion, setGroupVersion] = useState(0);
  useEffect(() => {
    return subscribeGroupChange(() => setGroupVersion(getGroupVersion(conversationId)));
  }, [subscribeGroupChange, getGroupVersion, conversationId]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // Guards the per-run state writes against an out-of-date async resolve (conversation switch / unmount).
  const runIdRef = useRef(0);

  useEffect(() => {
    const runId = ++runIdRef.current;
    setLoading(true);
    setError(null);
    (async () => {
      const group = await resolveGroup(conversationId);
      if (!group) return null;
      const [persisted, members] = await Promise.all([
        repo.loadDevice(),
        crypto.exportGroupIdentities(group),
      ]);
      // DM only: need exactly the local device + one peer. Anything else → no safety number.
      if (members.length !== 2 || !persisted) return null;
      const local = members.find((m) => m.deviceId === persisted.deviceId);
      const remote = members.find((m) => m.deviceId !== persisted.deviceId);
      if (!local || !remote) return null;
      return computeSafetyNumber(local, remote);
    })()
      .then((sn) => {
        if (runIdRef.current === runId) {
          setSafetyNumber(sn);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (runIdRef.current === runId) {
          setError(err);
          setSafetyNumber(null);
          setLoading(false);
        }
      });
  }, [crypto, repo, resolveGroup, conversationId, groupVersion, tick]);

  return { safetyNumber, loading, error, refresh };
}
