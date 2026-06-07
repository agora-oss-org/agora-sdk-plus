// Web SecureChatStore — IndexedDB-backed durable persistence.
//
// One object store keyed by string, value Uint8Array (structured-cloneable). Plaintext at rest for
// Phase 2 — IndexedDB is readable by any same-origin script; the threat model is "blind server", and
// passphrase backup (task 5) is the recovery path. The DB handle opens lazily on first use.

import type { SecureChatStore } from "@agora-sdk/secure-chat-core";

/** Options for {@link createIndexedDBStore}. */
export interface IndexedDBStoreOptions {
  /** Database name. Default `agora-secure-chat`. */
  dbName?: string;
  /** Object store name. Default `kv`. */
  storeName?: string;
}

function openDb(dbName: string, storeName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(
        new Error(
          "IndexedDB is unavailable here; inject a different SecureChatStore (e.g. MemoryStore)."
        )
      );
      return;
    }
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () =>
      reject(new Error("IndexedDB open blocked by an existing connection — close other tabs and retry."));
  });
}

function runTx<T>(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const req = fn(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(req.result as T);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * Create an IndexedDB-backed {@link SecureChatStore} for the web.
 *
 * @param opts - {@link IndexedDBStoreOptions} — database + object-store names.
 * @returns A durable store; pass it to `<SecureChatProvider store={...}>`.
 * @throws {Error} On first access when `indexedDB` is unavailable (SSR / disabled).
 *
 * @example
 * ```ts
 * <SecureChatProvider store={createIndexedDBStore()} crypto={crypto} projectId={id} />
 * ```
 */
export function createIndexedDBStore(opts: IndexedDBStoreOptions = {}): SecureChatStore {
  const dbName = opts.dbName ?? "agora-secure-chat";
  const storeName = opts.storeName ?? "kv";
  let dbPromise: Promise<IDBDatabase> | null = null;
  const db = () =>
    (dbPromise ??= openDb(dbName, storeName).catch((e) => {
      dbPromise = null; // don't cache a rejection — allow a retry on the next call
      throw e;
    }));

  return {
    async get(key) {
      const v = await runTx<unknown>(await db(), storeName, "readonly", (s) => s.get(key));
      return (v as Uint8Array | undefined) ?? null;
    },
    async set(key, value) {
      await runTx(await db(), storeName, "readwrite", (s) => s.put(value, key));
    },
    async delete(key) {
      await runTx(await db(), storeName, "readwrite", (s) => s.delete(key));
    },
    async list(prefix) {
      const keys = await runTx<IDBValidKey[]>(await db(), storeName, "readonly", (s) =>
        s.getAllKeys()
      );
      return keys.filter((k): k is string => typeof k === "string" && k.startsWith(prefix));
    },
  };
}
