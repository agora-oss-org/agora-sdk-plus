// useSecureMessages — load, decrypt, send, and live-receive messages in a secure conversation.
//
// Encryption/decryption runs through the injected `SecureChatCrypto` against the conversation's MLS
// `GroupHandle`. Resolving conversationId → GroupHandle is owned by the platform persistence layer
// (Phase 2: IndexedDB group state via processWelcome/importGroupState), so the caller passes the
// handle in. Without it, ciphertext is still listed/received but left undecrypted (`plaintext: null`)
// and sending is disabled — keeping the transport usable ahead of the crypto wiring.

import { useCallback, useEffect, useState } from "react";
import { SecureMessageModel } from "../contract/index.js";
import { GroupHandle } from "@agora-sdk/secure-chat-crypto";
import { toBase64, fromBase64, utf8ToBytes, bytesToUtf8 } from "../util/base64.js";
import { useSecureChat } from "../context/secure-chat-context.js";

/** A stored message paired with its decrypted text (when a group handle is available). */
export interface DecryptedSecureMessage {
  /** The raw message row from the server (still holds the base64 ciphertext). */
  model: SecureMessageModel;
  /** Decrypted text, or null when no group handle is available or decryption is pending/failed. */
  plaintext: string | null;
}

/** Options for {@link useSecureMessages}. */
export interface UseSecureMessagesOptions {
  /** The MLS group handle for this conversation (from the platform persistence layer). */
  group?: GroupHandle;
  /** The caller's device row id — required to send (the server verifies it belongs to the caller). */
  senderDeviceId?: string;
}

/** The state and actions returned by {@link useSecureMessages}. */
export interface UseSecureMessagesValues {
  /** Loaded messages, newest first, each with decrypted text when possible. */
  messages: DecryptedSecureMessage[];
  /** True while a page load or refresh is in flight. */
  loading: boolean;
  /** Whether older messages remain to {@link UseSecureMessagesValues.loadMore}. */
  hasMore: boolean;
  /** The last error thrown by loading or sending, or `null`. */
  error: unknown;
  /** Append the next page of older messages. No-op when already loading or exhausted. */
  loadMore: () => Promise<void>;
  /** Reload from the newest message, replacing the current list. */
  refresh: () => Promise<void>;
  /** Encrypt + send a text message. Requires `group` + `senderDeviceId`. */
  sendMessage: (text: string) => Promise<void>;
}

/**
 * Load, decrypt, send, and live-receive messages in one secure conversation.
 *
 * Decryption runs through the injected `SecureChatCrypto` against the conversation's MLS
 * `GroupHandle`. Without a `group` in `options`, ciphertext is still listed and received (as
 * `plaintext: null`) and sending is disabled — letting the transport work ahead of the crypto
 * wiring. Joins the conversation's socket room to receive `secure:message` events live.
 *
 * @param conversationId - The conversation to read and send within.
 * @param options - {@link UseSecureMessagesOptions} — the MLS `group` handle and `senderDeviceId`.
 * @returns {@link UseSecureMessagesValues} — the message list, paging state, and `sendMessage`.
 *
 * @example
 * ```tsx
 * const { messages, sendMessage } = useSecureMessages(conversationId, { group, senderDeviceId });
 * await sendMessage("hello 💜");
 * ```
 */
export function useSecureMessages(
  conversationId: string,
  options: UseSecureMessagesOptions = {}
): UseSecureMessagesValues {
  const { rest, crypto, socket } = useSecureChat();
  const { group, senderDeviceId } = options;

  const [messages, setMessages] = useState<DecryptedSecureMessage[]>([]);
  const [before, setBefore] = useState<string | undefined>(undefined);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const decrypt = useCallback(
    async (model: SecureMessageModel): Promise<DecryptedSecureMessage> => {
      if (!group) return { model, plaintext: null };
      try {
        const { plaintext } = await crypto.decryptMessage(group, fromBase64(model.ciphertext));
        return { model, plaintext: bytesToUtf8(plaintext) };
      } catch {
        // Buffer/skip: epoch not yet reached, or undecryptable. Surface ciphertext without text.
        return { model, plaintext: null };
      }
    },
    [crypto, group]
  );

  const load = useCallback(
    async (reset: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const page = await rest.listMessages(conversationId, {
          before: reset ? undefined : before,
          limit: 40,
        });
        const decrypted = await Promise.all(page.messages.map(decrypt));
        const oldest = page.messages[page.messages.length - 1];
        setBefore(oldest ? oldest.createdAt : before);
        setHasMore(page.hasMore);
        // Server returns created_at DESC; keep newest-first in state.
        setMessages((prev) => (reset ? decrypted : [...prev, ...decrypted]));
      } catch (err) {
        setError(err);
      } finally {
        setLoading(false);
      }
    },
    [rest, conversationId, before, decrypt]
  );

  const refresh = useCallback(async () => {
    setBefore(undefined);
    await load(true);
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!hasMore || loading) return;
    await load(false);
  }, [hasMore, loading, load]);

  const sendMessage = useCallback(
    async (text: string): Promise<void> => {
      if (!group) throw new Error("Cannot send: no MLS group handle for this conversation.");
      if (!senderDeviceId) throw new Error("Cannot send: senderDeviceId is required.");
      const { ciphertext, epoch } = await crypto.encryptMessage(group, utf8ToBytes(text));
      const sent = await rest.sendMessage(conversationId, {
        ciphertext: toBase64(ciphertext),
        epoch: epoch.toString(),
        senderDeviceId,
      });
      // Optimistic: we know our own plaintext without a round-trip through decrypt.
      setMessages((prev) => [{ model: sent, plaintext: text }, ...prev]);
    },
    [crypto, rest, conversationId, group, senderDeviceId]
  );

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  // Live receive: join the conversation room and decrypt inbound ciphertext.
  useEffect(() => {
    socket.joinConversation(conversationId);
    const off = socket.on("secure:message", (model) => {
      if (model.conversationId !== conversationId) return;
      decrypt(model).then((m) =>
        setMessages((prev) =>
          prev.some((p) => p.model.id === m.model.id) ? prev : [m, ...prev]
        )
      );
    });
    return off;
  }, [socket, conversationId, decrypt]);

  return { messages, loading, hasMore, error, loadMore, refresh, sendMessage };
}
