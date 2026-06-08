// Passphrase backup envelope codec — the REAL at-rest crypto for key-material backups.
//
// Where it sits in the blind-server model: the Agora server stores the resulting `blob` verbatim and
// can never decrypt it (it never sees the passphrase; the KDF params alone are useless). So this is
// the one place the backup's secrecy is decided. Per CLAUDE.md #1 we use a real memory-hard KDF
// (argon2id, RFC 9106 high-memory profile) so a weak passphrase is expensive to brute-force on a DB
// exfil, and an AEAD (xchacha20poly1305) so a tampered blob/nonce/metadata fails closed.
//
// Binary is `Uint8Array` in memory; the wire/transport layer base64-encodes `blob`/`nonce` and the
// KDF params (incl. the hex salt) are non-secret metadata stored alongside.
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { zeroOutUint8Array } from "ts-mls";
import type { PassphraseBackup } from "../interface.js";
import { toHex, fromHex } from "./hex.js";

const utf8 = (s: string) => new TextEncoder().encode(s);

/** The only KDF this codec emits/accepts. */
const KDF = "argon2id" as const;
/** The only AEAD this codec emits/accepts. */
const CIPHER = "xchacha20poly1305" as const;
/** The only envelope version this codec emits/accepts. */
const VERSION = 1 as const;

const SALT_BYTES = 16;
const NONCE_BYTES = 24; // xchacha20poly1305 extended nonce — safe with random nonces

/**
 * argon2id parameters — RFC 9106 "FIRST RECOMMENDED" high-memory profile (m=64 MiB, t=3, p=1),
 * 32-byte derived key. Backup/restore is rare, so the ~0.5–1s cost is acceptable and buys strong
 * resistance to offline brute-force of the passphrase if the server's blob store is exfiltrated.
 */
export const ARGON2_PARAMS = { m: 65536, t: 3, p: 1, dkLen: 32 } as const;

/**
 * The associated data bound into the AEAD: the non-secret envelope descriptors. Binding them means an
 * attacker can't swap the stored `kdf`/`cipher`/`version`/`kdfParams` (e.g. downgrade the KDF) without
 * the open failing closed.
 */
function aad(kdf: string, cipher: string, version: number, kdfParams: Record<string, unknown>): Uint8Array {
  return utf8(JSON.stringify({ v: version, kdf, cipher, kdfParams }));
}

/**
 * Derive a 32-byte key from the passphrase + salt with argon2id at {@link ARGON2_PARAMS}.
 *
 * @param passphrase - The user's backup passphrase.
 * @param salt - The 16-byte random salt.
 * @returns The 32-byte derived symmetric key (caller must zeroize after use).
 */
async function deriveKey(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
  return argon2idAsync(utf8(passphrase), salt, ARGON2_PARAMS);
}

/**
 * Seal plaintext key material into a passphrase-encrypted {@link PassphraseBackup}.
 *
 * @param plaintext - The serialized key material to protect.
 * @param passphrase - The user's backup passphrase.
 * @returns The encrypted envelope (random salt in `kdfParams`, random `nonce`, argon2id + xchacha20poly1305).
 */
export async function sealBackup(plaintext: Uint8Array, passphrase: string): Promise<PassphraseBackup> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const kdfParams: Record<string, unknown> = { salt: toHex(salt), m: ARGON2_PARAMS.m, t: ARGON2_PARAMS.t, p: ARGON2_PARAMS.p };
  const key = await deriveKey(passphrase, salt);
  try {
    const blob = xchacha20poly1305(key, nonce, aad(KDF, CIPHER, VERSION, kdfParams)).encrypt(plaintext);
    return { blob, kdf: KDF, kdfParams, cipher: CIPHER, nonce, version: VERSION };
  } finally {
    zeroOutUint8Array(key);
  }
}

/**
 * Open a {@link PassphraseBackup} sealed by {@link sealBackup}.
 *
 * @param backup - The encrypted envelope.
 * @param passphrase - The user's backup passphrase.
 * @returns The decrypted plaintext key material.
 * @throws {Error} On an unknown `kdf`/`cipher`/`version`, a missing salt, or AEAD authentication
 *   failure (wrong passphrase, or a tampered blob/nonce/metadata) — always fails closed.
 */
export async function openBackup(backup: PassphraseBackup, passphrase: string): Promise<Uint8Array> {
  if (backup.kdf !== KDF) throw new Error(`secure-chat: unsupported backup kdf "${backup.kdf}"`);
  if (backup.cipher !== CIPHER) throw new Error(`secure-chat: unsupported backup cipher "${backup.cipher}"`);
  if (backup.version !== VERSION) throw new Error(`secure-chat: unsupported backup version ${backup.version}`);
  const saltHex = (backup.kdfParams as { salt?: string }).salt;
  if (!saltHex) throw new Error("secure-chat: backup is missing its KDF salt");
  const key = await deriveKey(passphrase, fromHex(saltHex));
  try {
    return xchacha20poly1305(key, backup.nonce, aad(backup.kdf, backup.cipher, backup.version, backup.kdfParams)).decrypt(backup.blob);
  } catch {
    // Don't leak which check failed; a wrong passphrase and a tampered blob are indistinguishable here.
    throw new Error("secure-chat: backup decrypt failed (wrong passphrase or corrupt backup)");
  } finally {
    zeroOutUint8Array(key);
  }
}
