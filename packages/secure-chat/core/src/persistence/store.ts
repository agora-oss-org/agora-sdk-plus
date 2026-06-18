// The persistence seam — a dumb, async key→blob store.
//
// This is ALL a platform must implement: web ships an IndexedDB-backed store, native swaps a
// keystore later. The SDK owns the key schema and (de)serialization on top of this (see
// ./repository.ts); the store itself never interprets keys or values. Values are opaque bytes.
//
// AT-REST POSTURE (honest, per CLAUDE.md §1): besides device identity and MLS group state, this
// store now also holds DECRYPTED MESSAGE PLAINTEXT (`msg:` keys) — the durable conversation history,
// because forward-secret MLS keys are single-use and a message can be decrypted only once. This
// plaintext is LOCAL ONLY; the blind server never sees it. Today's implementations store it as a
// plain blob (web: IndexedDB; tests: MemoryStore), so on-disk at-rest is unencrypted. Encryption at
// rest (argon2id-derived, AEAD-wrapped DB key) is a future drop-in: it lands as a new SecureChatStore
// implementation, leaving the repository and hooks untouched. The seam is the storage abstraction.

/** A platform-agnostic async key→blob store. Implementations: `MemoryStore`, `createIndexedDBStore`. */
export interface SecureChatStore {
  /** Read the bytes at `key`, or `null` if absent. */
  get(key: string): Promise<Uint8Array | null>;
  /** Write `value` at `key`, overwriting any existing value. */
  set(key: string, value: Uint8Array): Promise<void>;
  /** Remove `key` if present (no-op when absent). */
  delete(key: string): Promise<void>;
  /** Return all keys that start with `prefix` (use `""` for every key). */
  list(prefix: string): Promise<string[]>;
}
