# Secure Chat — persistence layer (Phase 2, task 2)

**Status:** approved design, ready for implementation plan
**Date:** 2026-06-06
**Scope:** ROADMAP Phase 2 task 2 (key & group-state persistence), full — including the IndexedDB
web implementation. Excludes task 4 (handshake processing/ordering) and task 5 (backup-restore
eviction recovery).

## Goal

Make secure-chat state survive a browser reload. Today the crypto seam holds device identity and MLS
group secrets only in memory, the hooks require the app to thread a `GroupHandle` / `senderDeviceId`
in by hand, and `useSecureDevice` mints a fresh `deviceId` on every mount. This slice adds a
persistence seam, wires it through the provider, and makes the three hooks self-sufficient — so a web
app that injects an IndexedDB store can register a device, start a DM, send/receive, and **survive a
reload** with the server storing only ciphertext.

This is the keystone the ROADMAP file-map flags twice ("persist `privateState`" and "resolve
`conversationId → GroupHandle`"); landing it lights up the hooks.

## Decisions (from brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Starting slice | Persistence layer (task 2) | Pure TS, no external-lib decision, unblocks all three hooks, testable against the existing mock. |
| Store abstraction | Generic key→blob KV seam, with a typed repository on top in core | Matches the ROADMAP "get/set opaque blobs by key"; smallest surface to reimplement per platform. |
| At-rest security (web) | Plaintext in IndexedDB for Phase 2; document the limitation | Threat model is "blind server", not a compromised local origin. Passphrase backup (task 5) is the recovery/portability path; hardware keystore is Phase 3. The generic seam lets a wrapping layer drop in later without touching callers. |
| Integration style | A — store injected via provider; provider builds a typed repository + a cached `resolveGroup`; hooks auto-use them | Wire the store once; everything lights up. Best consumer ergonomics. |
| Device-state restore | Add `exportDeviceState`/`importDeviceState` to the `SecureChatCrypto` interface | A real MLS core generates random keys, so it cannot deterministically regenerate identity after reload like the mock can. Symmetric with the existing group-state pair. |

## Non-goals (explicitly deferred)

- **Task 4** — connect-time handshake catch-up, `seq`-ordered processing, epoch buffering, 409
  epoch-conflict rebase. The handshake cursor is persisted here as a *slot only*; nothing drives it
  yet. The peer-side `processWelcome → rememberGroup` join is ready but its *trigger* is task 4.
- **Task 5** — passphrase backup/restore, and the eviction → backup-restore recovery path. This slice
  only *detects and surfaces* missing/evicted state cleanly (no crash, no silent identity fork).
- **Encryption at rest** — see the at-rest decision above.
- **No runtime dependencies** are added by this slice.

## Architecture

No new package. Persistence is core-coupled; the web implementation lives in the web package.

| Piece | Location | Package |
|---|---|---|
| `SecureChatStore` (KV seam) | `core/src/persistence/store.ts` | `@agora-sdk/secure-chat-core` |
| `MemoryStore` (default impl) | `core/src/persistence/memory-store.ts` | core |
| `SecureChatRepository` (typed façade) | `core/src/persistence/repository.ts` | core |
| `exportDeviceState`/`importDeviceState` | `crypto/src/interface.ts` + `mock-crypto.ts` | `@agora-sdk/secure-chat-crypto` |
| `createIndexedDBStore()` | `react-js/src/indexeddb-store.ts` | `@agora-sdk/secure-chat-react-js` |

### The KV seam

Dumb, async, opaque bytes. This is all a platform must implement.

```ts
export interface SecureChatStore {
  get(key: string): Promise<Uint8Array | null>;
  set(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>; // keys sharing the prefix — for enumerate / clear
}
```

`MemoryStore` is a `Map<string, Uint8Array>`-backed implementation, the provider default when no
store is injected (keeps core usable in tests and SSR).

### The typed repository

Core owns the key schema and (de)serialization, using the existing `util/base64` helpers
(`toBase64`/`fromBase64`, `utf8ToBytes`/`bytesToUtf8`). It is the only thing in the SDK that knows
the key strings.

```ts
export interface PersistedDevice {
  deviceId: string;                 // stable MLS device id, survives reload
  deviceState: Uint8Array;          // opaque, from crypto.exportDeviceState()
  device: SecureDeviceModel | null; // the registered server row (rehydrates UI without a refetch)
}

export class SecureChatRepository {
  constructor(store: SecureChatStore);

  loadDevice(): Promise<PersistedDevice | null>;
  saveDevice(d: PersistedDevice): Promise<void>;
  clearDevice(): Promise<void>;

  loadGroupState(conversationId: string): Promise<Uint8Array | null>;
  saveGroupState(conversationId: string, state: Uint8Array): Promise<void>;
  deleteGroupState(conversationId: string): Promise<void>;
  listGroupConversationIds(): Promise<string[]>;

  loadHandshakeCursor(): Promise<string | null>;
  saveHandshakeCursor(seq: string): Promise<void>;

  clearAll(): Promise<void>; // sign-out / device revoke
}
```

**Key schema**

| Key | Value (on the wire of the store) |
|---|---|
| `device` | JSON `{ deviceId, deviceState: base64, device: SecureDeviceModel \| null }` → utf8 bytes |
| `group:<conversationId>` | raw opaque group-state bytes from `exportGroupState` |
| `handshake:cursor` | utf8 of the decimal `seq` string |

### Crypto interface additions

Symmetric with the existing `exportGroupState`/`importGroupState`. Added to the interface and
implemented in `MockSecureChatCrypto`. Backward-compatible: the only implementers are the mock and
the throwing platform stubs, and agora-server's mock dev-dependency simply won't call the new methods.

```ts
exportDeviceState(): Promise<Uint8Array>;            // opaque serialization of identity + private state
importDeviceState(state: Uint8Array): Promise<DeviceIdentity>; // re-hydrate; returns the restored identity
```

Mock implementation: `exportDeviceState` serializes `{ deviceId, ciphersuite, signaturePublicKey,
credential, privateState }` (binary as hex, matching the mock's internal style); `importDeviceState`
restores `this.identity` + `this.privateState` and returns the `DeviceIdentity`.

## Provider, resolver & hook integration

### Provider

`SecureChatProvider` gains one optional prop:

```ts
<SecureChatProvider store={createIndexedDBStore()} crypto={...} projectId={...} ... />
// store defaults to new MemoryStore() when omitted
```

It builds:

- `repo = useMemo(() => new SecureChatRepository(store), [store])`
- a memoized in-memory **group-handle cache** `Map<conversationId, GroupHandle>` (a `useRef`)
- two functions added to the context:
  - `resolveGroup(conversationId): Promise<GroupHandle | null>` — cache hit, else
    `repo.loadGroupState` → `crypto.importGroupState` → populate cache. Returns `null` if no state.
  - `rememberGroup(conversationId, handle): Promise<void>` — set cache + `crypto.exportGroupState` →
    `repo.saveGroupState`.

`SecureChatContextValue` gains `repo`, `resolveGroup`, `rememberGroup` (keeps `rest`, `socket`,
`crypto`, `projectId`).

### `useSecureDevice`

Closes the "stable deviceId + privateState persistence" gap.

- On mount: `repo.loadDevice()`.
  - **Found** → `crypto.importDeviceState(deviceState)`, restore `device`, and reuse the persisted
    `deviceId` (fixes the current fresh-id-per-mount bug).
  - **Not found** → first-run path; await an explicit `register()`.
- `register()` → `generateDeviceIdentity` → server `registerDevice` →
  `repo.saveDevice({ deviceId, deviceState: await crypto.exportDeviceState(), device: registered })`.
- A `loading`/`ready` flag so `register()` waits for the initial load to settle (avoids racing a
  fresh identity against a persisted one).
- KeyPackage low-water auto-replenish is unchanged.

### `useSecureConversations`

`createDirectConversation`: after the server returns the conversation, `await
rememberGroup(conversation.id, group)` — persist + cache the creator's handle.

### `useSecureMessages`

Becomes self-sufficient; both options remain as advanced overrides.

- **Group handle**: `options.group` if passed, else `resolveGroup(conversationId)` into state.
- **`senderDeviceId`**: `options.senderDeviceId` if passed, else the persisted device row id
  (`repo.loadDevice()` → `device.id`).
- The common path needs neither option once the store is wired.

### Scope honesty

This persists/caches the **creator's** group at `createGroup`. The **peer's** group arrives via
`processWelcome`, whose *triggering* on inbound handshakes is **task 4**. `rememberGroup` is ready for
that wiring; full two-browser reload-survive lands with task 4. This slice proves reload-survive on
the creating side.

## IndexedDB implementation (web)

`react-js/src/indexeddb-store.ts`, dependency-free:

- `createIndexedDBStore(opts?: { dbName?: string; storeName?: string }): SecureChatStore`
- One object store keyed by string, value `Uint8Array`. Defaults: DB `agora-secure-chat`, store `kv`,
  version 1.
- Promisified `open`/`get`/`put`/`delete`/`getAllKeys`; `list(prefix)` filters keys by prefix.
- ~60 lines, no `idb` dependency (keeps the web package lean; `idb` noted as a swap-in if the surface
  grows).
- If `indexedDB` is absent (SSR / disabled), construction throws a clear, documented error; the app
  chooses the fallback (e.g. inject a `MemoryStore`).

## Error & eviction handling

This slice handles eviction as **detect + surface cleanly, never crash**:

- Missing key → `get` returns `null` (first-run and post-eviction both look like "no state").
- Eviction (Safari ITP / "clear browsing data") surfaces as `loadDevice`/`loadGroupState` returning
  `null` after a prior save → hooks treat it as not-registered / no-handle, no throw.
- The *evicted-vs-first-run* distinction and the **backup-restore recovery is task 5** (deferred). A
  documented seam is left here — deliberately **not** a silent re-register, which would fork the
  device identity.
- `clearAll()` (sign-out / device revoke) uses `list` + `delete`.

## Testing

All mock-backed, under the repo's enforced test standards.

- **crypto (node)** — extend `mock-crypto.test.ts`: `exportDeviceState`/`importDeviceState` round-trip
  restores identity into a fresh instance, which can still decrypt a group it rejoined.
- **core (node)** —
  - `memory-store.test.ts`: `get`/`set`/`delete`/`list` semantics.
  - `repository.test.ts`: device / group / cursor round-trips, `clearAll`, key-schema, against
    `MemoryStore` + the mock.
- **core (jsdom)** — hook tests via `@testing-library/react` `renderHook`:
  - `useSecureDevice`: persisted device → no re-register; none → register + save.
  - `useSecureMessages`: auto-resolves the handle; sends with the persisted `senderDeviceId`.
  - `useSecureConversations`: `createDirectConversation` persists the group.
  - These are the **first hook tests**, so they add the jsdom harness per the CLAUDE.md note.
- **react-js** — `indexeddb-store.test.ts` using `fake-indexeddb`: round-trip, `list(prefix)`, and
  survives a simulated reopen.

**New dev dependencies**: `jsdom`, `@testing-library/react`, `react-dom` (root); `fake-indexeddb`
(react-js). No runtime dependencies.

## Definition of done (this slice)

- The `SecureChatStore` seam, `MemoryStore`, and `SecureChatRepository` exist and are exported from
  core; `createIndexedDBStore` from react-js.
- `SecureChatCrypto` has `exportDeviceState`/`importDeviceState`, implemented in the mock.
- The provider injects the store, exposes `repo` / `resolveGroup` / `rememberGroup`.
- The three hooks are self-sufficient: device identity + stable `deviceId` persist and re-hydrate;
  created groups persist; messages auto-resolve the handle and sender.
- A web app injecting `createIndexedDBStore()` survives a reload on the creating side (device stays
  registered, the DM's group handle resolves from disk) with the server holding only ciphertext.
- All tests green (`pnpm test`); `pnpm run typecheck` clean. CHANGELOG updated.

## Cross-repo note

The `exportDeviceState`/`importDeviceState` addition is to the SDK-owned crypto interface and is
backward-compatible for agora-server's mock test dev-dependency (it won't call the new methods). No
server change is required for this slice. The wire-types stand-in (`core/src/contract/`) is untouched
and stays byte-faithful.
