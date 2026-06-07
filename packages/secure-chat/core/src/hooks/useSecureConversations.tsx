// useSecureConversations — list the caller's secure conversations and start new DMs.
//
// Starting a DM (server spec §14.3): claim each peer device's KeyPackage → createGroup locally →
// POST /conversations with the Welcomes targeted to each peer device. The MLS group secrets stay on
// the client; the server only stores ciphertext metadata.

import { useCallback, useEffect, useState } from "react";
import { SecureConversationModel } from "../contract/index.js";
import { toBase64, fromBase64 } from "../util/base64.js";
import { useSecureChat } from "../context/secure-chat-context.js";

/** The state and actions returned by {@link useSecureConversations}. */
export interface UseSecureConversationsValues {
  /** The loaded conversations, newest activity first. */
  conversations: SecureConversationModel[];
  /** True while a page load or refresh is in flight. */
  loading: boolean;
  /** Whether more pages remain to {@link UseSecureConversationsValues.loadMore}. */
  hasMore: boolean;
  /** The last error thrown by loading or conversation creation, or `null`. */
  error: unknown;
  /** Append the next page of older conversations. No-op when already loading or exhausted. */
  loadMore: () => Promise<void>;
  /** Reload from the top, replacing the current list. */
  refresh: () => Promise<void>;
  /** Start (or surface) a 1:1 conversation with another user across all their devices. */
  createDirectConversation: (peerUserId: string) => Promise<SecureConversationModel>;
}

/**
 * List the caller's secure conversations and start new direct messages.
 *
 * Refreshes on mount and on `secure:member:joined` / `secure:member:left` signals.
 * {@link UseSecureConversationsValues.createDirectConversation} claims one KeyPackage per peer
 * device, builds the MLS group locally, and registers it on the blind DS with targeted Welcomes —
 * the group secrets never leave the client.
 *
 * @returns {@link UseSecureConversationsValues} — the conversation list, paging state, and actions.
 *
 * @example
 * ```tsx
 * const { conversations, createDirectConversation } = useSecureConversations();
 * await createDirectConversation(peerUserId);
 * ```
 */
export function useSecureConversations(): UseSecureConversationsValues {
  const { rest, crypto, socket } = useSecureChat();

  const [conversations, setConversations] = useState<SecureConversationModel[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(
    async (reset: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const page = await rest.listConversations({
          cursor: reset ? undefined : cursor,
          limit: 30,
        });
        const last = page.conversations[page.conversations.length - 1];
        setCursor(last ? last.lastMessageAt ?? last.createdAt : cursor);
        setHasMore(page.hasMore);
        setConversations((prev) => (reset ? page.conversations : [...prev, ...page.conversations]));
      } catch (err) {
        setError(err);
      } finally {
        setLoading(false);
      }
    },
    [rest, cursor]
  );

  const refresh = useCallback(async () => {
    setCursor(undefined);
    await load(true);
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!hasMore || loading) return;
    await load(false);
  }, [hasMore, loading, load]);

  const createDirectConversation = useCallback(
    async (peerUserId: string): Promise<SecureConversationModel> => {
      // 1. Discover the peer's active devices and claim one KeyPackage per device.
      const peerDevices = await rest.listDevices(peerUserId);
      if (peerDevices.length === 0) {
        throw new Error("Peer has no registered secure-chat devices.");
      }
      const initialMembers = await Promise.all(
        peerDevices.map(async (d) => {
          const claim = await rest.claimKeyPackage(d.id);
          return { deviceId: d.id, keyPackage: fromBase64(claim.keyPackage) };
        })
      );

      // 2. Create the MLS group locally; the crypto layer holds the secrets.
      const { group, welcomes } = await crypto.createGroup({ initialMembers });

      // 3. Register the conversation on the blind DS, relaying the targeted Welcomes.
      const conversation = await rest.createConversation({
        type: "dm",
        mlsGroupId: toBase64(group.mlsGroupId),
        memberUserIds: [peerUserId],
        welcomes: welcomes.map((w) => ({
          targetDeviceId: w.targetDeviceId,
          payload: toBase64(w.payload),
          epoch: group.epoch.toString(),
        })),
      });

      setConversations((prev) => [conversation, ...prev.filter((c) => c.id !== conversation.id)]);
      return conversation;
    },
    [rest, crypto]
  );

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Light realtime refresh on membership changes (metadata-only signals).
  useEffect(() => {
    const offJoined = socket.on("secure:member:joined", () => {
      refresh().catch(setError);
    });
    const offLeft = socket.on("secure:member:left", () => {
      refresh().catch(setError);
    });
    return () => {
      offJoined();
      offLeft();
    };
  }, [socket, refresh]);

  return { conversations, loading, hasMore, error, loadMore, refresh, createDirectConversation };
}
