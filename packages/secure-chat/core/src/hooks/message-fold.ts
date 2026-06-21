// Fold reducer — collapses reaction/edit/delete/un-react MimiContent messages onto their target post.
//
// The hybrid reference model: messages REFERENCE each other by MIMI content-hash (resolved here through
// an in-memory hex(contentHash) → messageId index), while the hook keys STORAGE/ordering/dedup by the
// server messageId. A mutation whose target hasn't been decoded yet (MLS delivery isn't globally
// ordered — a reaction can arrive before its message) is BUFFERED by target-hash and applied the moment
// the target lands ("buffer, never silently drop" — the same fail-closed discipline used for epoch
// ordering). On reload the index rebuilds for free by recomputing contentHash from the stored canonical
// bytes, so no hash→id index is persisted. Pure: no React, no crypto, no I/O.

import { Cardinality, Disposition, type MimiContent, type SinglePart } from "../content/mimi-content.js";

/** A decoded, content-hashed message handed to the fold (the hook computes these post-decrypt). */
export interface DecodedContentMessage {
  /** Server message id (storage/order/dedup key). */
  messageId: string;
  /** Server createdAt (ISO) — used to stamp `editedAt` and for the hook's ordering. */
  createdAt: string;
  /** Authenticated MLS sender device id. */
  senderDeviceId: string;
  /** SHA-256 over the canonical MimiContent bytes (the reference key). */
  contentHash: Uint8Array;
  /** The decoded content. */
  mimi: MimiContent;
}

/** The Tier-2 projection of a rendered (post/reply) message after folding mutations in. */
export interface RenderedContent {
  /** Markdown body, or `null` when deleted (tombstone) or non-text. */
  body: string | null;
  /** The replied-to message's content-hash, or `null`. */
  replyTo: Uint8Array | null;
  /** ISO timestamp of the last applied edit, or `null`. */
  editedAt: string | null;
  /** True when a delete tombstone has folded in. */
  deleted: boolean;
  /** token → count (distinct reaction messages bearing that token). */
  reactions: Record<string, number>;
}

/** Internal mutable row — one per rendered (post/reply) message, projected by {@link MessageFold.getContent}. */
interface Row {
  /** Server message id. */
  messageId: string;
  /** Server createdAt (ISO). */
  createdAt: string;
  /** Authenticated MLS sender device id. */
  senderDeviceId: string;
  /** Current body (mutated by edits; nulled by a delete tombstone). */
  body: string | null;
  /** Reply target's content-hash, or `null`. */
  replyTo: Uint8Array | null;
  /** ISO timestamp of the last applied edit, or `null`. */
  editedAt: string | null;
  /** True once a delete tombstone has folded in. */
  deleted: boolean;
  /** token → set of reaction messageIds (so un-react removes exactly one). */
  reactions: Map<string, Set<string>>;
}

const hex = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
};

function textBody(p: MimiContent["nestedPart"]): string | null {
  if (p.cardinality === Cardinality.Single) return new TextDecoder().decode((p as SinglePart).content);
  return null;
}

type Op =
  | { kind: "post" | "reply"; body: string | null; replyTo: Uint8Array | null }
  | { kind: "edit"; target: Uint8Array; body: string | null }
  | { kind: "delete-or-unreact"; target: Uint8Array }
  | { kind: "reaction"; target: Uint8Array; token: string };

function classify(m: MimiContent): Op {
  const isNull = m.nestedPart.cardinality === Cardinality.Null;
  const isReaction =
    m.nestedPart.cardinality === Cardinality.Single &&
    (m.nestedPart as SinglePart).disposition === Disposition.Reaction;
  if (m.replaces) {
    if (isNull) return { kind: "delete-or-unreact", target: m.replaces };
    return { kind: "edit", target: m.replaces, body: textBody(m.nestedPart) };
  }
  if (m.inReplyTo) {
    if (isReaction) return { kind: "reaction", target: m.inReplyTo, token: textBody(m.nestedPart) ?? "" };
    return { kind: "reply", body: textBody(m.nestedPart), replyTo: m.inReplyTo };
  }
  return { kind: "post", body: textBody(m.nestedPart), replyTo: null };
}

/**
 * Stateful fold over decoded content messages. Feed every decoded message via {@link MessageFold.apply};
 * read the rendered projection of a post/reply via {@link MessageFold.getContent}. Mutation messages
 * (edit/delete/reaction/un-react) fold onto their target and are reported non-renderable.
 *
 * @example
 * ```ts
 * const fold = new MessageFold();
 * const { renderable } = fold.apply(decoded);   // false for a reaction/edit/delete
 * const content = fold.getContent(decoded.messageId); // post/reply projection or null
 * ```
 */
export class MessageFold {
  private rows = new Map<string, Row>(); // messageId → rendered row (post/reply only)
  private idByHash = new Map<string, string>(); // hex(contentHash) → messageId (ALL content messages)
  private reactionReg = new Map<string, { targetHash: string; token: string }>(); // reactionMsgId → …
  private pending = new Map<string, DecodedContentMessage[]>(); // hex(targetHash) → buffered mutations

  /** Drop all state (e.g. on conversation switch or full reload before re-folding). */
  reset(): void {
    this.rows.clear();
    this.idByHash.clear();
    this.reactionReg.clear();
    this.pending.clear();
  }

  /**
   * True if `messageId` produced a visible (post/reply) row.
   * @param messageId - The server message id to test.
   * @returns Whether a rendered row exists for it.
   */
  isRenderable(messageId: string): boolean {
    return this.rows.has(messageId);
  }

  /**
   * The rendered projection for a post/reply, or `null` for a folded mutation / unknown id.
   * @param messageId - The server message id to project.
   * @returns A fresh {@link RenderedContent} snapshot, or `null` when the id is not a rendered row.
   */
  getContent(messageId: string): RenderedContent | null {
    const r = this.rows.get(messageId);
    if (!r) return null;
    const reactions: Record<string, number> = {};
    for (const [token, set] of r.reactions) if (set.size > 0) reactions[token] = set.size;
    // Copy `replyTo` so a caller can't mutate the fold's internal hash bytes (body is a string — immutable).
    return { body: r.body, replyTo: r.replyTo ? r.replyTo.slice() : null, editedAt: r.editedAt, deleted: r.deleted, reactions };
  }

  /**
   * Apply one decoded message. Buffers a mutation whose target is unknown.
   *
   * Idempotent on a strict immediate re-apply of the same `messageId`, but NOT across an interleaved
   * re-delivery: re-applying an already-withdrawn reaction id resurrects it (the replayed reaction
   * re-adds itself to the now-empty token set and the prior un-react is not re-triggered). The CONSUMER
   * (the hook) MUST dedup by `messageId` and apply each id at most once — do not re-feed an
   * already-applied message.
   * @param msg - The decoded, content-hashed message to fold in.
   * @returns `{ renderable }` — whether this id is a standalone (post/reply) row.
   */
  apply(msg: DecodedContentMessage): { renderable: boolean } {
    const selfHex = hex(msg.contentHash);
    this.idByHash.set(selfHex, msg.messageId);
    const op = classify(msg.mimi);

    if (op.kind === "post" || op.kind === "reply") {
      const existing = this.rows.get(msg.messageId);
      const row: Row = existing ?? {
        messageId: msg.messageId,
        createdAt: msg.createdAt,
        senderDeviceId: msg.senderDeviceId,
        body: op.body,
        replyTo: op.kind === "reply" ? op.replyTo : null,
        editedAt: null,
        deleted: false,
        reactions: new Map(),
      };
      if (!existing) this.rows.set(msg.messageId, row);
      this.drain(selfHex); // a target just appeared → apply anything buffered against it
      return { renderable: true };
    }

    // Mutations resolve a target by content-hash; buffer if the target isn't present yet.
    if (op.kind === "edit") {
      const row = this.resolveRow(op.target);
      if (!row) return this.buffer(op.target, msg);
      row.body = op.body;
      row.editedAt = msg.createdAt;
      return { renderable: false };
    }
    if (op.kind === "reaction") {
      const row = this.resolveRow(op.target);
      if (!row) return this.buffer(op.target, msg);
      let set = row.reactions.get(op.token);
      if (!set) row.reactions.set(op.token, (set = new Set()));
      set.add(msg.messageId);
      this.reactionReg.set(msg.messageId, { targetHash: hex(op.target), token: op.token });
      this.drain(selfHex); // a pending un-react of THIS reaction can now apply
      return { renderable: false };
    }
    // delete-or-unreact: distinguish by whether `replaces` points at a known reaction message.
    if (op.kind === "delete-or-unreact") {
      const targetId = this.idByHash.get(hex(op.target));
      const reaction = targetId ? this.reactionReg.get(targetId) : undefined;
      if (reaction) {
        // Un-react: drop exactly the one reaction message from its target's token set.
        const row = this.resolveRow(fromHex(reaction.targetHash) ?? new Uint8Array());
        row?.reactions.get(reaction.token)?.delete(targetId!);
        return { renderable: false };
      }
      // Un-react-before-reaction guard: the reaction message was INDEXED on first sight (so `targetId`
      // resolves) but BUFFERED, not applied — hence no `reactionReg` entry yet AND no rendered row for
      // it. Treat this as an un-react of an as-yet-unapplied reaction: buffer it under the reaction's
      // hash so the reaction branch's `drain(selfHex)` replays the un-react after the reaction folds in.
      // Without this guard the delete path below would tombstone a non-row target as a no-op, then the
      // replayed reaction would survive — net wrong. Fail closed: buffer, never silently drop.
      if (targetId && !this.rows.has(targetId)) return this.buffer(op.target, msg);
      const row = this.resolveRow(op.target);
      if (!row) return this.buffer(op.target, msg); // a delete of an as-yet-unseen post → buffer it
      row.deleted = true;
      row.body = null;
      return { renderable: false };
    }
    // Unreachable: `classify` is exhaustive over Op.kind; satisfies the compiler's return analysis.
    return { renderable: false };
  }

  /**
   * Resolve the rendered row a content-hash points at, if it has been decoded.
   * @param targetHash - The referenced message's content-hash.
   * @returns The {@link Row}, or `undefined` if the target is unknown or not a rendered row.
   */
  private resolveRow(targetHash: Uint8Array): Row | undefined {
    const id = this.idByHash.get(hex(targetHash));
    return id ? this.rows.get(id) : undefined;
  }

  /**
   * Buffer a mutation against the hex of its (not-yet-decoded) target; replayed by {@link MessageFold.drain}.
   * @param targetHash - The target content-hash to key the buffer under.
   * @param msg - The mutation to defer.
   * @returns `{ renderable: false }` — a buffered mutation is never a standalone row.
   */
  private buffer(targetHash: Uint8Array, msg: DecodedContentMessage): { renderable: boolean } {
    const key = hex(targetHash);
    const list = this.pending.get(key) ?? [];
    list.push(msg);
    this.pending.set(key, list);
    return { renderable: false };
  }

  /**
   * Replay every mutation buffered against a content-hash that has just been decoded.
   * @param hashHex - The hex content-hash that just appeared (a post/reply or a now-applied reaction).
   */
  private drain(hashHex: string): void {
    const list = this.pending.get(hashHex);
    if (!list) return;
    this.pending.delete(hashHex);
    for (const m of list) this.apply(m);
  }
}

// Map a hex key back to bytes (for resolving a reaction's stored target-hash). Kept local — the fold is
// the only place that round-trips hash hex.
function fromHex(h: string): Uint8Array | null {
  if (h.length % 2 !== 0) return null;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
