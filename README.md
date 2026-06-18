# Agora SDK Plus

Additive, **Agora-only** SDK features that build on top of [`@agora-sdk/*`](https://github.com/jenova-marie/agora-sdk) —
capabilities with no upstream [Replyke](https://github.com/replyke/monorepo) counterpart, kept out of
the agora-sdk fork so that fork stays a tiny, documented divergence from upstream.

First feature: **secure chat** — the client side of Agora's end-to-end-encrypted messaging
(**MLS / [RFC 9420](https://www.rfc-editor.org/rfc/rfc9420)**). The Agora server is a *blind*
delivery service that never sees plaintext; all crypto lives in these client packages behind a
swappable `SecureChatCrypto` seam.

> **Status: Phase 2 in progress.** Structure, transport, provider/hooks, persistence, and handshake
> processing are built, and the real MLS crypto (**ts-mls**) is wired on web (`@agora-sdk/secure-chat-crypto/ts-mls`)
> and proven end-to-end against a running agora-server. Remaining Phase 2: KeyPackage replenishment
> tuning, passphrase backup/restore, generation-counter enforcement. Not yet published to npm.

## Packages

| Package | Role |
|---|---|
| `@agora-sdk/secure-chat-crypto` | The `SecureChatCrypto` seam: interface (main entry) + `MockSecureChatCrypto` (`./testing`) + the real **ts-mls** core (`./ts-mls`, ESM-only). Bare entry + `./testing` are dependency-free |
| `@agora-sdk/secure-chat-core` | Platform-agnostic: REST + `/secure` socket transport, `SecureChatProvider` + hooks, crypto via dependency injection |
| `@agora-sdk/secure-chat-react-js` | Web: real `SecureChatCrypto` (ts-mls) + IndexedDB persistence *(ESM-only)* |
| `@agora-sdk/secure-chat-react-native` | Bare React Native: Keychain + native MLS *(Phase 3 — stub)* |
| `@agora-sdk/secure-chat-expo` | Expo: SecureStore *(Phase 3 — stub)* |

## Install (once published)

```bash
# web
pnpm add @agora-sdk/core @agora-sdk/secure-chat-react-js
```

```tsx
import { ReplykeProvider } from "@agora-sdk/react-js";
import { SecureChatProvider } from "@agora-sdk/secure-chat-react-js";

<ReplykeProvider projectId={projectId} baseUrl={baseUrl}>
  <SecureChatProvider crypto={crypto} accessToken={accessToken}>
    {/* useSecureConversations(), useSecureMessages(), … */}
  </SecureChatProvider>
</ReplykeProvider>
```

## Develop

```bash
pnpm install
pnpm run build-all     # core → react-js → react-native → expo (dual ESM + CJS; react-js is ESM-only)
pnpm run typecheck
pnpm test              # unit suite (vitest) — fully mocked, no server needed
```

### Foundation e2e (optional, needs a running agora-server)

`pnpm test:e2e` drives the **real** transport clients against a locally running
[agora-server](https://github.com/jenova-marie/agora-server), proving the wire contract end to end
(register → DM → send → receive → realtime → reload, server-blind throughout). It is **opt-in**: skipped
unless `AGORA_E2E_DATABASE_URL` is set, so the default `pnpm test` and CI never need a server.

```bash
# 1. Start the server (in the agora-server repo), pointed at a Postgres you can write to:
pnpm db:migrate && pnpm dev:api        # listens on :4000

# 2. Run the e2e (env values must match the server's): 
AGORA_E2E_DATABASE_URL="postgres://…"  \
AGORA_E2E_ACCESS_TOKEN_SECRET="<server ACCESS_TOKEN_SECRET>"  \
pnpm test:e2e
```

Other knobs: `AGORA_E2E_BASE_URL` (default `http://localhost:4000/v7`), `AGORA_E2E_SOCKET_URL`
(default `http://localhost:4000`). The suite seeds its own throwaway project and tears it down.

## How this fits together

- **[agora-server](https://github.com/jenova-marie/agora-server)** — the blind MLS Delivery Service.
  Canonical spec: its `docs/SECURE_CHAT.md`.
- **[agora-sdk](https://github.com/jenova-marie/agora-sdk)** — the Replyke fork; we consume its
  published `@agora-sdk/core`.
- **agora-sdk-plus** (this repo) — the client crypto + transport + React layer.

See [CLAUDE.md](CLAUDE.md) for architecture, [ARCHITECTURE.md](ARCHITECTURE.md) for diagrams
(package graph, seams, runtime flows), [STATUS.md](STATUS.md) for current state, and
[`packages/secure-chat/ROADMAP.md`](packages/secure-chat/ROADMAP.md) for the Phase 2 task checklist.

## License

[Apache-2.0](LICENSE). Original Agora work; not affiliated with Replyke.
