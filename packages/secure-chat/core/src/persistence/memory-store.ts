// In-memory SecureChatStore — the provider default and the unit-test backing store.
//
// Not persistent: state is lost on reload. Platforms inject a durable store (IndexedDB on web) for
// real persistence; this keeps core usable in tests and SSR without one.

import type { SecureChatStore } from "./store.js";

/** A `Map`-backed {@link SecureChatStore}. Non-persistent; the default when no store is injected. */
export class MemoryStore implements SecureChatStore {
  private readonly map = new Map<string, Uint8Array>();

  async get(key: string): Promise<Uint8Array | null> {
    return this.map.get(key) ?? null;
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    this.map.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix));
  }
}
