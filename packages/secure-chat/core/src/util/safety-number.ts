// Safety number — a human-comparable fingerprint of two devices' identity keys (key verification).
//
// Where it sits in the blind-server model: the server is blind but UNTRUSTED, so it could in principle
// hand a victim a KeyPackage carrying an attacker's signature key (a classic active MITM on a TOFU
// system). A safety number lets two users confirm out-of-band (read aloud / compare on screen / scan a
// QR) that they actually hold each other's real identity keys. It is derived ONLY from public
// signature keys + device ids — no secrets — and is symmetric: both sides compute the same number.
//
// Shape (Signal-style): each party's identity is hashed into a 30-digit number; the two are sorted (so
// the result is order-independent) and concatenated into 60 decimal digits, shown as 12 groups of 5.

import type { GroupMemberIdentity } from "@agora-sdk/secure-chat-crypto";

/** Format/version byte bound into the hash so the derivation can evolve unambiguously. */
const VERSION = 0;
/** Hash iterations per party. Public-key fingerprints don't need KDF-grade work; this is a fixed,
 *  app-wide constant purely so every Agora client derives an identical number (interop, not secrecy). */
const ITERATIONS = 1024;
/** Bytes of the final hash consumed: 6 chunks × 5 bytes → 6 × 5 digits = 30 digits per party. */
const CHUNKS = 6;
const CHUNK_BYTES = 5;

const utf8 = (s: string) => new TextEncoder().encode(s);

/** A derived safety number, in the forms a UI needs. */
export interface SafetyNumber {
  /** All 60 decimal digits with no separators. */
  digits: string;
  /** The 60 digits as 12 groups of 5 (for display / read-aloud). */
  groups: string[];
  /** The raw combined fingerprint bytes (sorted-concatenated per-party hashes) — e.g. for a QR code. */
  fingerprint: Uint8Array;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  // Cast to BufferSource: our Uint8Array is always ArrayBuffer-backed, but the lib type is the wider
  // Uint8Array<ArrayBufferLike> (which could be SharedArrayBuffer) that digest() won't accept directly.
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

/** Encode one 5-byte chunk as a 5-digit decimal string (40-bit big-endian value mod 100000). */
function chunkToDigits(hash: Uint8Array, offset: number): string {
  // 2**40 < 2**53, so plain Number arithmetic is exact here.
  let value = 0;
  for (let i = 0; i < CHUNK_BYTES; i++) value = value * 256 + hash[offset + i];
  return (value % 100000).toString().padStart(5, "0");
}

/** Per-party fingerprint: an iterated hash of (version || pubkey || deviceId), then 30 digits + the
 *  truncated hash bytes. Signal-shaped (the key is re-mixed in each round). */
async function partyFingerprint(party: GroupMemberIdentity): Promise<{ digits: string; bytes: Uint8Array }> {
  const key = party.signaturePublicKey;
  let hash = concat(Uint8Array.of(VERSION), key, utf8(party.deviceId));
  for (let i = 0; i < ITERATIONS; i++) hash = await sha256(concat(hash, key));
  let digits = "";
  for (let c = 0; c < CHUNKS; c++) digits += chunkToDigits(hash, c * CHUNK_BYTES);
  return { digits, bytes: hash.slice(0, CHUNKS * CHUNK_BYTES) };
}

/**
 * Derive the safety number for two parties from their public identities. The result is **symmetric** —
 * `computeSafetyNumber(a, b)` equals `computeSafetyNumber(b, a)` — because the two per-party
 * fingerprints are sorted before concatenation. Uses WebCrypto SHA-256 (available in browsers and
 * Node 18+).
 *
 * @param a - One party's `{ deviceId, signaturePublicKey }` (e.g. the local device).
 * @param b - The other party's identity (e.g. the remote peer).
 * @returns The {@link SafetyNumber} (60 digits, 12 groups of 5, plus raw fingerprint bytes).
 *
 * @example
 * ```ts
 * const { groups } = await computeSafetyNumber(localIdentity, peerIdentity);
 * // groups → ["12345", "67890", … 12 of them]; compare with the peer out-of-band.
 * ```
 */
export async function computeSafetyNumber(
  a: GroupMemberIdentity,
  b: GroupMemberIdentity
): Promise<SafetyNumber> {
  const [fpA, fpB] = await Promise.all([partyFingerprint(a), partyFingerprint(b)]);
  // Sort so the number is the same regardless of who is "a" vs "b".
  const [first, second] = fpA.digits <= fpB.digits ? [fpA, fpB] : [fpB, fpA];
  const digits = first.digits + second.digits;
  const groups: string[] = [];
  for (let i = 0; i < digits.length; i += 5) groups.push(digits.slice(i, i + 5));
  return { digits, groups, fingerprint: concat(first.bytes, second.bytes) };
}
