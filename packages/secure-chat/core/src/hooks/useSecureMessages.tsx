// useSecureMessages — load, decrypt, send, and live-receive messages in a secure conversation.
//
// Self-sufficient once a store is wired: the MLS GroupHandle is auto-resolved from persistence via
// resolveGroup, and senderDeviceId is read from the persisted device. Both stay overridable through
// options for advanced use. Without a resolvable handle, ciphertext is still listed/received
// (plaintext: null) and sending is disabled.

import { useCallback, useEffect, useRef, useState } from "react";
import { SecureMessageModel } from "../contract/index.js";
import {
  GroupHandle,
  SecureChatDecryptError,
  type SecureDecryptFailureReason,
} from "@agora-sdk/secure-chat-crypto";
import { toBase64, fromBase64, utf8ToBytes, bytesToUtf8 } from "../util/base64.js";
import { padPlaintext, unpadPlaintext } from "../util/padding.js";
import { createDebugLogger } from "../util/debug.js";
import { useSecureChat } from "../context/secure-chat-context.js";

const log = createDebugLogger("messages");

/**
 * Decryption outcome for a stored message:
 * - `ok` — decrypted + authenticated; `plaintext` is set.
 * - `pending` — not decryptable yet (no group handle, or the message's epoch is ahead of ours); it will
 *   be retried when the group advances. `plaintext` is null.
 * - `rejected` — fails closed: the MLS core rejected it (replay, over-window gap, bad auth, malformed,
 *   too-old epoch). NEVER retried; `plaintext` is null and `rejectedReason` says why.
 */
export type SecureMessageStatus = "ok" | "pending" | "rejected";

/** A stored message paired with its decryption outcome. */
export interface DecryptedSecureMessage {
  /** The raw message row from the server (still holds the base64 ciphertext). */
  model: SecureMessageModel;
  /** Decrypted text, or null when {@link DecryptedSecureMessage.status} is `pending` or `rejected`. */
  plaintext: string | null;
  /** Decryption outcome — drives fail-closed handling and what the UI renders. */
  status: SecureMessageStatus;
  /** When `status` is `rejected`, why the MLS core refused the message. */
  rejectedReason?: SecureDecryptFailureReason;
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
 * Merge two copies of the SAME message (same id) seen via different paths (REST load, retry, live
 * echo), keeping the more-resolved one. A row's status may only ever IMPROVE.
 *
 * This is load-bearing for E2EE correctness, not just de-dup hygiene: MLS application-message keys are
 * single-use (forward secrecy), so the ONE decrypt attempt that succeeds is the only one that ever
 * will — that attempt also *consumes* the key, so a later re-attempt necessarily fails. If a message
 * is loaded as `pending` (group not resolved yet) and then the live echo decrypts it `ok`, naively
 * "keep the first-seen row" would discard the only successful decryption and strand the message on
 * "waiting for key update" forever. So `ok` always wins; a failed re-attempt (`pending`/`rejected`)
 * must never overwrite an `ok`; otherwise keep the existing row (the retry effect handles `pending`).
 *
 * @param existing - The row already in state.
 * @param incoming - A freshly-produced row for the same message id.
 * @returns Whichever row is more resolved (`ok` \> anything; else `existing`).
 */
function preferResolved(
  existing: DecryptedSecureMessage,
  incoming: DecryptedSecureMessage
): DecryptedSecureMessage {
  if (existing.status === "ok") return existing; // never downgrade a successful decrypt
  if (incoming.status === "ok") return incoming; // upgrade pending/rejected → ok
  return existing; // both unresolved: keep existing (a `pending` row is retried by the group effect)
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
  const {
    rest,
    crypto,
    socket,
    repo,
    resolveGroup,
    persistGroupState,
    getGroupVersion,
    subscribeGroupChange,
    padding,
  } = useSecureChat();

  const [messages, setMessages] = useState<DecryptedSecureMessage[]>([]);
  const [before, setBefore] = useState<string | undefined>(undefined);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [group, setGroup] = useState<GroupHandle | null>(options.group ?? null);
  const [senderDeviceId, setSenderDeviceId] = useState<string | undefined>(options.senderDeviceId);

  // Bumps when THIS conversation's group handle advances (a join or a processed Commit, driven by
  // useSecureHandshakes calling rememberGroup). Feeds the group-resolve effect's deps so we re-resolve
  // the now-current handle and flush buffered (plaintext:null) rows.
  const [groupVersion, setGroupVersion] = useState(0);

  // Latest messages, read by the "decrypt history once the group resolves" effect below without
  // making `messages` one of its deps (which would loop).
  const messagesRef = useRef<DecryptedSecureMessage[]>(messages);
  messagesRef.current = messages;

  // `decrypt` reads the LIVE group through this ref, not its closure. A message page that finishes
  // loading AFTER the group resolves must decrypt with the now-current handle instead of stranding as
  // `pending` — the load's closure may have captured `group` while it was still null.
  const groupRef = useRef<GroupHandle | null>(group);
  groupRef.current = group;

  // Decrypt-once cache, by message id — the in-memory tier of a TWO-tier store. MLS application keys
  // are SINGLE-USE (forward secrecy): the one decrypt that succeeds consumes the key, so any later
  // attempt fails (`"Desired gen in the past"`). The hook decrypts the same message from several
  // effects (load, retry, live echo) and React StrictMode double-invokes them — so without this cache
  // the key could be consumed on a run whose `ok` result is then discarded, leaving the message
  // permanently un-decryptable. This cache covers within-session repeats; `decrypt` ALSO write-throughs
  // each `ok` to the durable plaintext store (repo.saveMessagePlaintext) so history survives reload
  // without ever replaying the consumed ratchet. Only `ok` is cached (terminal); `pending`/`rejected`
  // stay retryable. Ids are globally-unique server uuids, so this never needs clearing per-conversation.
  const okCache = useRef(new Map<string, DecryptedSecureMessage>());

  // Subscribe to provider group-change signals; only a change to OUR conversation's version updates
  // state (React bails on an unchanged primitive), so unrelated conversations don't re-resolve us.
  useEffect(() => {
    return subscribeGroupChange(() => setGroupVersion(getGroupVersion(conversationId)));
  }, [subscribeGroupChange, getGroupVersion, conversationId]);

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
        if (alive) {
          setGroup(g);
          log.debug("group handle set in messages hook", {
            conversationId,
            resolved: !!g,
            epoch: g?.epoch?.toString(),
          });
        }
      })
      .catch((err) => {
        if (alive) setGroup(null);
        log.debug("group resolve failed in messages hook", {
          conversationId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      alive = false;
    };
    // `groupVersion` re-runs this when a Commit/join advances the handle → flushes buffered rows.
  }, [options.group, conversationId, resolveGroup, groupVersion]);

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
      // Decrypt-once (in-memory tier): a message decoded earlier this session is returned from cache —
      // never re-run the MLS decrypt (its single-use key is already consumed; a second attempt fails).
      const cached = okCache.current.get(model.id);
      if (cached) return cached;
      // Decrypt-once (durable tier): a message decoded in a PRIOR session is served from the local
      // plaintext store. This is what makes history survive reload — the re-imported ratchet can't
      // reproduce a consumed key, so re-decrypting would throw "Desired gen in the past". A store hit
      // therefore must NOT touch the ratchet. (The blind server never sees this plaintext.)
      const stored = await repo.loadMessagePlaintext(conversationId, model.id);
      if (stored !== null) {
        const restored: DecryptedSecureMessage = { model, plaintext: stored, status: "ok" };
        okCache.current.set(model.id, restored);
        return restored;
      }
      // Read the LIVE group via the ref (not a stale closure): a load that finishes after the group
      // resolved must decrypt with the now-current handle, not the null it captured when it started.
      const group = groupRef.current;
      // No handle yet (still resolving) → retryable once it arrives.
      if (!group) {
        log.trace("decrypt deferred — no group handle yet", { messageId: model.id, epoch: model.epoch });
        return { model, plaintext: null, status: "pending" };
      }
      let plaintext: Uint8Array;
      try {
        ({ plaintext } = await crypto.decryptMessage(group, fromBase64(model.ciphertext)));
      } catch (err) {
        // Classify, don't conflate. A message from an epoch we HAVEN'T reached yet is legitimately
        // buffered (a future Commit will advance us, then this re-decrypts). Anything else that fails
        // at an epoch we HAVE reached is a terminal rejection — the MLS core refused it (replay,
        // over-window gap, bad auth, malformed, too-old epoch). Fail closed: never show it as text and
        // never silently retry it forever (the old behavior masked replays/forgeries as "pending").
        if (BigInt(model.epoch) > group.epoch) {
          log.debug("decrypt buffered — message epoch ahead of ours", {
            messageId: model.id,
            messageEpoch: model.epoch,
            groupEpoch: group.epoch.toString(),
          });
          return { model, plaintext: null, status: "pending" };
        }
        const rejectedReason: SecureDecryptFailureReason =
          err instanceof SecureChatDecryptError ? err.reason : "unknown";
        log.debug("decrypt rejected (fail closed)", {
          messageId: model.id,
          messageEpoch: model.epoch,
          groupEpoch: group.epoch.toString(),
          rejectedReason,
        });
        return { model, plaintext: null, status: "rejected", rejectedReason };
      }
      // Decrypt + MLS authentication succeeded, so the bytes are from a real group member. Strip the
      // size-bucket padding frame (see util/padding). A bad frame here is NOT a decrypt failure — it's a
      // framing/version mismatch from an authenticated sender — so fail closed as "malformed" rather
      // than rendering raw padded bytes as text.
      let text: string;
      try {
        text = bytesToUtf8(unpadPlaintext(plaintext));
      } catch {
        return { model, plaintext: null, status: "rejected", rejectedReason: "malformed" };
      }
      const ok: DecryptedSecureMessage = { model, plaintext: text, status: "ok" };
      okCache.current.set(model.id, ok); // cache the (single) successful decode for all later callers
      // Write-through to the durable store so this decode survives reload, and persist the now-advanced
      // RECEIVE ratchet: decrypt moved the group's generation in memory, so if we don't persist it a
      // reload rewinds the ratchet and the next send/receive desyncs. Persist plaintext FIRST — if the
      // group-state write somehow fails, the message is still recoverable from the plaintext store.
      await repo.saveMessagePlaintext(conversationId, model.id, text);
      await persistGroupState(conversationId, group);
      return ok;
    },
    [crypto, repo, conversationId, persistGroupState]
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
        // Server returns created_at DESC; keep newest-first in state. Merge by id when appending an
        // older page: a row already in state (one that arrived live, or an overlap at the page
        // boundary) must not be appended twice (duplicate React key) — but if this page decrypted a row
        // we're still holding as `pending`, UPGRADE it in place rather than dropping the decode (same
        // forward-secrecy reasoning as the live path). `reset` replaces wholesale.
        setMessages((prev) => {
          if (reset) return decrypted;
          const indexById = new Map(prev.map((p, idx) => [p.model.id, idx]));
          const next = prev.slice();
          const appended: DecryptedSecureMessage[] = [];
          for (const m of decrypted) {
            const idx = indexById.get(m.model.id);
            if (idx === undefined) appended.push(m);
            else next[idx] = preferResolved(next[idx]!, m);
          }
          return [...next, ...appended];
        });
        log.debug("loaded message page", {
          conversationId,
          reset,
          before: reset ? undefined : before,
          count: decrypted.length,
          hasMore: page.hasMore,
          ok: decrypted.filter((m) => m.status === "ok").length,
          pending: decrypted.filter((m) => m.status === "pending").length,
          rejected: decrypted.filter((m) => m.status === "rejected").length,
        });
      } catch (err) {
        log.debug("load message page failed", {
          conversationId,
          error: err instanceof Error ? err.message : String(err),
        });
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
      // Pad the plaintext to a size bucket BEFORE encryption so the ciphertext length leaks less
      // (the receiver strips the frame in `decrypt`). See util/padding for the framing.
      const { ciphertext, epoch } = await crypto.encryptMessage(
        group,
        padPlaintext(utf8ToBytes(text), padding)
      );
      // The send ratchet just advanced in memory. Persist NOW — BEFORE the network send — because the
      // ratchet moved regardless of whether the send succeeds. If we skipped this, a reload would
      // re-import the last-committed state, rewind the send ratchet to a consumed generation, and the
      // peer would reject our next message as a replay (the exact bug this fixes). A failed network
      // send instead leaves at most a one-generation forward gap, which the peer tolerates within its
      // key-retention window — fail-safe-forward, never a replay.
      await persistGroupState(conversationId, group);
      const sent = await rest.sendMessage(conversationId, {
        ciphertext: toBase64(ciphertext),
        epoch: epoch.toString(),
        senderDeviceId,
      });
      // Persist our own plaintext: we can't re-decrypt our own single-use MLS message after reload (and
      // the server's echo of it self-rejects), so without this our own history would blank on reload.
      await repo.saveMessagePlaintext(conversationId, sent.id, text);
      log.debug("sent message", {
        conversationId,
        messageId: sent.id,
        epoch: epoch.toString(),
        senderDeviceId,
      });
      // Optimistic: we know our own plaintext without a round-trip through decrypt. Dedup by id while
      // prepending: the server echoes this same row back over `secure:message`, and a sender can't
      // decrypt their own MLS message, so that echo decrypts as `rejected`. If the echo wins the race
      // against this HTTP response it's already in `prev` — drop it and keep this authoritative `ok`
      // copy, so the list never holds two rows with the same id (React duplicate-key) and the user
      // never sees their own message as `rejected`. (The live-receive path dedups the other ordering.)
      setMessages((prev) => [
        { model: sent, plaintext: text, status: "ok" },
        ...prev.filter((p) => p.model.id !== sent.id),
      ]);
    },
    [crypto, rest, repo, conversationId, group, senderDeviceId, padding, persistGroupState]
  );

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  // Re-decrypt buffered rows when the group handle advances. On reload the first page loads while
  // resolveGroup is still in flight (those rows come back `pending`); a Commit/join also advances the
  // epoch, letting previously-ahead rows decrypt. Retry ONLY `pending` rows — never `rejected` ones, so
  // a replay/forgery the core already refused isn't retried on every epoch bump. `ok` rows are kept.
  useEffect(() => {
    if (!group) return;
    if (!messagesRef.current.some((m) => m.status === "pending")) return;
    let alive = true;
    Promise.all(
      messagesRef.current.map((m) => (m.status === "pending" ? decrypt(m.model) : Promise.resolve(m)))
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
        setMessages((prev) => {
          const i = prev.findIndex((p) => p.model.id === m.model.id);
          if (i === -1) {
            log.debug("live message received", {
              conversationId,
              messageId: m.model.id,
              status: m.status,
            });
            return [m, ...prev];
          }
          // Already present (e.g. loaded as `pending` before the group resolved): keep the more-resolved
          // copy in place — NEVER drop this `ok` for a stale `pending`. The decrypt above consumed the
          // single-use MLS key, so this may be the only successful decode the message ever gets.
          const merged = preferResolved(prev[i]!, m);
          if (merged === prev[i]!) {
            log.trace("live message deduped (kept existing)", { messageId: m.model.id, status: prev[i]!.status });
            return prev;
          }
          log.debug("live message upgraded", { conversationId, messageId: m.model.id, status: merged.status });
          const next = prev.slice();
          next[i] = merged;
          return next;
        })
      );
    });
    return off;
  }, [socket, conversationId, decrypt]);

  return { messages, loading, hasMore, error, loadMore, refresh, sendMessage };
}
