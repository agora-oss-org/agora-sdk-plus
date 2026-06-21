// kind:1 IUC control-message codec — the transfer-envelope messages that ride INSIDE the MIMI routing
// frame ([kind:1][payload]). This module is PAYLOAD-level: the frame wrapping (frameContent /
// ContentKind.IucControl) is the state machine's job (slice #2). Each message is a deterministic-CBOR
// tagged array `[type, …fields]`, decoded strictly + fail-closed (untrusted peer input — a peer is
// trusted to be honest, not well-formed). `K` (in restore-envelope) lives ONLY here, inside MLS; it is
// never logged or placed on the REST wire.

import { encode, decode, type CborValue } from "../content/cbor.js";

/** IUC transfer-envelope control message types (chunk/INLINE reserved for slice #2). */
export const IucControlType = {
  Request: 0,
  Offer: 1,
  Declined: 2,
  Envelope: 3,
  Complete: 4,
  Ack: 5,
} as const;
export type IucControlType = (typeof IucControlType)[keyof typeof IucControlType];

/** B asks A to send the conversation's history. */
export interface RestoreRequest { type: typeof IucControlType.Request; transferId: Uint8Array; conversationId: string }
/** A offers to send B the conversation's history. */
export interface RestoreOffer { type: typeof IucControlType.Offer; transferId: Uint8Array; conversationId: string }
/** A declines (or the user said no). */
export interface RestoreDeclined { type: typeof IucControlType.Declined; transferId: Uint8Array }
/** A points B at a sealed blob; `K` and `sha256` cross ONLY here (inside MLS). */
export interface RestoreEnvelope {
  type: typeof IucControlType.Envelope;
  transferId: Uint8Array;
  blobId: string;
  K: Uint8Array;
  count: number;
  sha256: Uint8Array;
}
/** A marks the transfer complete (integrity over the whole). */
export interface RestoreComplete { type: typeof IucControlType.Complete; transferId: Uint8Array; count: number; sha256: Uint8Array }
/** B acknowledges receipt. */
export interface RestoreAck { type: typeof IucControlType.Ack; transferId: Uint8Array; count: number }

/** The discriminated union of all IUC control messages. */
export type IucControlMessage =
  | RestoreRequest | RestoreOffer | RestoreDeclined | RestoreEnvelope | RestoreComplete | RestoreAck;

function asArray(v: CborValue): CborValue[] {
  if (!Array.isArray(v)) throw new Error("iuc control: payload is not an array");
  return v;
}
function bytes(v: CborValue, ctx: string): Uint8Array {
  if (!(v instanceof Uint8Array)) throw new Error(`iuc control: expected bytes (${ctx})`);
  return v;
}
function str(v: CborValue, ctx: string): string {
  if (typeof v !== "string") throw new Error(`iuc control: expected string (${ctx})`);
  return v;
}
function int(v: CborValue, ctx: string): number {
  if (typeof v !== "number" || !Number.isInteger(v)) throw new Error(`iuc control: expected int (${ctx})`);
  return v;
}
function arity(a: CborValue[], n: number, ctx: string): void {
  if (a.length !== n) throw new Error(`iuc control: wrong arity for ${ctx}`);
}

/**
 * Encode an IUC control message to canonical-CBOR payload bytes (no frame — the caller wraps it with
 * `frameContent(ContentKind.IucControl, …)`).
 * @param msg - The control message.
 * @returns Canonical CBOR bytes.
 */
export function encodeIucControl(msg: IucControlMessage): Uint8Array {
  switch (msg.type) {
    case IucControlType.Request:
    case IucControlType.Offer:
      return encode([msg.type, msg.transferId, msg.conversationId]);
    case IucControlType.Declined:
      return encode([msg.type, msg.transferId]);
    case IucControlType.Envelope:
      return encode([msg.type, msg.transferId, msg.blobId, msg.K, msg.count, msg.sha256]);
    case IucControlType.Complete:
      return encode([msg.type, msg.transferId, msg.count, msg.sha256]);
    case IucControlType.Ack:
      return encode([msg.type, msg.transferId, msg.count]);
  }
}

/**
 * Strict-decode a canonical-CBOR IUC control payload. Fails closed on any malformed/untrusted input.
 * @param payload - The CBOR bytes (after unframing the `[kind:1]` content frame).
 * @returns The validated {@link IucControlMessage}.
 * @throws {Error} On a non-array payload, unknown type, wrong arity, or wrong field type.
 */
export function decodeIucControl(payload: Uint8Array): IucControlMessage {
  const a = asArray(decode(payload, { maxItems: 16 }));
  const type = int(a[0], "type");
  switch (type) {
    case IucControlType.Request:
      arity(a, 3, "request");
      return { type, transferId: bytes(a[1], "transferId"), conversationId: str(a[2], "conversationId") };
    case IucControlType.Offer:
      arity(a, 3, "offer");
      return { type, transferId: bytes(a[1], "transferId"), conversationId: str(a[2], "conversationId") };
    case IucControlType.Declined:
      arity(a, 2, "declined");
      return { type, transferId: bytes(a[1], "transferId") };
    case IucControlType.Envelope:
      arity(a, 6, "envelope");
      return {
        type, transferId: bytes(a[1], "transferId"), blobId: str(a[2], "blobId"),
        K: bytes(a[3], "K"), count: int(a[4], "count"), sha256: bytes(a[5], "sha256"),
      };
    case IucControlType.Complete:
      arity(a, 4, "complete");
      return { type, transferId: bytes(a[1], "transferId"), count: int(a[2], "count"), sha256: bytes(a[3], "sha256") };
    case IucControlType.Ack:
      arity(a, 3, "ack");
      return { type, transferId: bytes(a[1], "transferId"), count: int(a[2], "count") };
    default:
      throw new Error(`iuc control: unknown message type ${type}`);
  }
}
