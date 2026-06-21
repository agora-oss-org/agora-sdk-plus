// Blob AEAD for the IUC ENVELOPE path — seal/open a history blob with XChaCha20-Poly1305.
//
// Where it sits: ABOVE the SecureChatCrypto seam (the seam is MLS group crypto; this is a generic
// byte-AEAD with an EPHEMERAL key `K` that rides MLS and is never stored). The server is a blind relay
// that cannot validate the blob, so the ONLY thing binding a blob to its intended transfer/slot is the
// AEAD AAD — we bind the full transfer descriptor (canonical CBOR) so a blob can't be replayed into a
// different transfer or chunk slot. `K`/plaintext/nonce never leave the client and are never logged.

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { encode, type CborMap, type CborValue } from "../content/cbor.js";

/** XChaCha20-Poly1305 extended nonce — 24 bytes, safe with random nonces. */
const NONCE_BYTES = 24;
/** XChaCha20-Poly1305 key length. */
const KEY_BYTES = 32;
/** Poly1305 tag length — the floor for a non-empty AEAD output. */
const TAG_BYTES = 16;

/** The transfer/slot a blob is cryptographically bound to (the AEAD AAD). */
export interface RestoreDescriptor {
  /** Fresh CSPRNG id binding every frame of one transfer. */
  transferId: Uint8Array;
  /** The conversation whose history is being restored. */
  conversationId: string;
  /** A's own device row id (the uploader). */
  fromDeviceId: string;
  /** B's current device row id (the recipient). */
  targetDeviceId: string;
  /** 0-based index of this chunk within the transfer. */
  chunkIndex: number;
  /** Total number of chunks in the transfer. */
  chunkCount: number;
}

/** Thrown when a blob fails to open — fail closed; the caller drops the blob. Carries no key/plaintext. */
export class SecureRestoreSealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecureRestoreSealError";
  }
}

/**
 * A full-entropy 256-bit restore key from the platform CSPRNG. Never a KDF/passphrase.
 * @returns 32 random bytes.
 */
export function generateRestoreKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

/**
 * Canonical-CBOR encoding of a {@link RestoreDescriptor} for use as the AEAD AAD. Deterministic
 * (CBOR map keyed by stable small ints, sorted by the codec), so the binding is byte-stable
 * cross-runtime and any field change yields different AAD.
 * @param d - The transfer descriptor.
 * @returns Canonical CBOR bytes.
 */
export function restoreAad(d: RestoreDescriptor): Uint8Array {
  // Typed entries keep each value compile-time-checked as a CborValue; the single `as CborMap` is the
  // honest cast for Map's invariant key type (a `number` key IS a valid CborValue), not a safety bypass.
  const entries: [number, CborValue][] = [
    [0, d.transferId],
    [1, d.conversationId],
    [2, d.fromDeviceId],
    [3, d.targetDeviceId],
    [4, d.chunkIndex],
    [5, d.chunkCount],
  ];
  return encode(new Map(entries) as CborMap);
}

/**
 * Seal `plaintext` with XChaCha20-Poly1305 under `K`, binding `aad`. A fresh 24-byte CSPRNG nonce is
 * prepended to the ciphertext+tag: output = `nonce(24) || ct||tag`.
 * @param K - The 32-byte restore key (from {@link generateRestoreKey}).
 * @param plaintext - The bytes to seal (format-agnostic).
 * @param aad - The bound associated data (from {@link restoreAad}).
 * @returns The sealed blob.
 */
export function sealRestoreBlob(K: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ct = xchacha20poly1305(K, nonce, aad).encrypt(plaintext);
  const out = new Uint8Array(NONCE_BYTES + ct.length);
  out.set(nonce, 0);
  out.set(ct, NONCE_BYTES);
  return out;
}

/**
 * Open a {@link sealRestoreBlob} output. Fail closed on any auth/AAD/tamper/short-input failure.
 * @param K - The 32-byte restore key.
 * @param blob - `nonce(24) || ct||tag`.
 * @param aad - The same AAD bound at seal time (from {@link restoreAad}).
 * @returns The recovered plaintext.
 * @throws {SecureRestoreSealError} On a short blob or any AEAD verification failure.
 */
export function openRestoreBlob(K: Uint8Array, blob: Uint8Array, aad: Uint8Array): Uint8Array {
  if (blob.length < NONCE_BYTES + TAG_BYTES) {
    throw new SecureRestoreSealError("restore: blob too short");
  }
  const nonce = blob.subarray(0, NONCE_BYTES);
  const ct = blob.subarray(NONCE_BYTES);
  try {
    return xchacha20poly1305(K, nonce, aad).decrypt(ct);
  } catch {
    // Never surface the underlying error (could hint at key/plaintext); fail closed uniformly.
    throw new SecureRestoreSealError("restore: blob failed to open (fail closed)");
  }
}
