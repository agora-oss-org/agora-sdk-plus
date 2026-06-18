// Encryption-at-rest decorator for the web SecureChatStore.
//
// Where it sits in the blind-server / client-crypto model: everything the secure-chat client persists
// flows through one `SecureChatStore` key→blob seam — MLS group/ratchet secrets (`group:`), the device
// signing key (`device`), DECRYPTED message plaintext (`msg:`, the durable history), and delivery
// cursors. On web the base store is `createIndexedDBStore()`, which writes plaintext readable by any
// same-origin script or anyone with disk access. The blind server still never sees any of it; this
// decorator closes the *local* at-rest gap by sealing every VALUE under a password-derived key before
// it reaches the base store, and opening it on the way out.
//
// Key hierarchy (Approach A): a password is stretched with argon2id into a Key-Encryption-Key (KEK,
// once per unlock), which unwraps a random AES-256-GCM Data-Encryption-Key (DEK) held only as a
// NON-EXTRACTABLE WebCrypto CryptoKey. Per-value AES-GCM uses the DEK with a fresh random nonce. The
// AEAD unlock IS the password check — there is no separate stored hash to leak. A password change
// re-wraps the SAME DEK (no bulk re-encryption), so existing values stay readable.
//
// SECURITY POSTURE (honest, per CLAUDE.md §1):
//   • Values are sealed; store KEYS pass through in the clear. Keys leak conversation ids and
//     per-conversation message counts — which the blind server already observes — but never plaintext
//     or key material. Encrypting keys/metadata is a deliberately-deferred later feature.
//   • Fail closed everywhere: locked → every op throws `StoreLockedError`; a wrong password or a
//     tampered value → the AEAD throws and we rethrow a GENERIC error (we never distinguish wrong
//     password from tamper, and never return raw/undecrypted bytes).
//   • Nothing here ever logs, throws, or serializes the password, KEK, DEK, or any plaintext.
//   • All crypto is WebCrypto + @noble/hashes argon2id — no hand-rolled primitives, CSPRNG nonces only.

import type { SecureChatStore } from "@agora-sdk/secure-chat-core";
import { toBase64, fromBase64 } from "@agora-sdk/secure-chat-core";
import { argon2idAsync } from "@noble/hashes/argon2.js";

/**
 * argon2id parameters for deriving the KEK from the password — RFC 9106 "FIRST RECOMMENDED"
 * high-memory profile (m=64 MiB, t=3, p=1) with a 32-byte output, matching
 * `@agora-sdk/secure-chat-crypto`'s backup codec. Unlock is interactive-but-rare, so the ~0.5–1s cost
 * is acceptable and buys strong resistance to offline brute-force of the password if the on-disk store
 * is exfiltrated.
 */
const ARGON2_PARAMS = { m: 65536, t: 3, p: 1, dkLen: 32 } as const;

/** The on-disk format version stamped into the meta record and every sealed value. */
const VERSION = 1 as const;

/** Reserved base-store key for the (never-encrypted, never-listed) meta record. */
const META_KEY = "__enc__";

/** Random salt length for argon2id (bytes). */
const SALT_BYTES = 16;
/** AES-GCM nonce length (bytes) — 96-bit, the WebCrypto/NIST-recommended IV size. */
const NONCE_BYTES = 12;

const utf8 = (s: string) => new TextEncoder().encode(s);

/**
 * Coerce bytes to a WebCrypto `BufferSource` backed by a plain `ArrayBuffer`. `@noble/hashes` and
 * `subarray` views are typed `Uint8Array<ArrayBufferLike>`, which TS will not accept where WebCrypto
 * wants an `ArrayBuffer`-backed `BufferSource`; copying into a fresh `Uint8Array` guarantees that
 * backing. The copies are small (nonces, the wrapped DEK, per-value ciphertext) — no secret is exposed.
 */
const buf = (bytes: Uint8Array): BufferSource => new Uint8Array(bytes);

/**
 * The persisted, never-encrypted meta record at {@link META_KEY}. Its presence distinguishes a re-open
 * (derive KEK, unwrap the stored DEK) from a first unlock (generate salt + DEK, wrap, write). Binary
 * fields are base64 in the JSON. Contains NO secret material in the clear — `wrappedDEK` is the DEK
 * encrypted under the password-derived KEK; without the password it is useless.
 */
interface MetaRecord {
  /** On-disk format version. */
  version: number;
  /** KDF identifier — only `"argon2id"` is emitted/accepted. */
  kdf: "argon2id";
  /** KDF parameters: the random `salt` (base64) plus the argon2id cost params. */
  kdfParams: { salt: string; m: number; t: number; p: number };
  /** The DEK wrapped (AES-GCM `wrapKey`) under the KEK, base64. */
  wrappedDEK: string;
  /** The AES-GCM nonce used to wrap the DEK, base64. */
  wrapNonce: string;
}

/**
 * Thrown by every {@link EncryptedStore} data operation (`get`/`set`/`delete`/`list`) while the store
 * is locked. Surfacing it (rather than silently returning empty) keeps the store fail-closed: a caller
 * must `unlock(password)` before any persistence happens. Carries no secret material.
 */
export class StoreLockedError extends Error {
  constructor(message = "secure-chat: store is locked — call unlock(password) first") {
    super(message);
    this.name = "StoreLockedError";
  }
}

/** Options for {@link createEncryptedStore}. */
export interface EncryptedStoreOptions {
  // Reserved for future tuning (e.g. argon2id cost overrides, auto-lock timer). None today: the v1
  // params are fixed to ARGON2_PARAMS so every instance over the same base store interoperates.
}

/**
 * A {@link SecureChatStore} decorator that adds at-rest encryption: it seals each VALUE under a
 * password-derived key before delegating to a base store, and opens it on read. Store KEYS pass
 * through in the clear (see the file header for the honest scope). Beyond the four store methods it
 * exposes `unlock`/`lock`/`isLocked`/`changePassword` so the app can drive lock state while the
 * provider still receives a plain `SecureChatStore`.
 *
 * Construct via {@link createEncryptedStore}; do not `new` it directly.
 *
 * @example
 * ```ts
 * const enc = createEncryptedStore(createIndexedDBStore());
 * await enc.unlock(password);            // derive KEK, unwrap/generate DEK
 * <SecureChatProvider store={enc} crypto={crypto} projectId={id} />
 * // later, on logout / idle:
 * enc.lock();                            // drops the in-memory DEK/KEK
 * ```
 */
export class EncryptedStore implements SecureChatStore {
  /** The unwrapped, non-extractable per-value AES-GCM key. `null` ⇒ locked. */
  #dek: CryptoKey | null = null;

  /**
   * @param base - The underlying store to seal/open values against (normally `createIndexedDBStore()`).
   * @param _opts - {@link EncryptedStoreOptions} (reserved; no effect today).
   */
  constructor(
    private readonly base: SecureChatStore,
    _opts: EncryptedStoreOptions = {}
  ) {}

  /**
   * Whether the store is currently locked (no DEK in memory). All data operations throw
   * {@link StoreLockedError} while locked.
   *
   * @returns `true` if locked, `false` once {@link unlock} has succeeded.
   */
  isLocked(): boolean {
    return this.#dek === null;
  }

  /**
   * Unlock the store with the user's password. On first use (no meta record) this generates a fresh
   * salt + DEK, wraps the DEK under the password-derived KEK, and persists the meta record. On a
   * re-open it derives the KEK from the stored salt and unwraps the existing DEK. After success the
   * (non-extractable) DEK is held in memory and data operations work.
   *
   * @param password - The user's password. Never logged, thrown, or persisted in the clear.
   * @returns A promise that resolves once the DEK is in memory.
   * @throws {Error} A generic "wrong password or corrupt store" error if the meta record exists but
   *   the DEK cannot be unwrapped (wrong password OR tampered store — deliberately indistinguishable).
   *   The store stays locked on failure.
   */
  async unlock(password: string): Promise<void> {
    const metaBytes = await this.base.get(META_KEY);
    if (metaBytes === null) {
      // First unlock: mint a salt + DEK, wrap it under the KEK, persist the meta record.
      const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
      const kek = await this.#deriveKek(password, salt);
      // Extractable so we can wrap it now; the in-memory handle below is re-imported non-extractable.
      const freshDek = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
        "encrypt",
        "decrypt",
      ]);
      const wrapNonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
      const wrapped = new Uint8Array(
        await crypto.subtle.wrapKey("raw", freshDek, kek, { name: "AES-GCM", iv: wrapNonce })
      );
      const meta: MetaRecord = {
        version: VERSION,
        kdf: "argon2id",
        kdfParams: { salt: toBase64(salt), m: ARGON2_PARAMS.m, t: ARGON2_PARAMS.t, p: ARGON2_PARAMS.p },
        wrappedDEK: toBase64(wrapped),
        wrapNonce: toBase64(wrapNonce),
      };
      await this.base.set(META_KEY, utf8(JSON.stringify(meta)));
      // Re-derive the in-memory DEK as NON-EXTRACTABLE (the extractable handle is dropped here).
      this.#dek = await this.#unwrapDek(kek, wrapped, wrapNonce);
      return;
    }

    // Re-open: derive the KEK from the stored salt and unwrap the existing DEK.
    const meta = this.#parseMeta(metaBytes);
    const kek = await this.#deriveKek(password, fromBase64(meta.kdfParams.salt));
    try {
      this.#dek = await this.#unwrapDek(
        kek,
        fromBase64(meta.wrappedDEK),
        fromBase64(meta.wrapNonce)
      );
    } catch {
      // Wrong password and a tampered wrappedDEK are indistinguishable here, and we keep it that way.
      // Stay locked; surface nothing about the password or the failure cause.
      this.#dek = null;
      throw new Error("secure-chat: unlock failed (wrong password or corrupt store)");
    }
  }

  /**
   * Lock the store by dropping the in-memory DEK. Subsequent data operations throw
   * {@link StoreLockedError} until {@link unlock} is called again. This is a disk-lock: it does not
   * purge plaintext already cached elsewhere (provider/crypto in-memory state) — that is a later
   * feature.
   */
  lock(): void {
    this.#dek = null;
  }

  /**
   * Change the password without re-encrypting any data: verify/derive against the SAME DEK and re-wrap
   * it under a KEK derived from the new password + a fresh salt, then rewrite the meta record.
   *
   * Requires the store to be unlocked (the in-memory DEK is the source of truth); `oldPassword` is
   * additionally verified by re-deriving its KEK and unwrapping the stored DEK, so a wrong old password
   * fails closed without touching the meta record.
   *
   * @param oldPassword - The current password (verified before any change).
   * @param newPassword - The replacement password.
   * @returns A promise that resolves once the meta record has been rewritten.
   * @throws {StoreLockedError} If the store is locked (unlock first).
   * @throws {Error} A generic "wrong password or corrupt store" error if `oldPassword` does not unwrap
   *   the stored DEK. The meta record is left unchanged.
   */
  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    if (this.#dek === null) throw new StoreLockedError();
    const metaBytes = await this.base.get(META_KEY);
    if (metaBytes === null) throw new Error("secure-chat: cannot change password before first unlock");
    const meta = this.#parseMeta(metaBytes);

    // Verify the old password by unwrapping the stored DEK with its KEK (we re-wrap THIS exact DEK).
    const oldKek = await this.#deriveKek(oldPassword, fromBase64(meta.kdfParams.salt));
    let dekToRewrap: CryptoKey;
    try {
      // Re-wrap needs an EXTRACTABLE handle, so unwrap extractable here (held only for the wrap below).
      dekToRewrap = await crypto.subtle.unwrapKey(
        "raw",
        buf(fromBase64(meta.wrappedDEK)),
        oldKek,
        { name: "AES-GCM", iv: buf(fromBase64(meta.wrapNonce)) },
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"]
      );
    } catch {
      throw new Error("secure-chat: unlock failed (wrong password or corrupt store)");
    }

    // Derive a new KEK from the new password + a fresh salt, and re-wrap the same DEK under it.
    const newSalt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const newKek = await this.#deriveKek(newPassword, newSalt);
    const newWrapNonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const newWrapped = new Uint8Array(
      await crypto.subtle.wrapKey("raw", dekToRewrap, newKek, { name: "AES-GCM", iv: newWrapNonce })
    );
    const newMeta: MetaRecord = {
      version: VERSION,
      kdf: "argon2id",
      kdfParams: { salt: toBase64(newSalt), m: ARGON2_PARAMS.m, t: ARGON2_PARAMS.t, p: ARGON2_PARAMS.p },
      wrappedDEK: toBase64(newWrapped),
      wrapNonce: toBase64(newWrapNonce),
    };
    await this.base.set(META_KEY, utf8(JSON.stringify(newMeta)));
  }

  /**
   * Read and open the value at `key`. A miss returns `null`. On any decrypt/authentication failure it
   * THROWS (fail closed) and never returns raw or partially-decrypted bytes.
   *
   * @param key - The store key (passed through to the base store unencrypted).
   * @returns The decrypted bytes, or `null` if the key is absent.
   * @throws {StoreLockedError} If the store is locked.
   * @throws {Error} If the stored blob is malformed or fails AES-GCM authentication (tamper/corruption).
   */
  async get(key: string): Promise<Uint8Array | null> {
    const dek = this.#requireUnlocked();
    const sealed = await this.base.get(key);
    if (sealed === null) return null;
    if (sealed.length < 1 + NONCE_BYTES || sealed[0] !== VERSION) {
      throw new Error("secure-chat: stored value is malformed (bad header)");
    }
    const nonce = sealed.subarray(1, 1 + NONCE_BYTES);
    const ciphertext = sealed.subarray(1 + NONCE_BYTES);
    let plain: ArrayBuffer;
    try {
      plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(nonce) }, dek, buf(ciphertext));
    } catch {
      // AEAD failure ⇒ wrong key or tampered ciphertext. Fail closed; never return raw bytes.
      throw new Error("secure-chat: value decrypt failed (corrupt or tampered store)");
    }
    return new Uint8Array(plain);
  }

  /**
   * Seal `value` and write it at `key`. Format: `[version:1][nonce:12][AES-GCM ciphertext+tag]`, with
   * a fresh CSPRNG nonce per write.
   *
   * @param key - The store key (passed through unencrypted).
   * @param value - The plaintext bytes to seal.
   * @returns A promise that resolves once the sealed blob is persisted.
   * @throws {StoreLockedError} If the store is locked.
   */
  async set(key: string, value: Uint8Array): Promise<void> {
    const dek = this.#requireUnlocked();
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(nonce) }, dek, buf(value))
    );
    const sealed = new Uint8Array(1 + NONCE_BYTES + ct.length);
    sealed[0] = VERSION;
    sealed.set(nonce, 1);
    sealed.set(ct, 1 + NONCE_BYTES);
    await this.base.set(key, sealed);
  }

  /**
   * Remove `key` from the base store (no-op when absent). Requires the store to be unlocked.
   *
   * @param key - The store key to delete.
   * @returns A promise that resolves once the key is removed.
   * @throws {StoreLockedError} If the store is locked.
   */
  async delete(key: string): Promise<void> {
    this.#requireUnlocked();
    await this.base.delete(key);
  }

  /**
   * List base-store keys starting with `prefix`, with the reserved meta key filtered out so it never
   * surfaces to the repository.
   *
   * @param prefix - The key prefix (`""` for every key).
   * @returns The matching keys, excluding the internal `__enc__` meta record.
   * @throws {StoreLockedError} If the store is locked.
   */
  async list(prefix: string): Promise<string[]> {
    this.#requireUnlocked();
    const keys = await this.base.list(prefix);
    return keys.filter((k) => k !== META_KEY);
  }

  /** Assert the store is unlocked and return the live DEK, else fail closed. */
  #requireUnlocked(): CryptoKey {
    if (this.#dek === null) throw new StoreLockedError();
    return this.#dek;
  }

  /** Stretch the password + salt into a non-extractable AES-GCM KEK with wrap/unwrap usages. */
  async #deriveKek(password: string, salt: Uint8Array): Promise<CryptoKey> {
    const raw = await argon2idAsync(utf8(password), salt, ARGON2_PARAMS);
    try {
      return await crypto.subtle.importKey("raw", buf(raw), { name: "AES-GCM" }, false, [
        "wrapKey",
        "unwrapKey",
      ]);
    } finally {
      raw.fill(0); // zeroize the raw KEK bytes; the CryptoKey handle is non-extractable.
    }
  }

  /** Unwrap the stored DEK under `kek` into a NON-EXTRACTABLE per-value AES-GCM key. */
  async #unwrapDek(kek: CryptoKey, wrapped: Uint8Array, wrapNonce: Uint8Array): Promise<CryptoKey> {
    return crypto.subtle.unwrapKey(
      "raw",
      buf(wrapped),
      kek,
      { name: "AES-GCM", iv: buf(wrapNonce) },
      { name: "AES-GCM", length: 256 },
      false, // non-extractable: the DEK bytes can never be read back out of WebCrypto.
      ["encrypt", "decrypt"]
    );
  }

  /** Parse + minimally validate the meta record; throws (never leaks) on a malformed record. */
  #parseMeta(bytes: Uint8Array): MetaRecord {
    let meta: MetaRecord;
    try {
      meta = JSON.parse(new TextDecoder().decode(bytes)) as MetaRecord;
    } catch {
      throw new Error("secure-chat: store meta record is malformed");
    }
    if (
      meta.version !== VERSION ||
      meta.kdf !== "argon2id" ||
      typeof meta.kdfParams?.salt !== "string" ||
      typeof meta.wrappedDEK !== "string" ||
      typeof meta.wrapNonce !== "string"
    ) {
      throw new Error("secure-chat: unsupported or malformed store meta record");
    }
    return meta;
  }
}

/**
 * Wrap a base {@link SecureChatStore} (normally `createIndexedDBStore()`) with at-rest encryption.
 * Returns a locked store: the app must call `unlock(password)` before mounting `<SecureChatProvider>`,
 * and may `lock()` it on logout/idle. Values are sealed with AES-256-GCM under a DEK that is wrapped by
 * an argon2id-derived KEK; store keys pass through in the clear (see this module's header for scope).
 *
 * @param base - The underlying durable store to seal/open values against.
 * @param opts - {@link EncryptedStoreOptions} (reserved; no effect today).
 * @returns A locked {@link EncryptedStore} — call `unlock(password)` to enable persistence.
 *
 * @example
 * ```ts
 * import { createIndexedDBStore, createEncryptedStore } from "@agora-sdk/secure-chat-react-js";
 *
 * const store = createEncryptedStore(createIndexedDBStore());
 * await store.unlock(userPassword);      // first use mints the DEK; later opens unwrap it
 * // pass `store` to <SecureChatProvider store={store} … />
 * store.lock();                          // drop the in-memory DEK when locking the app
 * ```
 */
export function createEncryptedStore(
  base: SecureChatStore,
  opts: EncryptedStoreOptions = {}
): EncryptedStore {
  return new EncryptedStore(base, opts);
}
