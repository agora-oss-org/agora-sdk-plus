# Secure Chat Persistence Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make secure-chat device identity and MLS group state survive a browser reload by adding a persistence seam, wiring it through the provider, and making the three hooks self-sufficient.

**Architecture:** A dumb generic key→blob store (`SecureChatStore`) is the platform seam (in-memory default; IndexedDB on web). A typed `SecureChatRepository` in core owns the key schema and serialization. `SecureChatProvider` injects the store, builds the repository, and exposes a cached `resolveGroup`/`rememberGroup`. The `SecureChatCrypto` seam gains `exportDeviceState`/`importDeviceState` so a real MLS core can re-hydrate identity after a reload.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), React 18 hooks, vitest + @testing-library/react (jsdom), fake-indexeddb, the existing `MockSecureChatCrypto`.

**Spec:** `docs/superpowers/specs/2026-06-06-secure-chat-persistence-design.md`

**Conventions (match these exactly):**
- Relative imports use explicit `.js` extensions (`../util/base64.js`).
- Cross-package imports use the package name (`@agora-sdk/secure-chat-crypto`, `@agora-sdk/secure-chat-core`).
- Every exported symbol gets a TSDoc block (repo standard). Run `pnpm test` and `pnpm run typecheck` — both must stay green.
- Commit after each task.

---

### Task 1: Crypto seam — device-state export/import

**Files:**
- Modify: `packages/secure-chat/crypto/src/interface.ts`
- Modify: `packages/secure-chat/crypto/src/mock-crypto.ts`
- Test: `packages/secure-chat/crypto/src/mock-crypto.test.ts`

- [ ] **Step 1: Write the failing test** — append to `packages/secure-chat/crypto/src/mock-crypto.test.ts`:

```ts
describe("MockSecureChatCrypto device-state persistence", () => {
  it("re-hydrates identity into a fresh instance and decrypts a rejoined group", async () => {
    const { alice, aliceGroup } = await twoPartyGroup();
    const { ciphertext } = await alice.encryptMessage(aliceGroup, utf8("after reload"));
    const deviceState = await alice.exportDeviceState();
    const groupState = await alice.exportGroupState(aliceGroup);

    const restored = new MockSecureChatCrypto();
    const identity = await restored.importDeviceState(deviceState);
    expect(identity.deviceId).toBe("alice-dev");

    const handle = await restored.importGroupState(groupState);
    const out = await restored.decryptMessage(handle, ciphertext);
    expect(fromUtf8(out.plaintext)).toBe("after reload");
  });

  it("throws when exporting with no identity generated", async () => {
    const c = new MockSecureChatCrypto();
    await expect(c.exportDeviceState()).rejects.toThrow(/no device identity/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/secure-chat/crypto/src/mock-crypto.test.ts`
Expected: FAIL — `restored.importDeviceState is not a function` / `alice.exportDeviceState is not a function`.

- [ ] **Step 3: Add the interface methods** — in `packages/secure-chat/crypto/src/interface.ts`, immediately after the `importGroupState` line (`importGroupState(state: Uint8Array): Promise<GroupHandle>;`), insert:

```ts

  // ── device-state persistence (re-hydrate identity after a reload) ───────────
  /** Serialize this device's identity + private state to an opaque blob for persistence. */
  exportDeviceState(): Promise<Uint8Array>;
  /** Restore device identity + private state from {@link exportDeviceState} output. */
  importDeviceState(state: Uint8Array): Promise<DeviceIdentity>;
```

- [ ] **Step 4: Implement in the mock** — in `packages/secure-chat/crypto/src/mock-crypto.ts`, add these two methods to the `MockSecureChatCrypto` class, immediately before `async exportGroupState(`:

```ts
  async exportDeviceState(): Promise<Uint8Array> {
    if (!this.identity || !this.privateState) {
      throw new Error("mock: no device identity to export (call generateDeviceIdentity first)");
    }
    return jsonBytes({
      deviceId: this.identity.deviceId,
      ciphersuite: this.identity.ciphersuite,
      signaturePublicKey: toHex(this.identity.signaturePublicKey),
      credential: toHex(this.identity.credential),
      privateState: toHex(this.privateState),
    });
  }

  async importDeviceState(state: Uint8Array): Promise<DeviceIdentity> {
    const s = parseJson<{
      deviceId: string;
      ciphersuite: number;
      signaturePublicKey: string;
      credential: string;
      privateState: string;
    }>(state);
    const identity: DeviceIdentity = {
      deviceId: s.deviceId,
      ciphersuite: s.ciphersuite,
      signaturePublicKey: fromHex(s.signaturePublicKey),
      credential: fromHex(s.credential),
    };
    this.identity = identity;
    this.privateState = fromHex(s.privateState);
    return identity;
  }

```

(`jsonBytes`, `parseJson`, `toHex`, `fromHex`, and the `DeviceIdentity` import already exist in this file.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/secure-chat/crypto/src/mock-crypto.test.ts`
Expected: PASS (all device-state tests green).

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm run typecheck
git add packages/secure-chat/crypto/src/interface.ts packages/secure-chat/crypto/src/mock-crypto.ts packages/secure-chat/crypto/src/mock-crypto.test.ts
git commit -m "feat(crypto): add exportDeviceState/importDeviceState to the seam"
```

---

### Task 2: SecureChatStore seam + MemoryStore

**Files:**
- Create: `packages/secure-chat/core/src/persistence/store.ts`
- Create: `packages/secure-chat/core/src/persistence/memory-store.ts`
- Test: `packages/secure-chat/core/src/persistence/memory-store.test.ts`

- [ ] **Step 1: Create the seam interface** — `packages/secure-chat/core/src/persistence/store.ts`:

```ts
// The persistence seam — a dumb, async key→blob store.
//
// This is ALL a platform must implement: web ships an IndexedDB-backed store, native swaps a
// keystore later. The SDK owns the key schema and (de)serialization on top of this (see
// ./repository.ts); the store itself never interprets keys or values. Values are opaque bytes.

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
```

- [ ] **Step 2: Write the failing test** — `packages/secure-chat/core/src/persistence/memory-store.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { MemoryStore } from "./memory-store.js";

const bytes = (...xs: number[]) => new Uint8Array(xs);

describe("MemoryStore", () => {
  it("round-trips get/set and returns null for missing keys", async () => {
    const s = new MemoryStore();
    expect(await s.get("missing")).toBeNull();
    await s.set("k", bytes(1, 2, 3));
    expect(await s.get("k")).toEqual(bytes(1, 2, 3));
  });

  it("deletes keys", async () => {
    const s = new MemoryStore();
    await s.set("k", bytes(9));
    await s.delete("k");
    expect(await s.get("k")).toBeNull();
  });

  it("lists keys by prefix", async () => {
    const s = new MemoryStore();
    await s.set("group:a", bytes(1));
    await s.set("group:b", bytes(2));
    await s.set("device", bytes(3));
    expect((await s.list("group:")).sort()).toEqual(["group:a", "group:b"]);
    expect((await s.list("")).sort()).toEqual(["device", "group:a", "group:b"]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/secure-chat/core/src/persistence/memory-store.test.ts`
Expected: FAIL — cannot resolve `./memory-store.js`.

- [ ] **Step 4: Implement MemoryStore** — `packages/secure-chat/core/src/persistence/memory-store.ts`:

```ts
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/secure-chat/core/src/persistence/memory-store.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/secure-chat/core/src/persistence/store.ts packages/secure-chat/core/src/persistence/memory-store.ts packages/secure-chat/core/src/persistence/memory-store.test.ts
git commit -m "feat(core): add SecureChatStore seam + MemoryStore"
```

---

### Task 3: SecureChatRepository (typed façade)

**Files:**
- Create: `packages/secure-chat/core/src/persistence/repository.ts`
- Test: `packages/secure-chat/core/src/persistence/repository.test.ts`

- [ ] **Step 1: Write the failing test** — `packages/secure-chat/core/src/persistence/repository.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { MemoryStore } from "./memory-store.js";
import { SecureChatRepository } from "./repository.js";
import type { SecureDeviceModel } from "../contract/index.js";

const bytes = (...xs: number[]) => new Uint8Array(xs);

const deviceRow: SecureDeviceModel = {
  id: "row-1",
  projectId: "p",
  userId: "u",
  deviceId: "dev-1",
  displayName: null,
  signaturePublicKey: "",
  credential: "",
  ciphersuite: 1,
  revokedAt: null,
  lastSeenAt: null,
  createdAt: "",
  updatedAt: "",
};

describe("SecureChatRepository", () => {
  it("round-trips the device record (incl. binary deviceState)", async () => {
    const repo = new SecureChatRepository(new MemoryStore());
    expect(await repo.loadDevice()).toBeNull();
    await repo.saveDevice({ deviceId: "dev-1", deviceState: bytes(1, 2, 250), device: deviceRow });
    const loaded = await repo.loadDevice();
    expect(loaded?.deviceId).toBe("dev-1");
    expect(loaded?.deviceState).toEqual(bytes(1, 2, 250));
    expect(loaded?.device?.id).toBe("row-1");
  });

  it("round-trips group state and lists conversation ids", async () => {
    const repo = new SecureChatRepository(new MemoryStore());
    await repo.saveGroupState("c1", bytes(7, 8));
    await repo.saveGroupState("c2", bytes(9));
    expect(await repo.loadGroupState("c1")).toEqual(bytes(7, 8));
    expect((await repo.listGroupConversationIds()).sort()).toEqual(["c1", "c2"]);
    await repo.deleteGroupState("c1");
    expect(await repo.loadGroupState("c1")).toBeNull();
  });

  it("round-trips the handshake cursor", async () => {
    const repo = new SecureChatRepository(new MemoryStore());
    expect(await repo.loadHandshakeCursor()).toBeNull();
    await repo.saveHandshakeCursor("42");
    expect(await repo.loadHandshakeCursor()).toBe("42");
  });

  it("clearAll wipes every key", async () => {
    const store = new MemoryStore();
    const repo = new SecureChatRepository(store);
    await repo.saveDevice({ deviceId: "d", deviceState: bytes(1), device: null });
    await repo.saveGroupState("c1", bytes(2));
    await repo.saveHandshakeCursor("3");
    await repo.clearAll();
    expect(await store.list("")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/secure-chat/core/src/persistence/repository.test.ts`
Expected: FAIL — cannot resolve `./repository.js`.

- [ ] **Step 3: Implement the repository** — `packages/secure-chat/core/src/persistence/repository.ts`:

```ts
// SecureChatRepository — typed façade over a SecureChatStore.
//
// The ONLY place in the SDK that knows the persistence key strings and how each record is
// serialized. Binary fields are base64-wrapped inside JSON; opaque crypto blobs (group/device
// state) are stored as-is. Built by SecureChatProvider over the injected store.

import type { SecureDeviceModel } from "../contract/index.js";
import type { SecureChatStore } from "./store.js";
import { toBase64, fromBase64, utf8ToBytes, bytesToUtf8 } from "../util/base64.js";

const DEVICE_KEY = "device";
const GROUP_PREFIX = "group:";
const CURSOR_KEY = "handshake:cursor";

/** The persisted device record: stable id, opaque crypto device-state, and the server row. */
export interface PersistedDevice {
  /** Stable MLS device id; survives reload. */
  deviceId: string;
  /** Opaque bytes from `crypto.exportDeviceState()`. */
  deviceState: Uint8Array;
  /** The registered server row (rehydrates UI without a refetch), or `null` if not yet registered. */
  device: SecureDeviceModel | null;
}

interface DeviceRecord {
  deviceId: string;
  deviceState: string; // base64
  device: SecureDeviceModel | null;
}

/** Typed persistence for device identity, per-conversation group state, and the handshake cursor. */
export class SecureChatRepository {
  constructor(private readonly store: SecureChatStore) {}

  /** Load the persisted device record, or `null` if none saved (first run / evicted). */
  async loadDevice(): Promise<PersistedDevice | null> {
    const bytes = await this.store.get(DEVICE_KEY);
    if (!bytes) return null;
    const rec = JSON.parse(bytesToUtf8(bytes)) as DeviceRecord;
    return { deviceId: rec.deviceId, deviceState: fromBase64(rec.deviceState), device: rec.device };
  }

  /** Persist (replace) the device record. */
  async saveDevice(d: PersistedDevice): Promise<void> {
    const rec: DeviceRecord = {
      deviceId: d.deviceId,
      deviceState: toBase64(d.deviceState),
      device: d.device,
    };
    await this.store.set(DEVICE_KEY, utf8ToBytes(JSON.stringify(rec)));
  }

  /** Remove the persisted device record. */
  async clearDevice(): Promise<void> {
    await this.store.delete(DEVICE_KEY);
  }

  /** Load opaque MLS group state for a conversation, or `null` if none. */
  async loadGroupState(conversationId: string): Promise<Uint8Array | null> {
    return this.store.get(GROUP_PREFIX + conversationId);
  }

  /** Persist opaque MLS group state for a conversation. */
  async saveGroupState(conversationId: string, state: Uint8Array): Promise<void> {
    await this.store.set(GROUP_PREFIX + conversationId, state);
  }

  /** Remove persisted group state for a conversation. */
  async deleteGroupState(conversationId: string): Promise<void> {
    await this.store.delete(GROUP_PREFIX + conversationId);
  }

  /** List the conversation ids that have persisted group state. */
  async listGroupConversationIds(): Promise<string[]> {
    const keys = await this.store.list(GROUP_PREFIX);
    return keys.map((k) => k.slice(GROUP_PREFIX.length));
  }

  /** Load the persisted handshake delivery cursor (`seq`), or `null`. */
  async loadHandshakeCursor(): Promise<string | null> {
    const bytes = await this.store.get(CURSOR_KEY);
    return bytes ? bytesToUtf8(bytes) : null;
  }

  /** Persist the handshake delivery cursor (`seq`). */
  async saveHandshakeCursor(seq: string): Promise<void> {
    await this.store.set(CURSOR_KEY, utf8ToBytes(seq));
  }

  /** Wipe all persisted secure-chat state (sign-out / device revoke). */
  async clearAll(): Promise<void> {
    const keys = await this.store.list("");
    await Promise.all(keys.map((k) => this.store.delete(k)));
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/secure-chat/core/src/persistence/repository.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm run typecheck
git add packages/secure-chat/core/src/persistence/repository.ts packages/secure-chat/core/src/persistence/repository.test.ts
git commit -m "feat(core): add SecureChatRepository typed persistence facade"
```

---

### Task 4: Provider wiring + jsdom test harness

**Files:**
- Modify: `packages/secure-chat/core/src/context/secure-chat-context.tsx` (full new content below)
- Test: `packages/secure-chat/core/src/context/secure-chat-context.test.tsx`
- Modify: root `package.json` (add dev deps)

- [ ] **Step 1: Install the jsdom hook-test harness** (first hook test)

```bash
pnpm add -Dw jsdom @testing-library/react react-dom
```
Expected: `jsdom`, `@testing-library/react`, `react-dom` added under root `devDependencies`.

- [ ] **Step 2: Replace the context file** — overwrite `packages/secure-chat/core/src/context/secure-chat-context.tsx` with:

```tsx
// SecureChatProvider — wires transport + crypto + persistence for the secure-chat hooks.
//
// Sits INSIDE a ReplykeProvider: by default it resolves the API base URL and socket origin from
// @agora-sdk/core's runtime singletons (getApiBaseUrl / getSocketUrl). Crypto AND the persistence
// store are injected, keeping core platform- and library-agnostic. The provider builds a typed
// SecureChatRepository over the store plus a cached resolveGroup/rememberGroup so the hooks become
// self-sufficient (no need to thread a GroupHandle in by hand).

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef } from "react";
import { getApiBaseUrl, getSocketUrl } from "@agora-sdk/core";
import { SecureChatCrypto, GroupHandle } from "@agora-sdk/secure-chat-crypto";

import { SecureChatRestClient } from "../transport/rest.js";
import { SecureChatSocketClient } from "../transport/socket.js";
import { SecureChatStore } from "../persistence/store.js";
import { MemoryStore } from "../persistence/memory-store.js";
import { SecureChatRepository } from "../persistence/repository.js";

/**
 * The value exposed by {@link useSecureChat}: shared transport clients, the injected crypto, the
 * persistence repository, the group-handle resolver, and the active project id.
 */
export interface SecureChatContextValue {
  /** REST client for the blind Delivery Service endpoints. */
  rest: SecureChatRestClient;
  /** Realtime client for the `/secure` socket.io namespace. */
  socket: SecureChatSocketClient;
  /** The injected MLS crypto implementation. */
  crypto: SecureChatCrypto;
  /** Typed persistence over the injected store. */
  repo: SecureChatRepository;
  /** Resolve a conversation's MLS group handle (cache → store → importGroupState), or `null`. */
  resolveGroup: (conversationId: string) => Promise<GroupHandle | null>;
  /** Cache + persist a conversation's group handle (after createGroup / processWelcome). */
  rememberGroup: (conversationId: string, handle: GroupHandle) => Promise<void>;
  /** The Agora project id these clients are scoped to. */
  projectId: string;
}

const SecureChatContext = createContext<SecureChatContextValue | null>(null);

/** Props for {@link SecureChatProvider}. */
export interface SecureChatProviderProps {
  /** The MLS crypto implementation (mock for tests; ts-mls/OpenMLS-WASM in platform packages). */
  crypto: SecureChatCrypto;
  /** Agora project id (path-scoped on every endpoint). */
  projectId: string;
  /** Persistence store. Defaults to a non-persistent in-memory store when omitted. */
  store?: SecureChatStore;
  /** Current access token. Re-pass on refresh; read lazily per request. */
  accessToken?: string;
  /** Override token resolution (takes precedence over `accessToken`). */
  getAccessToken?: () => string | undefined;
  /** Override the API base URL. Defaults to @agora-sdk/core `getApiBaseUrl()`. */
  baseUrl?: string;
  /** Override the socket origin. Defaults to @agora-sdk/core `getSocketUrl()`. */
  socketUrl?: string;
  children: React.ReactNode;
}

/**
 * Provides secure-chat transport, crypto, and persistence to the `useSecure*` hooks. Render inside a
 * `ReplykeProvider`; disconnects the socket on unmount.
 *
 * @param props - {@link SecureChatProviderProps}.
 * @returns A context provider wrapping `children`.
 *
 * @example
 * ```tsx
 * <SecureChatProvider crypto={crypto} projectId={projectId} store={createIndexedDBStore()} accessToken={token}>
 *   <Chat />
 * </SecureChatProvider>
 * ```
 */
export function SecureChatProvider({
  crypto,
  projectId,
  store,
  accessToken,
  getAccessToken,
  baseUrl,
  socketUrl,
  children,
}: SecureChatProviderProps) {
  const tokenRef = useRef<string | undefined>(accessToken);
  tokenRef.current = accessToken;

  const resolveToken = useMemo(
    () => getAccessToken ?? (() => tokenRef.current),
    [getAccessToken]
  );

  const rest = useMemo(
    () =>
      new SecureChatRestClient({
        projectId,
        getAccessToken: resolveToken,
        getBaseUrl: () => baseUrl ?? getApiBaseUrl(),
      }),
    [projectId, resolveToken, baseUrl]
  );

  const socket = useMemo(
    () =>
      new SecureChatSocketClient({
        projectId,
        getAccessToken: resolveToken,
        getSocketUrl: () => socketUrl ?? getSocketUrl(),
      }),
    [projectId, resolveToken, socketUrl]
  );

  const resolvedStore = useMemo(() => store ?? new MemoryStore(), [store]);
  const repo = useMemo(() => new SecureChatRepository(resolvedStore), [resolvedStore]);

  // In-memory GroupHandle cache, keyed by conversationId. Survives re-renders via the ref.
  const groupCache = useRef(new Map<string, GroupHandle>());

  const resolveGroup = useCallback(
    async (conversationId: string): Promise<GroupHandle | null> => {
      const cached = groupCache.current.get(conversationId);
      if (cached) return cached;
      const bytes = await repo.loadGroupState(conversationId);
      if (!bytes) return null;
      const handle = await crypto.importGroupState(bytes);
      groupCache.current.set(conversationId, handle);
      return handle;
    },
    [repo, crypto]
  );

  const rememberGroup = useCallback(
    async (conversationId: string, handle: GroupHandle): Promise<void> => {
      groupCache.current.set(conversationId, handle);
      const bytes = await crypto.exportGroupState(handle);
      await repo.saveGroupState(conversationId, bytes);
    },
    [repo, crypto]
  );

  useEffect(() => {
    return () => socket.disconnect();
  }, [socket]);

  const value = useMemo<SecureChatContextValue>(
    () => ({ rest, socket, crypto, repo, resolveGroup, rememberGroup, projectId }),
    [rest, socket, crypto, repo, resolveGroup, rememberGroup, projectId]
  );

  return <SecureChatContext.Provider value={value}>{children}</SecureChatContext.Provider>;
}

/**
 * Access the nearest {@link SecureChatContextValue}.
 *
 * @returns The shared rest/socket/crypto/repo/resolveGroup/projectId for this provider subtree.
 * @throws {Error} When called outside a `<SecureChatProvider>`.
 */
export function useSecureChat(): SecureChatContextValue {
  const ctx = useContext(SecureChatContext);
  if (!ctx) {
    throw new Error("useSecureChat must be used within a <SecureChatProvider>.");
  }
  return ctx;
}
```

- [ ] **Step 3: Write the failing test** — `packages/secure-chat/core/src/context/secure-chat-context.test.tsx`:

```tsx
// @vitest-environment jsdom
import React from "react";
import { describe, it, expect } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { MockSecureChatCrypto } from "@agora-sdk/secure-chat-crypto/testing";
import { SecureChatProvider, useSecureChat } from "./secure-chat-context.js";
import { MemoryStore } from "../persistence/memory-store.js";

describe("SecureChatProvider persistence wiring", () => {
  it("resolveGroup loads + imports persisted group state; rememberGroup persists it", async () => {
    const crypto = new MockSecureChatCrypto();
    await crypto.generateDeviceIdentity({ deviceId: "dev" });
    const { group } = await crypto.createGroup({ initialMembers: [] });
    const store = new MemoryStore();

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <SecureChatProvider crypto={crypto} projectId="p" store={store} accessToken="t">
        {children}
      </SecureChatProvider>
    );
    const { result } = renderHook(() => useSecureChat(), { wrapper });

    // Nothing persisted yet → null.
    expect(await result.current.resolveGroup("c1")).toBeNull();

    // Remember, then resolve from a cold cache key.
    await result.current.rememberGroup("c1", group);
    const resolved = await result.current.resolveGroup("c1");
    expect(resolved).not.toBeNull();
    expect(await store.get("group:c1")).not.toBeNull();
  });

  it("throws when useSecureChat is used outside the provider", () => {
    expect(() => renderHook(() => useSecureChat())).toThrow(/within a <SecureChatProvider>/);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails, then passes**

Run: `pnpm exec vitest run packages/secure-chat/core/src/context/secure-chat-context.test.tsx`
Expected: PASS (the provider already has the wiring from Step 2; this confirms it). If `renderHook` is undefined, re-check Step 1 installed `@testing-library/react`.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm run typecheck
git add packages/secure-chat/core/src/context/secure-chat-context.tsx packages/secure-chat/core/src/context/secure-chat-context.test.tsx package.json pnpm-lock.yaml
git commit -m "feat(core): inject store + expose repo/resolveGroup/rememberGroup on the provider"
```

---

### Task 5: useSecureDevice — persist + re-hydrate identity

**Files:**
- Modify: `packages/secure-chat/core/src/hooks/useSecureDevice.tsx` (full new content below)
- Test: `packages/secure-chat/core/src/hooks/useSecureDevice.test.tsx`

- [ ] **Step 1: Replace the hook file** — overwrite `packages/secure-chat/core/src/hooks/useSecureDevice.tsx` with:

```tsx
// useSecureDevice — register this client as an MLS device (leaf), persist its identity, and keep its
// KeyPackages topped up.
//
// On mount it re-hydrates a persisted device (stable deviceId + private state via
// crypto.importDeviceState) so a reload does NOT mint a new identity. register() generates, registers
// on the server, and persists. Replenishes on the `secure:key-packages-low` realtime signal.

import { useCallback, useEffect, useRef, useState } from "react";
import { SecureDeviceModel } from "../contract/index.js";
import { toBase64 } from "../util/base64.js";
import { useSecureChat } from "../context/secure-chat-context.js";

/**
 * Mint a device id when the caller doesn't supply one — `crypto.randomUUID()` when available, else a
 * non-cryptographic timestamp+random fallback.
 *
 * @returns A fresh device id string.
 */
function newDeviceId(): string {
  const g = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (g?.randomUUID) return g.randomUUID();
  return `dev-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/** Options for {@link useSecureDevice}. */
export interface UseSecureDeviceOptions {
  /** Stable, persisted client device id. Generated (and persisted) if omitted. */
  deviceId?: string;
  /** MLS ciphersuite to register under. Defaults to the crypto implementation's preferred suite. */
  ciphersuite?: number;
  /** How many KeyPackages to publish on registration and replenish toward. Default 20. */
  keyPackageTarget?: number;
  /** Auto-replenish when `secure:key-packages-low` fires. Default true. */
  autoReplenish?: boolean;
}

/** The state and actions returned by {@link useSecureDevice}. */
export interface UseSecureDeviceValues {
  /** The registered device row (its `.id` is the uuid used as targetDeviceId everywhere). */
  device: SecureDeviceModel | null;
  /** True until the initial persisted-device load settles. */
  loading: boolean;
  /** True while {@link UseSecureDeviceValues.register} is in flight. */
  registering: boolean;
  /** The last error thrown by load, registration, or replenishment, or `null`. */
  error: unknown;
  /** Last known count of unconsumed KeyPackages, or `null` until refreshed. */
  keyPackagesAvailable: number | null;
  /** Generate identity + register (idempotent server-side on (userId, deviceId)) and persist it. */
  register: () => Promise<SecureDeviceModel>;
  /** Generate + publish `count` fresh KeyPackages (default = keyPackageTarget). */
  publishKeyPackages: (count?: number) => Promise<number>;
  /** Re-query the server for the available KeyPackage count and update `keyPackagesAvailable`. */
  refreshKeyPackageCount: () => Promise<number>;
}

/**
 * Register this client as an MLS device, persist its identity, and keep KeyPackages stocked.
 *
 * On mount it loads any persisted device and re-hydrates the crypto identity (stable id, no
 * re-register). When none exists, await {@link UseSecureDeviceValues.register}.
 *
 * @param options - {@link UseSecureDeviceOptions}.
 * @returns {@link UseSecureDeviceValues}.
 *
 * @example
 * ```tsx
 * const { device, loading, register } = useSecureDevice();
 * useEffect(() => { if (!loading && !device) register(); }, [loading, device]);
 * ```
 */
export function useSecureDevice(options: UseSecureDeviceOptions = {}): UseSecureDeviceValues {
  const { crypto, rest, socket, repo } = useSecureChat();
  const { ciphersuite, keyPackageTarget = 20, autoReplenish = true } = options;

  const [device, setDevice] = useState<SecureDeviceModel | null>(null);
  const [loading, setLoading] = useState(true);
  const [registering, setRegistering] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [keyPackagesAvailable, setKeyPackagesAvailable] = useState<number | null>(null);

  const deviceIdRef = useRef<string>(options.deviceId ?? newDeviceId());

  // On mount: re-hydrate a persisted device (stable id + private state). No persisted device ⇒
  // first-run; the app calls register().
  useEffect(() => {
    let alive = true;
    (async () => {
      const persisted = await repo.loadDevice();
      if (!alive) return;
      if (persisted) {
        await crypto.importDeviceState(persisted.deviceState);
        if (!alive) return;
        deviceIdRef.current = persisted.deviceId;
        setDevice(persisted.device);
      }
      setLoading(false);
    })().catch((err) => {
      if (!alive) return;
      setError(err);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [repo, crypto]);

  const publishKeyPackages = useCallback(
    async (count: number = keyPackageTarget): Promise<number> => {
      if (!device) throw new Error("Register the device before publishing KeyPackages.");
      const bundles = await crypto.generateKeyPackages(count);
      const published = await rest.publishKeyPackages(device.id, {
        keyPackages: bundles.map((b) => ({
          keyPackageRef: b.keyPackageRef,
          keyPackage: toBase64(b.keyPackage),
          ciphersuite: b.ciphersuite,
          expiresAt: b.expiresAt,
        })),
      });
      return published;
    },
    [crypto, rest, device, keyPackageTarget]
  );

  const refreshKeyPackageCount = useCallback(async (): Promise<number> => {
    if (!device) throw new Error("Register the device before checking KeyPackage count.");
    const available = await rest.keyPackageCount(device.id);
    setKeyPackagesAvailable(available);
    return available;
  }, [rest, device]);

  const register = useCallback(async (): Promise<SecureDeviceModel> => {
    setRegistering(true);
    setError(null);
    try {
      const { identity } = await crypto.generateDeviceIdentity({
        deviceId: deviceIdRef.current,
        ciphersuite,
      });
      const registered = await rest.registerDevice({
        deviceId: identity.deviceId,
        signaturePublicKey: toBase64(identity.signaturePublicKey),
        credential: toBase64(identity.credential),
        ciphersuite: identity.ciphersuite,
      });
      const deviceState = await crypto.exportDeviceState();
      await repo.saveDevice({ deviceId: identity.deviceId, deviceState, device: registered });
      deviceIdRef.current = identity.deviceId;
      setDevice(registered);
      return registered;
    } catch (err) {
      setError(err);
      throw err;
    } finally {
      setRegistering(false);
    }
  }, [crypto, rest, repo, ciphersuite]);

  // Auto-replenish on the server's low-water signal for this device.
  useEffect(() => {
    if (!autoReplenish || !device) return;
    const off = socket.on("secure:key-packages-low", (signal) => {
      if (signal.deviceId !== device.id) return;
      publishKeyPackages().catch(setError);
    });
    return off;
  }, [autoReplenish, device, socket, publishKeyPackages]);

  return {
    device,
    loading,
    registering,
    error,
    keyPackagesAvailable,
    register,
    publishKeyPackages,
    refreshKeyPackageCount,
  };
}
```

- [ ] **Step 2: Write the failing test** — `packages/secure-chat/core/src/hooks/useSecureDevice.test.tsx`:

```tsx
// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { MockSecureChatCrypto } from "@agora-sdk/secure-chat-crypto/testing";
import { SecureChatProvider } from "../context/secure-chat-context.js";
import { useSecureDevice } from "./useSecureDevice.js";
import { MemoryStore } from "../persistence/memory-store.js";
import { SecureChatRepository } from "../persistence/repository.js";
import { SecureChatRestClient } from "../transport/rest.js";
import { SecureChatSocketClient } from "../transport/socket.js";
import type { SecureDeviceModel } from "../contract/index.js";

const row = (id: string, deviceId: string): SecureDeviceModel => ({
  id, projectId: "p", userId: "u", deviceId, displayName: null,
  signaturePublicKey: "", credential: "", ciphersuite: 1,
  revokedAt: null, lastSeenAt: null, createdAt: "", updatedAt: "",
});

function wrap(crypto: MockSecureChatCrypto, store: MemoryStore) {
  return ({ children }: { children: React.ReactNode }) => (
    <SecureChatProvider crypto={crypto} projectId="p" store={store} accessToken="t">
      {children}
    </SecureChatProvider>
  );
}

beforeEach(() => {
  vi.spyOn(SecureChatSocketClient.prototype, "on").mockReturnValue(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("useSecureDevice", () => {
  it("registers and persists the device", async () => {
    const reg = vi
      .spyOn(SecureChatRestClient.prototype, "registerDevice")
      .mockResolvedValue(row("row-1", "dev-x"));
    const crypto = new MockSecureChatCrypto();
    const store = new MemoryStore();

    const { result } = renderHook(() => useSecureDevice({ deviceId: "dev-x" }), {
      wrapper: wrap(crypto, store),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.register();
    });

    expect(reg).toHaveBeenCalledOnce();
    expect(result.current.device?.id).toBe("row-1");
    const persisted = await new SecureChatRepository(store).loadDevice();
    expect(persisted?.deviceId).toBe("dev-x");
    expect(persisted?.device?.id).toBe("row-1");
  });

  it("re-hydrates a persisted device on mount without re-registering", async () => {
    const reg = vi.spyOn(SecureChatRestClient.prototype, "registerDevice");
    const crypto = new MockSecureChatCrypto();
    const store = new MemoryStore();

    // Seed persisted state as if a prior session registered.
    await crypto.generateDeviceIdentity({ deviceId: "dev-x" });
    await new SecureChatRepository(store).saveDevice({
      deviceId: "dev-x",
      deviceState: await crypto.exportDeviceState(),
      device: row("row-1", "dev-x"),
    });

    const fresh = new MockSecureChatCrypto();
    const { result } = renderHook(() => useSecureDevice(), { wrapper: wrap(fresh, store) });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.device?.id).toBe("row-1");
    expect(reg).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails, then passes**

Run: `pnpm exec vitest run packages/secure-chat/core/src/hooks/useSecureDevice.test.tsx`
Expected: PASS once the Step 1 rewrite is in place. (If it fails on `loading`, confirm the new `loading` state shipped.)

- [ ] **Step 4: Typecheck + commit**

```bash
pnpm run typecheck
git add packages/secure-chat/core/src/hooks/useSecureDevice.tsx packages/secure-chat/core/src/hooks/useSecureDevice.test.tsx
git commit -m "feat(core): persist + re-hydrate device identity in useSecureDevice"
```

---

### Task 6: useSecureConversations — persist created group

**Files:**
- Modify: `packages/secure-chat/core/src/hooks/useSecureConversations.tsx` (two edits)
- Test: `packages/secure-chat/core/src/hooks/useSecureConversations.test.tsx`

- [ ] **Step 1: Add `rememberGroup` to the context destructure** — in `packages/secure-chat/core/src/hooks/useSecureConversations.tsx`, change:

```ts
  const { rest, crypto, socket } = useSecureChat();
```
to:
```ts
  const { rest, crypto, socket, rememberGroup } = useSecureChat();
```

- [ ] **Step 2: Persist the group after creation** — in the same file, inside `createDirectConversation`, replace:

```ts
      setConversations((prev) => [conversation, ...prev.filter((c) => c.id !== conversation.id)]);
      return conversation;
```
with:
```ts
      // Persist + cache the creator's MLS group handle so messages resolve after a reload.
      await rememberGroup(conversation.id, group);

      setConversations((prev) => [conversation, ...prev.filter((c) => c.id !== conversation.id)]);
      return conversation;
```

- [ ] **Step 3: Update the callback dependency array** — in the same `createDirectConversation` `useCallback`, change its dependency array from `[rest, crypto]` to `[rest, crypto, rememberGroup]`.

- [ ] **Step 4: Write the failing test** — `packages/secure-chat/core/src/hooks/useSecureConversations.test.tsx`:

```tsx
// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { MockSecureChatCrypto } from "@agora-sdk/secure-chat-crypto/testing";
import { SecureChatProvider } from "../context/secure-chat-context.js";
import { useSecureConversations } from "./useSecureConversations.js";
import { MemoryStore } from "../persistence/memory-store.js";
import { SecureChatRestClient } from "../transport/rest.js";
import { SecureChatSocketClient } from "../transport/socket.js";
import type { SecureConversationModel, SecureDeviceModel } from "../contract/index.js";

const deviceRow: SecureDeviceModel = {
  id: "peer-dev", projectId: "p", userId: "peer", deviceId: "peer-dev", displayName: null,
  signaturePublicKey: "", credential: "", ciphersuite: 1,
  revokedAt: null, lastSeenAt: null, createdAt: "", updatedAt: "",
};

const conversation: SecureConversationModel = {
  id: "conv-1", projectId: "p", type: "dm", mlsGroupId: "", spaceId: null,
  currentEpoch: "0", name: null, createdById: "u", lastMessageAt: null,
  createdAt: "", updatedAt: "",
};

function wrap(crypto: MockSecureChatCrypto, store: MemoryStore) {
  return ({ children }: { children: React.ReactNode }) => (
    <SecureChatProvider crypto={crypto} projectId="p" store={store} accessToken="t">
      {children}
    </SecureChatProvider>
  );
}

beforeEach(() => {
  vi.spyOn(SecureChatSocketClient.prototype, "on").mockReturnValue(() => {});
  vi.spyOn(SecureChatRestClient.prototype, "listConversations").mockResolvedValue({
    conversations: [], hasMore: false,
  });
});
afterEach(() => vi.restoreAllMocks());

describe("useSecureConversations", () => {
  it("createDirectConversation persists the created group", async () => {
    vi.spyOn(SecureChatRestClient.prototype, "listDevices").mockResolvedValue([deviceRow]);
    vi.spyOn(SecureChatRestClient.prototype, "claimKeyPackage").mockResolvedValue({
      deviceId: "peer-dev", keyPackageRef: "ref", keyPackage: "", ciphersuite: 1,
    });
    vi.spyOn(SecureChatRestClient.prototype, "createConversation").mockResolvedValue(conversation);

    const crypto = new MockSecureChatCrypto();
    await crypto.generateDeviceIdentity({ deviceId: "me" });
    const store = new MemoryStore();

    const { result } = renderHook(() => useSecureConversations(), { wrapper: wrap(crypto, store) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.createDirectConversation("peer");
    });

    expect(await store.get("group:conv-1")).not.toBeNull();
  });
});
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/secure-chat/core/src/hooks/useSecureConversations.test.tsx`
Expected: PASS. (`claimKeyPackage` returns an empty base64 keyPackage → `fromBase64("")` is a 0-length array, which the mock's `createGroup` accepts.)

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm run typecheck
git add packages/secure-chat/core/src/hooks/useSecureConversations.tsx packages/secure-chat/core/src/hooks/useSecureConversations.test.tsx
git commit -m "feat(core): persist created group in useSecureConversations"
```

---

### Task 7: useSecureMessages — auto-resolve handle + sender

**Files:**
- Modify: `packages/secure-chat/core/src/hooks/useSecureMessages.tsx` (full new content below)
- Test: `packages/secure-chat/core/src/hooks/useSecureMessages.test.tsx`

- [ ] **Step 1: Replace the hook file** — overwrite `packages/secure-chat/core/src/hooks/useSecureMessages.tsx` with:

```tsx
// useSecureMessages — load, decrypt, send, and live-receive messages in a secure conversation.
//
// Self-sufficient once a store is wired: the MLS GroupHandle is auto-resolved from persistence via
// resolveGroup, and senderDeviceId is read from the persisted device. Both stay overridable through
// options for advanced use. Without a resolvable handle, ciphertext is still listed/received
// (plaintext: null) and sending is disabled.

import { useCallback, useEffect, useState } from "react";
import { SecureMessageModel } from "../contract/index.js";
import { GroupHandle } from "@agora-sdk/secure-chat-crypto";
import { toBase64, fromBase64, utf8ToBytes, bytesToUtf8 } from "../util/base64.js";
import { useSecureChat } from "../context/secure-chat-context.js";

/** A stored message paired with its decrypted text (when a group handle is available). */
export interface DecryptedSecureMessage {
  /** The raw message row from the server (still holds the base64 ciphertext). */
  model: SecureMessageModel;
  /** Decrypted text, or null when no group handle is available or decryption is pending/failed. */
  plaintext: string | null;
}

/** Options for {@link useSecureMessages}. */
export interface UseSecureMessagesOptions {
  /** Override the MLS group handle. Defaults to the persisted handle via `resolveGroup`. */
  group?: GroupHandle;
  /** Override the sender device row id. Defaults to the persisted device's `.id`. */
  senderDeviceId?: string;
}

/** The state and actions returned by {@link useSecureMessages}. */
export interface UseSecureMessagesValues {
  /** Loaded messages, newest first, each with decrypted text when possible. */
  messages: DecryptedSecureMessage[];
  /** True while a page load or refresh is in flight. */
  loading: boolean;
  /** Whether older messages remain to {@link UseSecureMessagesValues.loadMore}. */
  hasMore: boolean;
  /** The last error thrown by loading or sending, or `null`. */
  error: unknown;
  /** Append the next page of older messages. No-op when already loading or exhausted. */
  loadMore: () => Promise<void>;
  /** Reload from the newest message, replacing the current list. */
  refresh: () => Promise<void>;
  /** Encrypt + send a text message. Requires a resolvable group + sender device. */
  sendMessage: (text: string) => Promise<void>;
}

/**
 * Load, decrypt, send, and live-receive messages in one secure conversation.
 *
 * Auto-resolves the MLS group handle (via `resolveGroup`) and the sender device id (from the
 * persisted device) unless overridden in `options`. Joins the conversation socket room for live
 * `secure:message` events.
 *
 * @param conversationId - The conversation to read and send within.
 * @param options - {@link UseSecureMessagesOptions}.
 * @returns {@link UseSecureMessagesValues}.
 *
 * @example
 * ```tsx
 * const { messages, sendMessage } = useSecureMessages(conversationId);
 * await sendMessage("hello 💜");
 * ```
 */
export function useSecureMessages(
  conversationId: string,
  options: UseSecureMessagesOptions = {}
): UseSecureMessagesValues {
  const { rest, crypto, socket, repo, resolveGroup } = useSecureChat();

  const [messages, setMessages] = useState<DecryptedSecureMessage[]>([]);
  const [before, setBefore] = useState<string | undefined>(undefined);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [group, setGroup] = useState<GroupHandle | null>(options.group ?? null);
  const [senderDeviceId, setSenderDeviceId] = useState<string | undefined>(options.senderDeviceId);

  // Resolve the group handle: explicit override, else persisted state.
  useEffect(() => {
    if (options.group) {
      setGroup(options.group);
      return;
    }
    let alive = true;
    resolveGroup(conversationId)
      .then((g) => {
        if (alive) setGroup(g);
      })
      .catch(() => {
        if (alive) setGroup(null);
      });
    return () => {
      alive = false;
    };
  }, [options.group, conversationId, resolveGroup]);

  // Resolve the sender device id: explicit override, else persisted device row.
  useEffect(() => {
    if (options.senderDeviceId) {
      setSenderDeviceId(options.senderDeviceId);
      return;
    }
    let alive = true;
    repo
      .loadDevice()
      .then((d) => {
        if (alive) setSenderDeviceId(d?.device?.id ?? undefined);
      })
      .catch(() => {
        if (alive) setSenderDeviceId(undefined);
      });
    return () => {
      alive = false;
    };
  }, [options.senderDeviceId, repo]);

  const decrypt = useCallback(
    async (model: SecureMessageModel): Promise<DecryptedSecureMessage> => {
      if (!group) return { model, plaintext: null };
      try {
        const { plaintext } = await crypto.decryptMessage(group, fromBase64(model.ciphertext));
        return { model, plaintext: bytesToUtf8(plaintext) };
      } catch {
        return { model, plaintext: null };
      }
    },
    [crypto, group]
  );

  const load = useCallback(
    async (reset: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const page = await rest.listMessages(conversationId, {
          before: reset ? undefined : before,
          limit: 40,
        });
        const decrypted = await Promise.all(page.messages.map(decrypt));
        const oldest = page.messages[page.messages.length - 1];
        setBefore(oldest ? oldest.createdAt : before);
        setHasMore(page.hasMore);
        setMessages((prev) => (reset ? decrypted : [...prev, ...decrypted]));
      } catch (err) {
        setError(err);
      } finally {
        setLoading(false);
      }
    },
    [rest, conversationId, before, decrypt]
  );

  const refresh = useCallback(async () => {
    setBefore(undefined);
    await load(true);
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!hasMore || loading) return;
    await load(false);
  }, [hasMore, loading, load]);

  const sendMessage = useCallback(
    async (text: string): Promise<void> => {
      if (!group) throw new Error("Cannot send: no MLS group handle for this conversation.");
      if (!senderDeviceId) throw new Error("Cannot send: senderDeviceId is required.");
      const { ciphertext, epoch } = await crypto.encryptMessage(group, utf8ToBytes(text));
      const sent = await rest.sendMessage(conversationId, {
        ciphertext: toBase64(ciphertext),
        epoch: epoch.toString(),
        senderDeviceId,
      });
      setMessages((prev) => [{ model: sent, plaintext: text }, ...prev]);
    },
    [crypto, rest, conversationId, group, senderDeviceId]
  );

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  // Live receive: join the conversation room and decrypt inbound ciphertext.
  useEffect(() => {
    socket.joinConversation(conversationId);
    const off = socket.on("secure:message", (model) => {
      if (model.conversationId !== conversationId) return;
      decrypt(model).then((m) =>
        setMessages((prev) => (prev.some((p) => p.model.id === m.model.id) ? prev : [m, ...prev]))
      );
    });
    return off;
  }, [socket, conversationId, decrypt]);

  return { messages, loading, hasMore, error, loadMore, refresh, sendMessage };
}
```

- [ ] **Step 2: Write the failing test** — `packages/secure-chat/core/src/hooks/useSecureMessages.test.tsx`:

```tsx
// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { MockSecureChatCrypto } from "@agora-sdk/secure-chat-crypto/testing";
import { SecureChatProvider } from "../context/secure-chat-context.js";
import { useSecureMessages } from "./useSecureMessages.js";
import { MemoryStore } from "../persistence/memory-store.js";
import { SecureChatRepository } from "../persistence/repository.js";
import { SecureChatRestClient } from "../transport/rest.js";
import { SecureChatSocketClient } from "../transport/socket.js";
import type { SecureDeviceModel, SecureMessageModel } from "../contract/index.js";

const row: SecureDeviceModel = {
  id: "row-1", projectId: "p", userId: "u", deviceId: "me", displayName: null,
  signaturePublicKey: "", credential: "", ciphersuite: 1,
  revokedAt: null, lastSeenAt: null, createdAt: "", updatedAt: "",
};

function wrap(crypto: MockSecureChatCrypto, store: MemoryStore) {
  return ({ children }: { children: React.ReactNode }) => (
    <SecureChatProvider crypto={crypto} projectId="p" store={store} accessToken="t">
      {children}
    </SecureChatProvider>
  );
}

beforeEach(() => {
  vi.spyOn(SecureChatSocketClient.prototype, "on").mockReturnValue(() => {});
  vi.spyOn(SecureChatSocketClient.prototype, "joinConversation").mockReturnValue(undefined);
  vi.spyOn(SecureChatRestClient.prototype, "listMessages").mockResolvedValue({
    messages: [], hasMore: false,
  });
});
afterEach(() => vi.restoreAllMocks());

describe("useSecureMessages", () => {
  it("auto-resolves the group + sender and sends encrypted with the persisted device id", async () => {
    const crypto = new MockSecureChatCrypto();
    await crypto.generateDeviceIdentity({ deviceId: "me" });
    const { group } = await crypto.createGroup({ initialMembers: [] });
    const store = new MemoryStore();
    const repo = new SecureChatRepository(store);
    await repo.saveGroupState("conv-1", await crypto.exportGroupState(group));
    await repo.saveDevice({ deviceId: "me", deviceState: await crypto.exportDeviceState(), device: row });

    let sentBody: { ciphertext: string; senderDeviceId: string } | undefined;
    vi.spyOn(SecureChatRestClient.prototype, "sendMessage").mockImplementation(
      async (_conv: string, body): Promise<SecureMessageModel> => {
        sentBody = body as { ciphertext: string; senderDeviceId: string };
        return {
          id: "m1", projectId: "p", conversationId: "conv-1", senderUserId: "u",
          senderDeviceId: "row-1", epoch: "0", ciphertext: body.ciphertext,
          contentType: "text/plain", createdAt: "",
        };
      }
    );

    const { result } = renderHook(() => useSecureMessages("conv-1"), { wrapper: wrap(crypto, store) });
    await waitFor(() => expect(result.current.loading).toBe(false));

    // The group handle + sender resolve in async effects. sendMessage throws (before any side
    // effect) until both are ready, so retrying inside waitFor is safe and deterministic — it stops
    // on the first success.
    await waitFor(async () => {
      await result.current.sendMessage("hi");
    });

    expect(sentBody?.senderDeviceId).toBe("row-1");
    expect(result.current.messages[0]?.plaintext).toBe("hi");
  });
});
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/secure-chat/core/src/hooks/useSecureMessages.test.tsx`
Expected: PASS.

- [ ] **Step 4: Typecheck + commit**

```bash
pnpm run typecheck
git add packages/secure-chat/core/src/hooks/useSecureMessages.tsx packages/secure-chat/core/src/hooks/useSecureMessages.test.tsx
git commit -m "feat(core): auto-resolve group handle + sender in useSecureMessages"
```

---

### Task 8: IndexedDB store (web)

**Files:**
- Create: `packages/secure-chat/react-js/src/indexeddb-store.ts`
- Test: `packages/secure-chat/react-js/src/indexeddb-store.test.ts`
- Modify: `packages/secure-chat/react-js/package.json` (add `fake-indexeddb` devDep)

- [ ] **Step 1: Add the test dependency**

```bash
pnpm --filter @agora-sdk/secure-chat-react-js add -D fake-indexeddb
```
Expected: `fake-indexeddb` under `packages/secure-chat/react-js/package.json` devDependencies.

- [ ] **Step 2: Implement the store** — `packages/secure-chat/react-js/src/indexeddb-store.ts`:

```ts
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
  const db = () => (dbPromise ??= openDb(dbName, storeName));

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
```

- [ ] **Step 3: Write the failing test** — `packages/secure-chat/react-js/src/indexeddb-store.test.ts`:

```ts
import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { createIndexedDBStore } from "./indexeddb-store.js";

const bytes = (...xs: number[]) => new Uint8Array(xs);

describe("createIndexedDBStore", () => {
  it("round-trips, lists by prefix, and deletes", async () => {
    const store = createIndexedDBStore({ dbName: "t1" });
    await store.set("group:a", bytes(1, 2, 3));
    await store.set("group:b", bytes(4));
    await store.set("device", bytes(9));
    expect(await store.get("group:a")).toEqual(bytes(1, 2, 3));
    expect((await store.list("group:")).sort()).toEqual(["group:a", "group:b"]);
    await store.delete("group:a");
    expect(await store.get("group:a")).toBeNull();
  });

  it("persists across a fresh store handle on the same db (reload)", async () => {
    const s1 = createIndexedDBStore({ dbName: "t2" });
    await s1.set("device", bytes(7, 7));
    const s2 = createIndexedDBStore({ dbName: "t2" });
    expect(await s2.get("device")).toEqual(bytes(7, 7));
  });
});
```

- [ ] **Step 4: Run the test to verify it fails, then passes**

Run: `pnpm exec vitest run packages/secure-chat/react-js/src/indexeddb-store.test.ts`
Expected: PASS (`fake-indexeddb/auto` registers a global `indexedDB` in the node env).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm run typecheck
git add packages/secure-chat/react-js/src/indexeddb-store.ts packages/secure-chat/react-js/src/indexeddb-store.test.ts packages/secure-chat/react-js/package.json pnpm-lock.yaml
git commit -m "feat(react-js): add IndexedDB-backed SecureChatStore"
```

---

### Task 9: Exports, changelog, full verification

**Files:**
- Modify: `packages/secure-chat/core/src/index.ts`
- Modify: `packages/secure-chat/react-js/src/index.ts`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Export persistence from core** — in `packages/secure-chat/core/src/index.ts`, add a new section before the `// ── utils ──` block:

```ts
// ── persistence (Phase 2) ─────────────────────────────────────────────────────
export type { SecureChatStore } from "./persistence/store.js";
export { MemoryStore } from "./persistence/memory-store.js";
export { SecureChatRepository } from "./persistence/repository.js";
export type { PersistedDevice } from "./persistence/repository.js";
```

- [ ] **Step 2: Export the IndexedDB store from react-js** — in `packages/secure-chat/react-js/src/index.ts`, after the `createWebSecureChatCrypto` export line, add:

```ts
export { createIndexedDBStore } from "./indexeddb-store.js";
export type { IndexedDBStoreOptions } from "./indexeddb-store.js";
```

- [ ] **Step 3: Add the CHANGELOG entry** — in `CHANGELOG.md`, under `## [Unreleased]` → `### Added`, append:

```markdown
- **Persistence layer (Phase 2)** — `SecureChatStore` key→blob seam + `MemoryStore` (core),
  `SecureChatRepository` typed façade, provider-injected `store` with a cached `resolveGroup` /
  `rememberGroup`, and `createIndexedDBStore()` (react-js). The three hooks are now self-sufficient:
  device identity + stable `deviceId` persist and re-hydrate, created groups persist, and
  `useSecureMessages` auto-resolves the group handle + sender device. Adds
  `exportDeviceState`/`importDeviceState` to the `SecureChatCrypto` seam. Plaintext at rest on web
  (documented); backup-restore eviction recovery and handshake processing stay deferred (tasks 5, 4).
```

- [ ] **Step 4: Full verification**

Run:
```bash
pnpm run typecheck
pnpm test
pnpm run build-all
```
Expected: typecheck clean; all tests pass (crypto device-state, memory-store, repository, context, three hooks, indexeddb-store, plus the pre-existing base64 + mock-crypto suites); `build-all` emits dual ESM/CJS for every package with no `*.test.*` files in `dist`.

- [ ] **Step 5: Verify no test files leaked into dist**

Run: `find packages/*/*/dist -name '*.test.*' | grep . && echo LEAK || echo "none ✓"`
Expected: `none ✓`

- [ ] **Step 6: Commit**

```bash
git add packages/secure-chat/core/src/index.ts packages/secure-chat/react-js/src/index.ts CHANGELOG.md
git commit -m "feat: export persistence layer + changelog (Phase 2 task 2 complete)"
```

---

## Definition of done

- `SecureChatStore` + `MemoryStore` + `SecureChatRepository` exist and are exported from core; `createIndexedDBStore` from react-js.
- `SecureChatCrypto` has `exportDeviceState`/`importDeviceState`, implemented in the mock.
- The provider injects the store and exposes `repo` / `resolveGroup` / `rememberGroup`.
- `useSecureDevice` persists + re-hydrates identity with a stable `deviceId`; `useSecureConversations` persists created groups; `useSecureMessages` auto-resolves the handle + sender.
- `pnpm test` and `pnpm run typecheck` green; `pnpm run build-all` clean with no test files in `dist`; CHANGELOG updated.
```
