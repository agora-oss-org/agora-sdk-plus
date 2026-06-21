// MimiContent — secure-chat's message content format. IMPLEMENTS draft-ietf-mimi-content-08 (2 Mar
// 2026), the message-content CDDL. The CBOR WIRE STRUCTURE below is draft-08-faithful with NO deviation
// (the interop-readiness payoff); the ONE deliberate deviation is MessageId DERIVATION (we lack
// federation identities) — documented in full at the bottom of this header.
//
// Where it sits: pure structure ABOVE the SecureChatCrypto seam and INSIDE the padding frame. Content
// is a core concern, never crypto's. We encode/decode the FULL draft structure (so Tier-3 fields
// round-trip today and surface later without rework); the hook surfaces Tier 2 (text / reply /
// reaction / edit / delete). Decoded bytes are UNTRUSTED peer input: decodeMimiContent validates the
// schema AFTER canonical CBOR-decoding and fails closed (CLAUDE.md §1).
//
// Wire CDDL (draft-ietf-mimi-content-08, the message-content section) — exactly what we encode/decode:
//
//   mimiContent = [salt:bstr.size 16, replaces:null/MessageId, topicId:bstr,
//                  expires:null/Expiration, inReplyTo:null/MessageId,
//                  mimiExtensions:extensions, nestedPart:NestedPart]      ; 7 elements
//   MessageId   = bstr.size 32
//   Expiration  = [relative:bool, time:uint.size 4]
//   extensions  = { ? &(senderUri:1)^ => tstr, ? &(roomUri:2)^ => tstr, * otherKnown, * unknown }
//                 name = int / tstr.size (1..255)   value = any.size (0..4095)
//   NestedPart  = [disposition, language:tstr, (NullPart // SinglePart // ExternalPart // MultiPart)]
//   NullPart    = (cardinality:nullpart)
//   SinglePart  = (cardinality:single,  contentType:tstr, content:bstr)
//   ExternalPart= (cardinality:external, contentType:tstr, url:tstr, expires:uint.size 4,
//                  size:uint.size 8, encAlg:uint.size 2, key:bstr, nonce:bstr, aad:bstr,
//                  hashAlg:uint.size 1, contentHash:bstr, description:tstr, filename:tstr)
//   MultiPart   = (cardinality:multi, partSemantics, parts:[2* NestedPart])  ; ≥2 parts
//   baseDispos: unspecified=0 render=1 reaction=2 profile=3 inline=4 icon=5 attachment=6 session=7 preview=8
//   cardinality: nullpart=0 single=1 external=2 multi=3   partSemantics: chooseOne=0 singleUnit=1 processAll=2
//   SHA-256 hash-algorithm identifier = 0x01
//
// Because NestedPart hoists `disposition` + `language` OUT of the variant, a single part encodes to the
// CBOR array [disposition, language, cardinality, …variantFields]. Our TS `Part` types keep
// `disposition`/`language` ON each variant (so the reducer can branch on `part.disposition ===
// Disposition.Reaction` and builders can set it); the codec maps them to/from the wrapper positions.
//
// ── THE ONE DELIBERATE DEVIATION: MessageId derivation ───────────────────────────────────────────
// draft-08 derives a MessageId from FEDERATION IDENTITIES:
//     messageId = 0x01 || SHA256(senderUriLen || senderUri || roomUriLen || roomUri || message || salt)[0..30]
// This SDK adopts the MIMI content FORMAT, not MIMI federation (design spec Goal A) — we have no
// senderUri / roomUri. So `contentHash(content)` returns a 32-byte MessageId-SHAPED value:
//     0x01 (SHA-256 hashAlg) || sha256(encodeMimiContent(content))[0..30]   (1 + 31 = 32 bytes)
// — structurally a real MIMI MessageId; only the hash INPUT is simplified (our canonical CBOR, which
// already includes the per-message `salt`, with no URI prefixes). `replaces`/`inReplyTo` carry THIS
// value. This is the single upgrade-when-federation-lands deviation; the WIRE CBOR has none.
//
// Design-doc reconcile (FOLLOWING THE DRAFT; for the doc owner): the doc's top-level `lastSeen` list,
// the per-Part `partIndex`, and `width`/`height`/`duration` on ExternalPart are NOT in draft-08 and are
// DROPPED; the doc modeled `inReplyTo` as {hash, hashAlgorithm} but the draft uses a bare 32-byte
// MessageId, so `inReplyTo` is now `Uint8Array | null` and the `MessageDerivedValue` type is removed.

import { encode, decode, type CborValue, type CborMap } from "./cbor.js";
import { sha256 } from "@noble/hashes/sha2.js";

/**
 * Part cardinality tag. Values per draft-ietf-mimi-content-08
 * (`nullpart=0, single=1, external=2, multi=3`).
 */
export const Cardinality = { Null: 0, Single: 1, External: 2, Multi: 3 } as const;
/** The set of valid {@link Cardinality} tag values. */
export type Cardinality = (typeof Cardinality)[keyof typeof Cardinality];

/**
 * Part disposition (draft-ietf-mimi-content-08 `baseDispos`). `Reaction` distinguishes a reaction
 * from a reply; `Attachment`/`Inline`/etc. drive client rendering.
 */
export const Disposition = {
  Unspecified: 0, Render: 1, Reaction: 2, Profile: 3, Inline: 4, Icon: 5,
  Attachment: 6, Session: 7, Preview: 8,
} as const;
/** The set of valid {@link Disposition} values. */
export type Disposition = (typeof Disposition)[keyof typeof Disposition];

/**
 * {@link MultiPart} `partSemantics` — how a client treats the child parts (draft-ietf-mimi-content-08:
 * `chooseOne=0, singleUnit=1, processAll=2`).
 */
export const PartSemantics = { ChooseOne: 0, SingleUnit: 1, ProcessAll: 2 } as const;
/** The set of valid {@link PartSemantics} values. */
export type PartSemantics = (typeof PartSemantics)[keyof typeof PartSemantics];

/**
 * Named-Information hash algorithm. SHA-256 is the only value we emit (identifier `0x01`, per
 * draft-ietf-mimi-content-08).
 */
export const HashAlg = { Sha256: 1 } as const;
/** The set of valid {@link HashAlg} values. */
export type HashAlg = (typeof HashAlg)[keyof typeof HashAlg];

/** A tombstone body (delete / un-react) — `NullPart` with the NestedPart wrapper's disposition/language. */
export interface NullPart {
  /** Cardinality tag — always {@link Cardinality.Null}. */
  cardinality: typeof Cardinality.Null;
  /** Wrapper disposition (typically {@link Disposition.Render}); kept for wire-faithful round-trip. */
  disposition: Disposition;
  /** BCP-47 language tag, or `""`. */
  language: string;
}
/** An inline body part (text, reaction token, …) — draft `SinglePart` + the NestedPart wrapper fields. */
export interface SinglePart {
  /** Cardinality tag — always {@link Cardinality.Single}. */
  cardinality: typeof Cardinality.Single;
  /** How a client should treat this part (`Render` for text, `Reaction` for a reaction token, …). */
  disposition: Disposition;
  /** BCP-47 language tag for `content`, or `""` when not applicable. */
  language: string;
  /** MIME type of `content` (e.g. `text/markdown`). */
  contentType: string;
  /** The raw body bytes (UTF-8 for text types). */
  content: Uint8Array;
}
/** An external (by-reference, encrypted) attachment part — Tier 3; encoded, not yet surfaced. */
export interface ExternalPart {
  /** Cardinality tag — always {@link Cardinality.External}. */
  cardinality: typeof Cardinality.External;
  /** How a client should treat this part (typically {@link Disposition.Attachment}). */
  disposition: Disposition;
  /** BCP-47 language tag, or `""`. */
  language: string;
  /** MIME type of the referenced blob. */
  contentType: string;
  /** Fetch URL for the encrypted blob. */
  url: string;
  /** Absolute expiry of the URL (0 = none). */
  expires: number;
  /** Plaintext size in bytes. */
  size: number;
  /** Symmetric encryption algorithm identifier for the blob (draft `encAlg`). */
  encAlgorithm: number;
  /** Symmetric key for the blob (kept client-side only). */
  key: Uint8Array;
  /** AEAD nonce. */
  nonce: Uint8Array;
  /** AEAD associated data. */
  aad: Uint8Array;
  /** Hash algorithm of {@link ExternalPart.contentHash} (we emit {@link HashAlg.Sha256}). */
  hashAlgorithm: HashAlg;
  /** Hash of the plaintext blob (integrity). */
  contentHash: Uint8Array;
  /** Human-readable description / alt text. */
  description: string;
  /** Suggested filename. */
  filename: string;
}
/** A composite body of ordered sub-parts (draft `MultiPart`; at least 2 children). */
export interface MultiPart {
  /** Cardinality tag — always {@link Cardinality.Multi}. */
  cardinality: typeof Cardinality.Multi;
  /** Wrapper disposition for the composite. */
  disposition: Disposition;
  /** BCP-47 language tag, or `""`. */
  language: string;
  /** How the child parts relate ({@link PartSemantics}). */
  partSemantics: PartSemantics;
  /** The ordered child parts (draft requires 2 or more). */
  parts: Part[];
}
/** The body tree: a cardinality-tagged union of {@link NullPart}, {@link SinglePart}, {@link ExternalPart}, {@link MultiPart}. */
export type Part = NullPart | SinglePart | ExternalPart | MultiPart;

/** Expiry directive (draft `Expiration = [relative: bool, time: uint .size 4]`). */
export interface Expiration {
  /** `true` = `time` is seconds relative to receipt; `false` = absolute UNIX time. */
  relative: boolean;
  /** The expiry time (seconds). */
  time: number;
}

/** The MIMI message content structure (draft-ietf-mimi-content-08; see file header for the CDDL). */
export interface MimiContent {
  /** Per-message CSPRNG bytes (draft `salt`, 16 bytes) — unlinkability of the content hash. */
  salt: Uint8Array;
  /** 32-byte content-hash (MessageId) of a message this replaces (edit/delete/un-react), or `null`. */
  replaces: Uint8Array | null;
  /** Threading topic id (Tier 3; encoded, unsurfaced). Empty = none. */
  topicId: Uint8Array;
  /** Expiry directive (draft `Expiration`), or `null` for none. Tier 3; encoded, unsurfaced. */
  expires: Expiration | null;
  /** 32-byte content-hash (MessageId) of the reply target, or `null`. */
  inReplyTo: Uint8Array | null;
  /** Extension map (round-tripped opaquely). */
  extensions: CborMap;
  /** The message body tree (draft `NestedPart`). */
  nestedPart: Part;
}

/**
 * Schema bounds enforced on decode (DoS / abuse guard): max sibling parts in a {@link MultiPart}, and
 * max part-tree depth. (draft-08 has no `lastSeen`, so there is no list bound here.)
 */
export const MIMI_LIMITS = { maxParts: 64, maxNesting: 8 } as const;

// ── encode ────────────────────────────────────────────────────────────────────
function encodePart(p: Part): CborValue {
  // NestedPart = [disposition, language, …variant-starting-with-cardinality].
  switch (p.cardinality) {
    case Cardinality.Null:
      return [p.disposition, p.language, Cardinality.Null];
    case Cardinality.Single:
      return [p.disposition, p.language, Cardinality.Single, p.contentType, p.content];
    case Cardinality.External:
      return [
        p.disposition, p.language, Cardinality.External, p.contentType, p.url, p.expires, p.size,
        p.encAlgorithm, p.key, p.nonce, p.aad, p.hashAlgorithm, p.contentHash, p.description, p.filename,
      ];
    case Cardinality.Multi:
      return [p.disposition, p.language, Cardinality.Multi, p.partSemantics, p.parts.map(encodePart)];
  }
}

function toCbor(c: MimiContent): CborValue {
  return [
    c.salt,
    c.replaces, // bstr(32) | null
    c.topicId,
    c.expires ? [c.expires.relative, c.expires.time] : null, // Expiration | null
    c.inReplyTo, // bstr(32) | null
    c.extensions,
    encodePart(c.nestedPart),
  ];
}

/**
 * Encode a {@link MimiContent} to canonical CBOR bytes per the draft-08 wire layout.
 * @param c - The content to encode.
 * @returns Canonical CBOR bytes (stable for equal content — the basis for {@link contentHash}).
 * @throws {Error} If a field carries an out-of-subset CBOR value (e.g. a non-integer number).
 * @example
 * ```ts
 * const bytes = encodeMimiContent(myContent);
 * const same  = decodeMimiContent(bytes); // round-trips
 * ```
 */
export function encodeMimiContent(c: MimiContent): Uint8Array {
  return encode(toCbor(c));
}

// ── decode + validate ───────────────────────────────────────────────────────
function asArray(v: CborValue, ctx: string): CborValue[] {
  if (!Array.isArray(v)) throw new Error(`MimiContent: expected array (${ctx})`);
  return v;
}
function asBytes(v: CborValue, ctx: string): Uint8Array {
  if (!(v instanceof Uint8Array)) throw new Error(`MimiContent: expected bytes (${ctx})`);
  return v;
}
function asString(v: CborValue, ctx: string): string {
  if (typeof v !== "string") throw new Error(`MimiContent: expected string (${ctx})`);
  return v;
}
function asInt(v: CborValue, ctx: string): number {
  if (typeof v !== "number" || !Number.isInteger(v)) throw new Error(`MimiContent: expected int (${ctx})`);
  return v;
}
function asBool(v: CborValue, ctx: string): boolean {
  if (typeof v !== "boolean") throw new Error(`MimiContent: expected bool (${ctx})`);
  return v;
}

/**
 * Exact wire-array length per cardinality (`[disposition, language, cardinality, …variant]`). Decode
 * asserts this exactly so a part carrying TRAILING junk is rejected, not silently dropped (CLAUDE.md
 * §1: fail closed — never skip the check).
 */
const PART_ARITY: Record<number, number> = {
  [Cardinality.Null]: 3, // disposition, language, cardinality
  [Cardinality.Single]: 5, // + contentType, content
  // disposition, language, cardinality + 12 ExternalPart fields (contentType, url, expires, size,
  // encAlg, key, nonce, aad, hashAlg, contentHash, description, filename) = 15. (decode reads a[14].)
  [Cardinality.External]: 15,
  [Cardinality.Multi]: 5, // + partSemantics, parts
};

function decodePart(v: CborValue, depth: number): Part {
  if (depth > MIMI_LIMITS.maxNesting) throw new Error("MimiContent: part nesting exceeds bounds");
  const a = asArray(v, "part");
  // NestedPart wrapper: [disposition, language, cardinality, …variant].
  const disposition = asInt(a[0], "part.disposition") as Disposition;
  const language = asString(a[1], "part.language");
  const card = asInt(a[2], "part.cardinality");
  // Fail closed on an unknown cardinality OR a wrong-length part array (trailing/missing elements).
  const expectedArity = PART_ARITY[card];
  if (expectedArity === undefined) throw new Error(`MimiContent: unknown part cardinality ${card}`);
  if (a.length !== expectedArity) throw new Error(`MimiContent: wrong arity for cardinality ${card}`);
  switch (card) {
    case Cardinality.Null:
      return { cardinality: Cardinality.Null, disposition, language };
    case Cardinality.Single:
      return {
        cardinality: Cardinality.Single,
        disposition,
        language,
        contentType: asString(a[3], "contentType"),
        content: asBytes(a[4], "content"),
      };
    case Cardinality.External:
      return {
        cardinality: Cardinality.External,
        disposition,
        language,
        contentType: asString(a[3], "contentType"),
        url: asString(a[4], "url"),
        expires: asInt(a[5], "expires"),
        size: asInt(a[6], "size"),
        encAlgorithm: asInt(a[7], "encAlgorithm"),
        key: asBytes(a[8], "key"),
        nonce: asBytes(a[9], "nonce"),
        aad: asBytes(a[10], "aad"),
        hashAlgorithm: asInt(a[11], "hashAlgorithm") as HashAlg,
        contentHash: asBytes(a[12], "contentHash"),
        description: asString(a[13], "description"),
        filename: asString(a[14], "filename"),
      };
    case Cardinality.Multi: {
      const parts = asArray(a[4], "multi.parts");
      // The draft requires 2 or more child parts; reject a degenerate multipart fail-closed.
      if (parts.length < 2) throw new Error("MimiContent: multipart requires 2+ parts");
      if (parts.length > MIMI_LIMITS.maxParts) throw new Error("MimiContent: too many parts (bounds)");
      return {
        cardinality: Cardinality.Multi,
        disposition,
        language,
        partSemantics: asInt(a[3], "partSemantics") as PartSemantics,
        parts: parts.map((p) => decodePart(p, depth + 1)),
      };
    }
    default:
      throw new Error(`MimiContent: unknown part cardinality ${card}`);
  }
}

/**
 * Strict-decode + schema-validate canonical CBOR into a {@link MimiContent}. Fails closed on any
 * structural or bounds violation (untrusted peer input — CLAUDE.md §1).
 * @param bytes - The canonical CBOR content bytes (after unframing).
 * @returns The validated {@link MimiContent}.
 * @throws {Error} On a malformed structure, wrong field type, an unknown {@link Cardinality}, or a
 *   {@link MIMI_LIMITS} bound exceeded. The error message never includes message plaintext.
 * @example
 * ```ts
 * const content = decodeMimiContent(peerBytes); // throws on any tampering
 * ```
 */
export function decodeMimiContent(bytes: Uint8Array): MimiContent {
  const a = asArray(decode(bytes, { maxItems: MIMI_LIMITS.maxParts * 4 }), "MimiContent");
  if (a.length !== 7) throw new Error("MimiContent: wrong top-level arity");
  const replaces = a[1] === null ? null : asBytes(a[1], "replaces");
  let expires: Expiration | null = null;
  if (a[3] !== null) {
    const e = asArray(a[3], "expires");
    expires = { relative: asBool(e[0], "expires.relative"), time: asInt(e[1], "expires.time") };
  }
  const inReplyTo = a[4] === null ? null : asBytes(a[4], "inReplyTo");
  const ext = a[5];
  if (!(ext instanceof Map)) throw new Error("MimiContent: extensions must be a map");
  return {
    salt: asBytes(a[0], "salt"),
    replaces,
    topicId: asBytes(a[2], "topicId"),
    expires,
    inReplyTo,
    extensions: ext as CborMap,
    nestedPart: decodePart(a[6], 0),
  };
}

/**
 * The MIMI content-hash: a 32-byte, MessageId-SHAPED reference value used to point at a message
 * (reply / edit / delete / un-react). Per the file-header deviation note, we lack federation
 * identities, so instead of draft-08's URI-prefixed input we compute
 * `0x01 || sha256(encodeMimiContent(c))[0..30]` — the leading `0x01` is the SHA-256 hash-algorithm
 * identifier, then the first 31 bytes of the SHA-256 over our canonical CBOR (which already includes
 * the per-message `salt`). Structurally a real MIMI MessageId; stable across runtimes; salt-sensitive.
 * The blind server never sees this. `replaces` / `inReplyTo` are populated with this value.
 * @param c - The content to hash.
 * @returns A 32-byte MessageId (`[0]` is `0x01`; `[1..31]` are `sha256(canonical CBOR)[0..30]`).
 * @example
 * ```ts
 * const id = contentHash(myContent); // 32 bytes, id[0] === 0x01, salt-sensitive
 * reply.inReplyTo = id;
 * ```
 */
export function contentHash(c: MimiContent): Uint8Array {
  const digest = sha256(encodeMimiContent(c));
  const messageId = new Uint8Array(32);
  messageId[0] = HashAlg.Sha256; // 0x01 — the MessageId hashAlg prefix byte
  messageId.set(digest.subarray(0, 31), 1); // first 31 SHA-256 bytes fill [1..31]
  return messageId;
}
