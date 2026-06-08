// useSecureMessages — load, decrypt, send, and live-receive messages in a secure conversation.
//
// Self-sufficient once a store is wired: the MLS GroupHandle is auto-resolved from persistence via
// resolveGroup, and senderDeviceId is read from the persisted device. Both stay overridable through
// options for advanced use. Without a resolvable handle, ciphertext is still listed/received
// (plaintext: null) and sending is disabled.

import { useCallback, useEffect, useRef, useState } from "react";
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
  /** Override the MLS group handle. Defaults to the persisted handle via `resolveGroup`. */
  group?: GroupHandle;
  /** Override the sender device row id. Defaults to the persisted device's `.id`. */
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
  /** Encrypt + send a text message. Requires a resolvable group + sender device. */
  sendMessage: (text: string) => Promise<void>;
}

/**
 * Load, decrypt, send, and live-receive messages in one secure conversation.
 *
 * Auto-resolves the MLS group handle (via `resolveGroup`) and the sender device id (from the
 * persisted device) unless overridden in `options`. Joins the conversation socket room for live
 * `secure:message` events.
 *
 * @param conversationId - The conversation to read and send within.
 * @param options - {@link UseSecureMessagesOptions}.
 * @returns {@link UseSecureMessagesValues}.
 *
 * @example
 * ```tsx
 * const { messages, sendMessage } = useSecureMessages(conversationId);
 * await sendMessage("hello 💜");
 * ```
 */
export function useSecureMessages(
  conversationId: string,
  options: UseSecureMessagesOptions = {}
): UseSecureMessagesValues {
  const { rest, crypto, socket, repo, resolveGroup } = useSecureChat();

  const [messages, setMessages] = useState<DecryptedSecureMessage[]>([]);
  const [before, setBefore] = useState<string | undefined>(undefined);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [group, setGroup] = useState<GroupHandle | null>(options.group ?? null);
  const [senderDeviceId, setSenderDeviceId] = useState<string | undefined>(options.senderDeviceId);

  // Latest messages, read by the "decrypt history once the group resolves" effect below without
  // making `messages` one of its deps (which would loop).
  const messagesRef = useRef<DecryptedSecureMessage[]>(messages);
  messagesRef.current = messages;

  // Resolve the group handle: explicit override, else persisted state.
  useEffect(() => {
    if (options.group) {
      setGroup(options.group);
      return;
    }
    // Clear any stale handle from the previous conversation before re-resolving, so live messages
    // for the new conversation never decrypt against the old group during the async window.
    setGroup(null);
    let alive = true;
    resolveGroup(conversationId)
      .then((g) => {
        if (alive) setGroup(g);
      })
      .catch(() => {
        if (alive) setGroup(null);
      });
    return () => {
      alive = false;
    };
  }, [options.group, conversationId, resolveGroup]);

  // Resolve the sender device id: explicit override, else persisted device row.
  useEffect(() => {
    if (options.senderDeviceId) {
      setSenderDeviceId(options.senderDeviceId);
      return;
    }
    let alive = true;
    repo
      .loadDevice()
      .then((d) => {
        if (alive) setSenderDeviceId(d?.device?.id ?? undefined);
      })
      .catch(() => {
        if (alive) setSenderDeviceId(undefined);
      });
    return () => {
      alive = false;
    };
  }, [options.senderDeviceId, repo]);

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
      // Assumes the crypto identity is already hydrated (mount `useSecureDevice` under the same
      // provider): the crypto layer tags the sender from the restored device identity, so after a
      // reload the first send must wait for useSecureDevice's importDeviceState to complete.
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

  // Decrypt history that was listed before the group handle resolved. On reload, the first page loads
  // while resolveGroup is still in flight, so those rows come back `plaintext: null`; once the handle
  // arrives (decrypt is recreated with it), re-decrypt the still-undecrypted rows in place — no
  // re-fetch, scroll/pagination preserved.
  useEffect(() => {
    if (!group) return;
    if (!messagesRef.current.some((m) => m.plaintext === null)) return;
    let alive = true;
    Promise.all(
      messagesRef.current.map((m) => (m.plaintext === null ? decrypt(m.model) : Promise.resolve(m)))
    ).then((next) => {
      if (alive) setMessages(next);
    });
    return () => {
      alive = false;
    };
  }, [group, decrypt]);

  // Live receive: join the conversation room and decrypt inbound ciphertext.
  useEffect(() => {
    socket.joinConversation(conversationId);
    const off = socket.on("secure:message", (model) => {
      if (model.conversationId !== conversationId) return;
      decrypt(model).then((m) =>
        setMessages((prev) => (prev.some((p) => p.model.id === m.model.id) ? prev : [m, ...prev]))
      );
    });
    return off;
  }, [socket, conversationId, decrypt]);

  return { messages, loading, hasMore, error, loadMore, refresh, sendMessage };
}
