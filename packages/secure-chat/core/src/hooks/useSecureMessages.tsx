// useSecureMessages — load, decrypt, send, and live-receive MIMI-content messages in a secure conversation.
//
// Content is the IETF MimiContent format (CBOR) inside a [kind][payload] routing frame inside the
// size-bucket padding frame — all ABOVE the unchanged SecureChatCrypto seam (which still exchanges
// Uint8Array). The hook owns message-list STATE (dedup, ordering, decrypt-once, write-through) keyed by
// server messageId; a MessageFold collapses reaction/edit/delete/un-react messages onto their target by
// MIMI content-hash. The durable source of truth stays REST; realtime is a notification optimization.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { SecureMessageModel } from "../contract/index.js";
import {
  GroupHandle,
  SecureChatDecryptError,
  type SecureDecryptFailureReason,
} from "@agora-sdk/secure-chat-crypto";
import { toBase64, fromBase64 } from "../util/base64.js";
import { padPlaintext, unpadPlaintext } from "../util/padding.js";
import { createDebugLogger } from "../util/debug.js";
import { useSecureChat } from "../context/secure-chat-context.js";
import { frameContent, unframe, ContentKind } from "../content/frame.js";
import {
  encodeMimiContent, decodeMimiContent, contentHash, type MimiContent,
} from "../content/mimi-content.js";
import {
  buildPost, buildReply, buildEdit, buildDelete, buildReaction, buildUnreact,
} from "../content/builders.js";
import {
  MessageFold, type DecodedContentMessage, type RenderedContent,
} from "./message-fold.js";

const log = createDebugLogger("messages");

/**
 * Decryption outcome for a stored message:
 * - `ok` — decrypted + authenticated + decoded; `content`/`mimi`/`contentHash` are set (unless it is a
 *   folded mutation, which the list omits, or a reserved control frame, which is hidden).
 * - `pending` — not decryptable yet (no handle, or epoch ahead). Retried when the group advances.
 * - `rejected` — fails closed (replay/gap/bad-auth/malformed/too-old, or undecodable content). Never retried.
 */
export type SecureMessageStatus = "ok" | "pending" | "rejected";

/** A stored message paired with its decoded, folded content. */
export interface DecryptedSecureMessage {
  /** The raw message row from the server (still holds the base64 ciphertext). */
  model: SecureMessageModel;
  /** The Tier-2 projection (body/replyTo/editedAt/deleted/reactions), or `null` when not `ok`. */
  content: RenderedContent | null;
  /** The raw decoded `MimiContent` (power users), or `null` when not `ok`. */
  mimi: MimiContent | null;
  /** SHA-256 content-hash — reference this to reply/react/edit/delete — or `null` when not `ok`. */
  contentHash: Uint8Array | null;
  /** Decryption outcome. */
  status: SecureMessageStatus;
  /** When `status` is `rejected`, why. */
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
  /** Rendered messages (post/reply rows with folded reactions/edits/deletes), newest first. */
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
  /** Encrypt + send a text post. */
  sendMessage: (text: string) => Promise<void>;
  /** Send a reply to the message with `targetHash` (its {@link DecryptedSecureMessage.contentHash}). */
  reply: (targetHash: Uint8Array, text: string) => Promise<void>;
  /** React to the message with `targetHash` using `token` (e.g. an emoji). */
  react: (targetHash: Uint8Array, token: string) => Promise<void>;
  /** Edit the message with `targetHash`, replacing its body with `text`. */
  editMessage: (targetHash: Uint8Array, text: string) => Promise<void>;
  /** Delete (tombstone) the message with `targetHash`. */
  deleteMessage: (targetHash: Uint8Array) => Promise<void>;
  /** Withdraw your reaction whose own content-hash is `reactionHash`. */
  unreact: (reactionHash: Uint8Array) => Promise<void>;
}

/** Per-message decode outcome, internal to the hook. */
type DecodedOutcome =
  | { status: "ok"; control: true }
  | { status: "ok"; control: false; decoded: DecodedContentMessage }
  | { status: "pending" }
  | { status: "rejected"; rejectedReason: SecureDecryptFailureReason };

const REJECT_MALFORMED: DecodedOutcome = { status: "rejected", rejectedReason: "malformed" };

/** Decode a content-frame to a typed outcome. Pure; fails closed on any framing/schema error. */
function decodeFrame(
  frameBytes: Uint8Array,
  model: SecureMessageModel,
  senderDeviceId: string
): DecodedOutcome {
  let unf: { kind: number; payload: Uint8Array };
  try {
    unf = unframe(frameBytes);
  } catch {
    return REJECT_MALFORMED;
  }
  // kind 1 = IUC control (reserved; out of scope here): authenticate + hide, never render, never error.
  if (unf.kind === ContentKind.IucControl) return { status: "ok", control: true };
  if (unf.kind !== ContentKind.Mimi) return REJECT_MALFORMED;
  let mimi: MimiContent;
  try {
    mimi = decodeMimiContent(unf.payload);
  } catch {
    return REJECT_MALFORMED;
  }
  return {
    status: "ok",
    control: false,
    decoded: {
      messageId: model.id,
      createdAt: model.createdAt,
      senderDeviceId,
      contentHash: contentHash(mimi),
      mimi,
    },
  };
}

interface Entry {
  model: SecureMessageModel;
  status: SecureMessageStatus;
  /** True only for a post/reply (visible) row; false for folded mutations and control frames. */
  renderable: boolean;
  decoded?: DecodedContentMessage;
  rejectedReason?: SecureDecryptFailureReason;
}

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Load, decrypt, send, and live-receive MIMI-content messages in one secure conversation.
 *
 * @param conversationId - The conversation to read and send within.
 * @param options - {@link UseSecureMessagesOptions}.
 * @returns {@link UseSecureMessagesValues}.
 *
 * @example
 * ```tsx
 * const { messages, sendMessage, react } = useSecureMessages(conversationId);
 * await sendMessage("hello 💜");
 * await react(messages[0].contentHash!, "👍");
 * ```
 */
export function useSecureMessages(
  conversationId: string,
  options: UseSecureMessagesOptions = {}
): UseSecureMessagesValues {
  const {
    rest, crypto, socket, repo, resolveGroup, persistGroupState,
    getGroupVersion, subscribeGroupChange, padding,
  } = useSecureChat();

  const [before, setBefore] = useState<string | undefined>(undefined);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [group, setGroup] = useState<GroupHandle | null>(options.group ?? null);
  const [senderDeviceId, setSenderDeviceId] = useState<string | undefined>(options.senderDeviceId);
  const [groupVersion, setGroupVersion] = useState(0);

  // Rendered state lives in refs (the fold mutates target rows in place); `bump` forces a re-derive.
  const byIdRef = useRef(new Map<string, Entry>());
  const foldRef = useRef(new MessageFold());
  // Decrypt-once cache by id: MLS application keys are single-use, so the one decrypt that succeeds is
  // the only one that ever will. Survives StrictMode double-invokes and multi-effect decrypts.
  const okCache = useRef(new Map<string, DecodedOutcome>());
  const [version, bump] = useReducer((x: number) => x + 1, 0);

  const groupRef = useRef<GroupHandle | null>(group);
  groupRef.current = group;

  useEffect(() => {
    return subscribeGroupChange(() => setGroupVersion(getGroupVersion(conversationId)));
  }, [subscribeGroupChange, getGroupVersion, conversationId]);

  // Resolve the group handle: explicit override, else persisted state. (Same as before.)
  useEffect(() => {
    if (options.group) {
      setGroup(options.group);
      return;
    }
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
  }, [options.group, conversationId, resolveGroup, groupVersion]);

  // Resolve the sender device id: explicit override, else persisted device row. (Same as before.)
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

  // Decrypt one message to a typed outcome. Two short-circuits BEFORE the single-use ratchet: the
  // in-memory okCache and the durable content-frame store. A store/cache hit re-decodes locally and
  // NEVER touches the ratchet (re-decrypting a consumed key throws "Desired gen in the past").
  const decrypt = useCallback(
    async (model: SecureMessageModel): Promise<DecodedOutcome> => {
      const cached = okCache.current.get(model.id);
      if (cached) return cached;
      const storedFrame = await repo.loadMessageContent(conversationId, model.id);
      if (storedFrame !== null) {
        // The frame was already authenticated when first decrypted (and write-through only happens on an
        // `ok` decrypt). The server-reported senderDeviceId is just a render label here; coalesce its
        // possible null to "" so the fold's DecodedContentMessage stays a plain string.
        const outcome = decodeFrame(storedFrame, model, model.senderDeviceId ?? "");
        if (outcome.status === "ok") okCache.current.set(model.id, outcome);
        return outcome;
      }
      const grp = groupRef.current;
      if (!grp) return { status: "pending" };
      let plaintext: Uint8Array;
      let sender: string;
      try {
        ({ plaintext, senderDeviceId: sender } = await crypto.decryptMessage(grp, fromBase64(model.ciphertext)));
      } catch (err) {
        if (BigInt(model.epoch) > grp.epoch) return { status: "pending" }; // epoch ahead → buffer
        const rejectedReason: SecureDecryptFailureReason =
          err instanceof SecureChatDecryptError ? err.reason : "unknown";
        return { status: "rejected", rejectedReason };
      }
      let frameBytes: Uint8Array;
      try {
        frameBytes = unpadPlaintext(plaintext); // authenticated sender, bad padding ⇒ malformed (fail closed)
      } catch {
        return REJECT_MALFORMED;
      }
      const outcome = decodeFrame(frameBytes, model, sender);
      if (outcome.status === "ok") {
        okCache.current.set(model.id, outcome);
        // Write-through the raw content-frame bytes (re-decoded + re-folded on reload), then persist the
        // advanced RECEIVE ratchet (decrypt moved the generation in memory; a reload must not rewind it).
        await repo.saveMessageContent(conversationId, model.id, frameBytes);
        await persistGroupState(conversationId, grp);
      }
      return outcome;
    },
    [crypto, repo, conversationId, persistGroupState]
  );

  // Fold one outcome into rendered state. `ok` is terminal (never downgraded — forward secrecy).
  const ingest = useCallback((model: SecureMessageModel, outcome: DecodedOutcome) => {
    const entries = byIdRef.current;
    const prev = entries.get(model.id);
    if (prev?.status === "ok") return;
    if (outcome.status === "ok") {
      if (outcome.control) {
        entries.set(model.id, { model, status: "ok", renderable: false });
      } else {
        const { renderable } = foldRef.current.apply(outcome.decoded);
        entries.set(model.id, { model, status: "ok", renderable, decoded: outcome.decoded });
      }
    } else if (outcome.status === "pending") {
      if (!prev) entries.set(model.id, { model, status: "pending", renderable: false });
    } else {
      if (!prev || prev.status === "pending")
        entries.set(model.id, { model, status: "rejected", renderable: false, rejectedReason: outcome.rejectedReason });
    }
    bump();
  }, []);

  // Derive the rendered list: only renderable (post/reply) rows + non-ok rows, newest-first. Mutation
  // and control rows are folded/hidden. Recomputed on every `bump` (fold mutates rows in place).
  const messages = useMemo<DecryptedSecureMessage[]>(() => {
    const rows: DecryptedSecureMessage[] = [];
    for (const e of byIdRef.current.values()) {
      if (e.status === "ok") {
        if (!e.renderable) continue;
        rows.push({
          model: e.model,
          content: foldRef.current.getContent(e.model.id),
          mimi: e.decoded?.mimi ?? null,
          contentHash: e.decoded?.contentHash ?? null,
          status: "ok",
        });
      } else {
        rows.push({ model: e.model, content: null, mimi: null, contentHash: null, status: e.status, rejectedReason: e.rejectedReason });
      }
    }
    rows.sort((a, b) => cmpStr(b.model.createdAt, a.model.createdAt) || cmpStr(b.model.id, a.model.id));
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const load = useCallback(
    async (reset: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const page = await rest.listMessages(conversationId, { before: reset ? undefined : before, limit: 40 });
        if (reset) {
          byIdRef.current.clear();
          foldRef.current.reset();
        }
        const oldest = page.messages[page.messages.length - 1];
        setBefore(oldest ? oldest.createdAt : before);
        setHasMore(page.hasMore);
        for (const model of page.messages) ingest(model, await decrypt(model));
        bump();
        log.debug("loaded message page", { conversationId, reset, count: page.messages.length, hasMore: page.hasMore });
      } catch (err) {
        setError(err);
      } finally {
        setLoading(false);
      }
    },
    [rest, conversationId, before, decrypt, ingest]
  );

  const refresh = useCallback(async () => {
    setBefore(undefined);
    await load(true);
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!hasMore || loading) return;
    await load(false);
  }, [hasMore, loading, load]);

  // Shared send: encode → frame → pad → encrypt → persist ratchet → POST → persist content → optimistic.
  const sendContent = useCallback(
    async (mimi: MimiContent): Promise<void> => {
      if (!group) throw new Error("Cannot send: no MLS group handle for this conversation.");
      if (!senderDeviceId) throw new Error("Cannot send: senderDeviceId is required.");
      const frame = frameContent(ContentKind.Mimi, encodeMimiContent(mimi));
      const { ciphertext, epoch } = await crypto.encryptMessage(group, padPlaintext(frame, padding));
      // Persist the advanced SEND ratchet BEFORE the network send (it moved regardless of success).
      await persistGroupState(conversationId, group);
      const sent = await rest.sendMessage(conversationId, {
        ciphertext: toBase64(ciphertext),
        epoch: epoch.toString(),
        senderDeviceId,
      });
      await repo.saveMessageContent(conversationId, sent.id, frame);
      // Optimistic: we can't decrypt our own MLS message, so seed the decoded content directly and cache
      // it so the server echo short-circuits (no rejected flicker).
      const decoded: DecodedContentMessage = {
        messageId: sent.id, createdAt: sent.createdAt, senderDeviceId, contentHash: contentHash(mimi), mimi,
      };
      const outcome: DecodedOutcome = { status: "ok", control: false, decoded };
      okCache.current.set(sent.id, outcome);
      ingest(sent, outcome);
      log.debug("sent content", { conversationId, messageId: sent.id, epoch: epoch.toString() });
    },
    [crypto, rest, repo, conversationId, group, senderDeviceId, padding, persistGroupState, ingest]
  );

  const sendMessage = useCallback((text: string) => sendContent(buildPost(text)), [sendContent]);
  const reply = useCallback((t: Uint8Array, text: string) => sendContent(buildReply(text, t)), [sendContent]);
  const react = useCallback((t: Uint8Array, token: string) => sendContent(buildReaction(t, token)), [sendContent]);
  const editMessage = useCallback((t: Uint8Array, text: string) => sendContent(buildEdit(t, text)), [sendContent]);
  const deleteMessage = useCallback((t: Uint8Array) => sendContent(buildDelete(t)), [sendContent]);
  const unreact = useCallback((reactionHash: Uint8Array) => sendContent(buildUnreact(reactionHash)), [sendContent]);

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  // Retry non-ok rows when the group handle advances. Covers `pending` (buffered ahead-of-epoch) AND
  // `rejected`: a row can settle to `rejected` when a message is decrypted in the narrow window where the
  // group handle is still mid-swap (e.g. right after a reload processes a fresh Welcome) — decryptMessage
  // throws while `grp` is stale, and since the epoch isn't ahead it isn't buffered. A reload delivers the
  // message only once (via load), so there is no second live event to rescue it (the live-receive upgrade
  // path). Re-attempting on group-advance closes that gap. Fail-closed is preserved: a genuinely bad
  // message (replay/gap/bad-auth/tamper) simply re-throws and stays `rejected` — re-decrypting never
  // yields plaintext for it, and an already-`ok` row is terminal and never re-touched.
  useEffect(() => {
    if (!group) return;
    const retryModels = [...byIdRef.current.values()]
      .filter((e) => e.status === "pending" || e.status === "rejected")
      .map((e) => e.model);
    if (retryModels.length === 0) return;
    let alive = true;
    (async () => {
      for (const m of retryModels) {
        const outcome = await decrypt(m);
        if (!alive) return;
        ingest(m, outcome);
      }
    })();
    return () => {
      alive = false;
    };
  }, [group, decrypt, ingest]);

  // Live receive: join the conversation room and decrypt+ingest inbound ciphertext.
  useEffect(() => {
    socket.joinConversation(conversationId);
    const off = socket.on("secure:message", (model) => {
      if (model.conversationId !== conversationId) return;
      decrypt(model).then((outcome) => ingest(model, outcome));
    });
    return off;
  }, [socket, conversationId, decrypt, ingest]);

  return {
    messages, loading, hasMore, error, loadMore, refresh,
    sendMessage, reply, react, editMessage, deleteMessage, unreact,
  };
}
