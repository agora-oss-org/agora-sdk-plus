# Secure Chat 🔐💬

> **Audience:** consumers of the `@agora-sdk/secure-chat-*` packages, and anyone maintaining them.
> **Canonical spec:** [agora-server's `docs/SECURE_CHAT.md`](https://github.com/jenova-marie/agora-server) — the home of record for the wire contract and the blind-server model.
> **Roadmap:** [`SECURE-CHAT-ROADMAP.md`](SECURE-CHAT-ROADMAP.md) for the Phase 2/3 checklist.

---

## The one idea 💡

Secure chat is the client side of Agora's **end-to-end-encrypted messaging** (**MLS /
[RFC 9420](https://www.rfc-editor.org/rfc/rfc9420)**). The Agora server is a **blind delivery
service**: it stores and relays opaque base64 blobs (KeyPackages, Welcomes, Commits, ciphertext,
encrypted backups) and **never sees plaintext**. All the crypto lives here, client-side, behind a
swappable `SecureChatCrypto` seam.

> **Status: Phase 2 in progress.** Structure, transport, provider/hooks, persistence, and handshake
> processing are built; the real MLS crypto (**ts-mls**) is wired on web
> (`@agora-sdk/secure-chat-crypto/ts-mls`) and proven end-to-end against a running agora-server.
> Remaining Phase 2: KeyPackage replenishment tuning, passphrase backup/restore, generation-counter
> enforcement. Not yet published to npm.

## Packages 📦

| Package | Role |
|---|---|
| `@agora-sdk/secure-chat-crypto` | The `SecureChatCrypto` seam: interface (main entry) + `MockSecureChatCrypto` (`./testing`) + the real **ts-mls** core (`./ts-mls`, ESM-only). Bare entry + `./testing` are dependency-free |
| `@agora-sdk/secure-chat-core` | Platform-agnostic: REST + `/secure` socket transport, `SecureChatProvider` + hooks, crypto via dependency injection |
| `@agora-sdk/secure-chat-react-js` | Web: real `SecureChatCrypto` (ts-mls) + IndexedDB persistence *(ESM-only)* |
| `@agora-sdk/secure-chat-react-native` | Bare React Native: Keychain + native MLS *(Phase 3 — stub)* |
| `@agora-sdk/secure-chat-expo` | Expo: SecureStore *(Phase 3 — stub)* |

## Quick start 🚀

```bash
# web — standalone, no @agora-sdk/core required
pnpm add @agora-sdk/secure-chat-react-js
```

```tsx
import {
  SecureChatProvider,
  createWebSecureChatCrypto,
  createIndexedDBStore,
} from "@agora-sdk/secure-chat-react-js";

// Memoize crypto + store so they're stable across renders (a fresh instance each render rebuilds the
// provider and churns the device). `baseUrl` is required — secure chat is a standalone transport.
const crypto = useMemo(() => createWebSecureChatCrypto(), []);
const store = useMemo(() => createIndexedDBStore(), []);

<SecureChatProvider
  projectId={projectId}
  baseUrl={baseUrl}          // e.g. https://api.example.com/v7
  accessToken={accessToken}
  crypto={crypto}
  store={store}
>
  {/* useSecureConversations(), useSecureMessages(), … */}
</SecureChatProvider>
```

## Encryption at rest (optional) 🗄️

The base `createIndexedDBStore()` writes **plaintext** to IndexedDB (the blind server still never sees
it, but anyone with disk or same-origin access can). Wrap it with `createEncryptedStore` to seal every
persisted **value** — MLS group/ratchet secrets, the device signing key, decrypted message history,
cursors — at rest under a password-derived key (argon2id → KEK → non-extractable AES-256-GCM DEK).
**Call `unlock(password)` before mounting the provider**, and `lock()` on logout/idle:

```tsx
import { createEncryptedStore, createIndexedDBStore } from "@agora-sdk/secure-chat-react-js";

const store = useMemo(() => createEncryptedStore(createIndexedDBStore()), []);
await store.unlock(userPassword);   // first use mints the DEK; later opens unwrap it. MUST precede mount.

<SecureChatProvider store={store} /* …same props as above… */ >…</SecureChatProvider>

store.lock();                       // drop the in-memory DEK (disk-lock; see the scope note below)
```

Fails closed everywhere: while locked, every store op throws `StoreLockedError`; a wrong password or a
tampered value throws a generic error and never yields raw bytes. **Scope (v1):** store *values* are
sealed; *keys* still pass through in the clear (they leak conversation ids + message counts the server
already sees), and `lock()` is a disk-lock — it drops the store's key but does not purge plaintext
already cached in the provider/crypto memory. Full details + threat model:
[`docs/superpowers/specs/2026-06-18-encryption-at-rest-design.md`](superpowers/specs/2026-06-18-encryption-at-rest-design.md).

## Foundation e2e (optional, needs a running agora-server) 🧪

`pnpm test:e2e` drives the **real** transport clients against a locally running
[agora-server](https://github.com/jenova-marie/agora-server), proving the wire contract end to end
(register → DM → send → receive → realtime → reload, server-blind throughout). It is **opt-in**: skipped
unless `AGORA_E2E_DATABASE_URL` is set, so the default `pnpm test` and CI never need a server.

```bash
# 1. Start the standalone @agora/secure-chat process (in the agora-server repo), pointed at a Postgres
#    you can write to. It listens on SECURE_CHAT_PORT (default :4002) — see TESTING.md for the exact
#    server-start steps and env.

# 2. Run the e2e (env values must match the server's):
AGORA_E2E_DATABASE_URL="postgres://…"  \
AGORA_E2E_ACCESS_TOKEN_SECRET="<server ACCESS_TOKEN_SECRET>"  \
pnpm test:e2e
```

Other knobs: `AGORA_E2E_BASE_URL` / `AGORA_E2E_SOCKET_URL` (both default to the standalone secure-chat
process at `http://localhost:4002`). The suite seeds its own throwaway project and tears it down. Full
walkthrough: [`TESTING.md`](../TESTING.md).

## Going deeper 📚

- [`ARCHITECTURE.md`](../ARCHITECTURE.md) — package graph, seams, runtime flows (with diagrams)
- [`CLAUDE.md`](../CLAUDE.md) — the prose source of truth for the blind-server / client-crypto model
- [`SECURE-CHAT-ROADMAP.md`](SECURE-CHAT-ROADMAP.md) — the Phase 2/3 task checklist
- agora-server's `docs/SECURE_CHAT.md` — the canonical wire spec
