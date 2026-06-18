# Encryption at rest for the secure-chat local store (`EncryptedStore`)

**Status:** implemented 2026-06-18 (`@agora-sdk/secure-chat-react-js`)
**Date:** 2026-06-18
**Scope:** A **Phase-2.5** secure-chat feature: seal everything the web client persists — MLS
group/ratchet secrets, the device signing key, decrypted `msg:` history, and delivery cursors — at rest
behind a password, with **zero changes** to the repository, provider, or hooks. Excludes (deliberately
deferred — see *Out of scope*): encrypting store **keys**/metadata, a RAM-cache purge / auto-lock timer,
in-place migration of an existing unencrypted DB, and native (RN/Expo) keystore-backed at-rest.

## Goal

Close the **local at-rest gap**. The Agora server is blind and already never sees plaintext, but on web
the base store is `createIndexedDBStore()`, which writes **plaintext** to IndexedDB — readable by any
same-origin script or anyone with disk access. The MLS group state is the crown jewel (it can decrypt
*and* forge), and the durable `msg:` store (added by the forward-secrecy replay fix) is the conversation
history in the clear. So the correct unit is **whole-store** at-rest encryption, sealed under a key
derived from a user password, surfaced as a drop-in `SecureChatStore` decorator.

This was always the planned Phase-2.5 step: the `SecureChatStore` key→blob seam was built so encryption
lands as a new implementation, not a rewrite of the repository or hooks.

## Decisions (from brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Scope | **Whole store** (every value) | Group secrets + signing key are the crown jewels; encrypting only `msg:` would leave them in the clear. |
| Unlock seam | App calls **`unlock(password)` / `lock()`**; the store owns all crypto | Keeps the password out of the provider/hooks. The **AEAD unlock IS the password check** — no separate stored hash to leak. |
| Key hierarchy (**Approach A**) | `argon2id`→**KEK** (once per unlock) unwraps a random AES-256-GCM **DEK** held as a **non-extractable** `CryptoKey`; per-value AES-GCM | The non-extractable DEK can never be read back out of WebCrypto, even by malicious same-origin JS. Password change re-wraps the same DEK → no bulk re-encryption. |
| *(Considered alt. C)* | XChaCha20-Poly1305 throughout, DEK as raw bytes — **rejected** | Gives up the non-extractable DEK (raw bytes must live in JS memory). Documented here for the record. |
| Lock strength (v1) | **Disk-lock, app-driven**: `lock()` drops the in-memory DEK/KEK | A full RAM-cache purge (provider `groupCache`, `okCache`, crypto in-memory state) + an auto-lock idle timer are later features. |
| Key privacy (v1) | **Encrypt values only**; store keys pass through in the clear | Keys leak conversation ids + per-conversation message counts — which the blind server already observes. Key/metadata encryption is a later feature. |
| Backup | The passphrase→**server** backup path is **deprecated** | Recovery is now device-to-device via **IUC**; local at-rest is this decorator. `exportBackup`/`importBackup`/`PassphraseBackup` get `@deprecated` tags only — full removal is a separate cleanup (touches the crypto interface + agora-server's test devDependency). |

## Architecture

One new unit: **`EncryptedStore`**, a `SecureChatStore` decorator wrapping a base store (normally
`createIndexedDBStore()`). It seals/opens **values** and passes **keys** through. Beyond the four
interface methods (`get`/`set`/`delete`/`list`) it adds `unlock(password)`, `lock()`, `isLocked()`, and
`changePassword(old, new)`, so the app holds the concrete reference to drive lock state while the
provider still receives a plain `SecureChatStore`.

- **KEK** — `argon2idAsync(utf8(password), salt, ARGON2_PARAMS)` (`@noble/hashes/argon2.js`), reusing the
  RFC 9106 "FIRST RECOMMENDED" params from `crypto/src/ts-mls/backup.ts` (`{ m: 65536, t: 3, p: 1, dkLen: 32 }`
  — 64 MiB, t=3, p=1, 32-byte output). Imported into WebCrypto as a **non-extractable** AES-GCM key with
  `["wrapKey","unwrapKey"]`; the raw KEK bytes are zeroized immediately after import.
- **DEK** — a random AES-256-GCM key (`crypto.subtle.generateKey`). Generated **extractable** only so it
  can be wrapped at creation; the in-memory handle is **always** the **non-extractable** `unwrapKey`
  result (re-unwrapped even on first unlock, so the extractable mint handle is dropped). Stored
  **wrapped** under the KEK (`wrapKey("raw", dek, kek, {name:"AES-GCM", iv})`).
- **Reserved meta record** — base-store key `__enc__` (never encrypted, never returned from `list()`):
  `{ version, kdf:"argon2id", kdfParams:{salt,m,t,p}, wrappedDEK, wrapNonce }` (binary fields base64 in
  the JSON). Its presence/absence distinguishes a re-open from a first unlock. Contains no secret in the
  clear — `wrappedDEK` is useless without the password.
- **Per-value format** — `[version:1][nonce:12][AES-GCM ciphertext+tag]`, a fresh CSPRNG 12-byte nonce
  per write (96-bit IV, the WebCrypto/NIST-recommended size).

### Data flow

```
unlock(pw):
  read __enc__
  ├─ absent  → salt = CSPRNG; KEK = argon2id(pw, salt); DEK = generateKey(extractable)
  │            wrappedDEK = wrapKey(DEK, KEK); write __enc__; DEK = unwrapKey(non-extractable)
  └─ present → KEK = argon2id(pw, meta.salt); DEK = unwrapKey(meta.wrappedDEK, KEK)  [non-extractable]
               (unwrap throws ⇒ stay locked, rethrow ONE generic error)

set(k, v):  nonce = CSPRNG; ct = AES-GCM(DEK, nonce, v); base.set(k, [1][nonce][ct])
get(k):     sealed = base.get(k); null→null; bad header→throw; AES-GCM-decrypt→throw on failure (never raw)
list(p):    base.list(p) minus "__enc__"
changePassword(old,new): require unlocked; verify old by unwrap; re-wrap SAME DEK under argon2id(new, freshSalt); rewrite __enc__
```

## Security analysis

| Adversary | Outcome |
|---|---|
| **Disk / device theft, forensic image, same-origin script reading IndexedDB** | Sees only sealed blobs (`[ver][nonce][ct+tag]`) + the `__enc__` meta (salt + wrapped DEK). No plaintext, no key material. Brute-forcing the password is gated by argon2id (64 MiB, t=3). |
| **Tampering with a stored value or the wrapped DEK** | AES-GCM authentication fails → `get`/`unlock` throw and never return raw/partial bytes (fail closed). Wrong password and tamper are **deliberately indistinguishable** (one generic error). |
| **Running, *unlocked* app (memory dump, attached debugger)** | **Not protected (v1, by design).** The DEK and decrypted values are live in memory while unlocked. RAM-cache purge + auto-lock shrink this window — later features. |
| **Keylogger / phishing the password** | Out of scope for encryption-at-rest — no cryptography defends a captured password. |
| **Blind server** | Unchanged: it never saw any of this. This feature is purely local. |

## Known issues & limitations

1. **Values-only (v1).** Store keys are cleartext, leaking conversation ids + per-conversation message
   counts — a subset of what the blind server already sees. Key/metadata encryption is deferred.
2. **Unlocked = exposed.** `lock()` drops only the store's DEK/KEK; plaintext cached in the provider
   (`groupCache`), the `okCache`, and the crypto core's in-memory MLS state survives until reload. A
   true lock must purge those via a lock-event bus — later feature.
3. **Forget the password = local data is unrecoverable.** No backdoor by design. Recovery is
   device-to-device via **IUC**, not a stored hint or server backup.
4. **Random-nonce reuse bound.** A fresh random 96-bit nonce per write has a birthday-bound collision
   risk only past enormous write volumes (~2³² values under one DEK); acceptable and documented for a
   chat client, but not unbounded.
5. **No migration of an existing unencrypted DB (v1).** Assumes a fresh encrypted store; pre-release dev
   data is re-provisioned via IUC or cleared.

## Testing strategy

- **Crypto over real WebCrypto + `fake-indexeddb` (jsdom):** round-trip (the stored blob differs from the
  input and begins with the version byte — proves it's sealed); wrong password fails closed (throws,
  stays locked, no plaintext); tamper fails closed (flip a byte → `get` throws, never raw bytes);
  malformed header fails closed; `lock()` → `get/set/delete/list` throw `StoreLockedError`, `unlock`
  restores; cross-instance persistence (fresh instance over the same base db + password reads values);
  password change (old fails, new opens the same values — same DEK re-wrapped, no data loss; wrong old
  leaves the store intact; locked → `StoreLockedError`); `__enc__` hidden from `list()`.
- **Repository obliviousness:** a `SecureChatRepository` device/group/message-plaintext round-trip over
  an `EncryptedStore` wrapping the IndexedDB base — proves the repository/hooks need no changes.
- **No-leak scan:** a stored `msg:` value never contains the message's UTF-8 byte subsequence.
- *(cross-realm gotcha):* `instanceof Uint8Array` / `expect.any(Uint8Array)` are unreliable across the
  Node↔jsdom realm boundary; assertions check length/byte content instead.

## Out of scope / future

- Encrypting store **keys**/metadata (HMAC-tokenized keys + encrypted prefix index) to close the
  message-count leak.
- Full RAM-cache purge on `lock()` (provider `groupCache` / `okCache` / crypto in-memory state via a
  lock-event bus) + a built-in auto-lock idle timer.
- In-place migration of an existing unencrypted IndexedDB.
- Native (RN/Expo) keystore-backed at-rest; full removal of the deprecated passphrase-backup methods.

## Relationship to existing architecture

- **Builds on** the `SecureChatStore` key→blob seam (`core/src/persistence/store.ts`) — the decorator
  wraps any base store, so `MemoryStore`/IndexedDB/future keystores all compose with it unchanged.
- **Reuses** the argon2id RFC 9106 params from `crypto/src/ts-mls/backup.ts` (`ARGON2_PARAMS`).
- **Supersedes** the passphrase→server backup path for at-rest protection (now `@deprecated`), pairing
  with **IUC** (`2026-06-18-iuc-history-restore-design.md`) for recovery: this seals the device that has
  the data; IUC restores a device that lost it.
- **Lands entirely in** `@agora-sdk/secure-chat-react-js` (the ESM-only web package); core, provider, and
  hooks are untouched.
