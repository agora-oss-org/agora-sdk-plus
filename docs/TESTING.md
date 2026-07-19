# Testing 🧪

> **Audience:** anyone hacking on `agora-sdk-plus` — contributors writing tests, reviewers checking
> coverage, and CI.
> **The standard it serves:** [`CLAUDE.md`](../CLAUDE.md) §5 — *every feature and fix ships with unit
> tests in the same change*. This doc explains how the three test layers fit together and exactly what
> each one needs to run.

---

## The three layers 🎚️

| Layer | What it proves | Server? | Command | Default run? |
|---|---|---|---|---|
| **Unit** (node) | Logic + the base64/epoch **wire shapes** the clients emit, with crypto + transport mocked | no | `pnpm test` | ✅ always |
| **Unit** (jsdom) | React providers/hooks/components, opted in per-file | no | `pnpm test` (same run) | ✅ always |
| **e2e** | The **real** REST + socket transport against a **running agora-server** (register → DM → send → receive → realtime → reload) | yes | `pnpm test:e2e` | ⛔ opt-in (gated) |

The whole point of the split: `pnpm test` and CI stay **server-free and deterministic**. The e2e suite
is inert unless you explicitly point it at a server (see [e2e](#layer-3--e2e-opt-in-real-server-)).

There's also a non-test **diagnostic** (`pnpm chat-diag`) and a packaging **guard**
(`pnpm verify:dist`) — covered at the end.

## TL;DR commands 🚀

```bash
pnpm install
pnpm test            # unit suite — fully mocked, no server. 530 cases across 65 files
pnpm test:watch      # vitest watch mode while iterating
pnpm typecheck       # tsc --noEmit at the root (not a test, but part of "green")

# opt-in e2e — needs a running agora-server + the two env vars below
AGORA_E2E_DATABASE_URL=postgres://… \
AGORA_E2E_ACCESS_TOKEN_SECRET=…match-the-server… \
pnpm test:e2e
```

The harness is **[vitest](https://vitest.dev)** (`v4`). Two root configs drive everything:
[`vitest.config.ts`](../vitest.config.ts) (unit) and [`vitest.e2e.config.ts`](../vitest.e2e.config.ts)
(e2e). They use **disjoint globs**, so the two never overlap.

---

## Layer 1 & 2 — the unit suite (`pnpm test`) 🧩

Driven by [`vitest.config.ts`](../vitest.config.ts):

- **Glob:** `packages/**/src/**/*.test.{ts,tsx}` — tests are **co-located** next to the code they
  cover. (`*.test.ts(x)` files are excluded from every package's `tsc` build output.)
- **Default environment:** `node`.
- **No server, no live crypto.** Inject `MockSecureChatCrypto` from
  `@agora-sdk/secure-chat-crypto/testing`; mock the transport (`SecureChatRestClient` /
  `SecureChatSocketClient`) at its boundary and assert on the **base64 / epoch wire shapes** the client
  emits.

### Source aliases (why no build is needed)

The config aliases the workspace packages to their **source**, so tests import the public entry points
without first building `dist/`:

| Import | Resolves to |
|---|---|
| `@agora-sdk/secure-chat-crypto` | `packages/secure-chat/crypto/src/index.ts` |
| `@agora-sdk/secure-chat-crypto/testing` | `…/crypto/src/testing.ts` (the mock) |
| `@agora-sdk/secure-chat-crypto/ts-mls` | `…/crypto/src/ts-mls/index.ts` (real MLS core) |
| `@agora-sdk/secure-chat-core` | `packages/secure-chat/core/src/index.ts` |
| `@agora-sdk/social-core` | `packages/social/core/src/index.ts` |
| `@agora-sdk/public-read-core` | `packages/public-read/core/src/index.ts` |

The more-specific subpath aliases are listed first so they win over the bare entry. There is **no
`@agora-sdk/core` alias** — secure-chat, social, and public-read don't depend on it (they take
`baseUrl` directly), so there's nothing to stub. `public-read` goes furthest: it takes no token at
all, so its tests never mint or mock one. (`auth-react-js`, the one SDK-coupled feature, mocks
`@agora-sdk/react-js`'s hooks at the test boundary.)

### React tests → jsdom, per file

Hook/provider/component tests opt into a DOM **per file** with a pragma at the top — they otherwise run
under `node` like everything else:

```ts
// @vitest-environment jsdom
```

These use `@testing-library/react` (+ `react`/`react-dom`, all `devDependencies`). ~28 test files do
this today (the `social-react-js`, `secure-chat-react-js`, `public-read-react-js`, and `auth-react-js`
component/hook suites).

> ⚠️ **Call `cleanup()` yourself in component tests.** The root config does **not** enable vitest
> `globals`, so `@testing-library/react` never registers its automatic `afterEach(cleanup)`. Without
> one, every `render()` stays mounted in `document.body` and later queries match elements left behind
> by earlier tests — which surfaces as a confusing *"Found multiple elements with the text…"* rather
> than an obvious leak. Suites that render the same fixture text more than once **must** do:
>
> ```ts
> import { cleanup } from "@testing-library/react";
> afterEach(cleanup);
> ```
>
> `renderHook`-only suites are unaffected. Existing suites that skip it do so only because their
> fixtures happen to differ per test — don't rely on that.

### The WebCrypto realm shim 🔐

[`vitest.config.ts`](../vitest.config.ts) loads one **setup file** for the whole suite:
[`test-support/jsdom-webcrypto-realm.ts`](../test-support/jsdom-webcrypto-realm.ts). It restores Node's
`ArrayBuffer` as the global so jsdom tests share Node's WebCrypto realm — without it, ts-mls's real-MLS
path fails on Node 20 (a cross-realm bare `ArrayBuffer` is rejected by `importKey`). It's a no-op under
the `node` environment.

### Roughly where the coverage lives

```
packages/secure-chat/core         27 files   transport, provider, hooks, contract round-trips
packages/secure-chat/crypto        5 files   the mock + ts-mls seam
packages/secure-chat/react-js      3 files   web crypto factory + IndexedDB store
packages/social/core               6 files   provider gating + feature hooks
packages/social/react-js           4 files   components (jsdom)
packages/social/react-native       2 files   components
packages/auth/react-js             7 files   OAuth callback + ergonomics hooks (jsdom)
```

Cover the branches that matter: `@throws`/error paths, empty/`hasMore` pagination, the no-`group`
"listed but undecrypted" path, and realtime de-dup. **Never** log/throw/serialize plaintext, group
secrets, private keys, `privateState`, or backup passphrases — even in test output.

---

## Layer 3 — e2e (opt-in, real server) 🌐

Driven by [`vitest.e2e.config.ts`](../vitest.e2e.config.ts). **Two independent suites live here**, each
gated on its own env var so either can run alone:

| Suite | Gate | Proves |
|---|---|---|
| [`e2e/secure-chat.e2e.ts`](../e2e/secure-chat.e2e.ts) | `AGORA_E2E_DATABASE_URL` | the full blind-DS loop (below) |
| [`e2e/public-read.e2e.ts`](../e2e/public-read.e2e.ts) | `AGORA_E2E_PUBLIC_PROJECT_ID` | the anonymous `/public/*` surface |

The **public-read** suite covers what a mocked transport structurally cannot: real CORS headers
(wildcard ACAO, no credentials, no `Vary: Origin`), the `ETag` → `304` revalidation round trip,
`no-store` on the gate's `404`, live PII redaction, and that the walled surface still `401`s the same
entity. It needs no DB access or minted JWT — only a running server and a seeded fixture
(`pnpm seed` from `agora-server/apps/api`, which publishes an anchor with
`foreignId: "homepage-comments"`). It resolves that anchor **by `foreignId`**, never a hardcoded uuid,
because the uuid is generated per install.

The **secure-chat** suite is the **foundation validation**: the
SDK's **real** transport clients talking to a **locally running agora-server** (the blind Delivery
Service), proving the full loop — register → publish KeyPackages → start a DM → deliver the Welcome →
send → list/decrypt → live socket fan-out → restore-on-new-browser → catch-up-from-cursor.

What makes it different from the unit config:

- **Glob:** `e2e/**/*.e2e.ts` — the unit glob (`packages/**/src/**`) never matches it.
- **No `@agora-sdk/*` aliases.** We want the **real** transport, so the e2e imports the transport
  source by relative path (vite resolves the `.js` specifiers to `.ts`).
- **Longer timeouts** (`testTimeout`/`hookTimeout` = 30s) — a real socket connect + DB round-trip is
  slower than a unit test.
- **Runs the whole round-trip twice**, once per crypto variant
  ([`e2e/crypto-factory.ts`](../e2e/crypto-factory.ts)): the deterministic **mock** (fast smoke), then
  the **real ts-mls** core (genuine MLS blobs through the blind server — the actual proof the
  foundation supports it).

### Prerequisites ✅

1. **A running agora-server** — specifically the standalone `@agora/secure-chat` process (default port
   **4002**), which serves both the secure REST (`/v7/:projectId/secure-chat/*`) and the
   `/secure-socket/` realtime. The main API on `:4000` has neither.
2. **Postgres** — the same database the server reads. The harness **seeds directly into it** (it does
   not go through any signup API).
3. **Two env vars** (the run gate). The suite is `describe.skipIf(!env)`, so without these it's
   silently inert:

| Variable | Required | Meaning |
|---|---|---|
| `AGORA_E2E_DATABASE_URL` | **yes** — the gate | Postgres URL of the DB the running server reads. Unset ⇒ whole suite skipped. |
| `AGORA_E2E_ACCESS_TOKEN_SECRET` | **yes** | The server's `ACCESS_TOKEN_SECRET`. Our minted JWTs must verify under it. (Set the DB var but not this one ⇒ **fail fast**, by design.) |
| `AGORA_E2E_BASE_URL` | no | REST base incl. `/v7`. Default `http://localhost:4002/v7`. |
| `AGORA_E2E_SOCKET_URL` | no | Socket.io origin (client appends the namespace). Default `http://localhost:4002`. |
| `AGORA_E2E_PUBLIC_PROJECT_ID` | **yes — the public-read gate** | Project id holding the seeded public anchor. Unset ⇒ that suite skipped (independent of the secure-chat gate). |
| `AGORA_E2E_PUBLIC_FOREIGN_ID` | no | The anchor's key. Default `homepage-comments`. |

Match `AGORA_E2E_ACCESS_TOKEN_SECRET` and `AGORA_E2E_DATABASE_URL` to the **running server's `.env`**,
or tokens won't verify / rows land in the wrong DB.

### How the harness sets up & tears down 🧹

[`e2e/bootstrap.ts`](../e2e/bootstrap.ts) seeds straight into Postgres (`pg`) — `INSERT INTO
projects`/`profiles` — and mints HS256 bearer tokens with `jose` (`SignJWT` over the secret), mirroring
agora-server's own integration helpers. **`project_id` is the isolation boundary:** one throwaway
project per run, dropped on teardown (FK cascade wipes its profiles/devices/conversations/messages).
None of this is shipped SDK code — it's test infrastructure, kept out of the unit glob and tsconfig
`include`.

### Run it

```bash
# from the server side: bring up the secure-chat process + its Postgres first, then:
AGORA_E2E_DATABASE_URL=postgres://user:pass@localhost:5432/agora \
AGORA_E2E_ACCESS_TOKEN_SECRET=the-servers-access-token-secret \
pnpm test:e2e
```

---

## Diagnostic: `pnpm chat-diag` 🩺

[`e2e/chat-diag.ts`](../e2e/chat-diag.ts) is a **two-process** diagnostic (not a test) using the **same
env vars** as the e2e. It drives the real ts-mls crypto + `SecureChatRestClient` against a running
server, split across two OS processes so the device-state **persistence seam** (export on one process,
import into a fresh one) is exercised for real — a faithful stand-in for "reload, don't re-register",
where a known browser bug lives.

```bash
pnpm chat-diag -- --role initiator   # seeds, registers both devices, creates DM, sends
pnpm chat-diag -- --role responder   # imports bob's state, drains handshakes, decrypts
```

It logs each step's REST path and base64/epoch wire shapes (never secrets/plaintext) and **hard-exits**
on the first failure so one error can't cascade into a misleading second.

## Packaging guard: `pnpm verify:dist` 📦

[`scripts/verify-dist.mjs`](../scripts/verify-dist.mjs) is a post-`build-all` check (run it after
`pnpm run build-all`). It catches the two defects `tsc` can't see — extensionless relative imports in
ESM output, and CJS output mis-typed as ESM — by statically linting every package's `dist/` and doing a
runtime ESM+CJS load of the dependency-free `crypto` package. Not part of `pnpm test`; run it before
publishing.

---

## Checklist before you call work done ✔️

- [ ] New feature / fix ships with co-located `*.test.ts(x)` in the **same change** (a fix starts with
      a test that **fails before, passes after**).
- [ ] `pnpm test` is **green**.
- [ ] `pnpm run typecheck` is **green**.
- [ ] Tests inject `MockSecureChatCrypto` and mock transport at its boundary — no live crypto, no live
      server in unit tests.
- [ ] No secret/plaintext leakage in test code or fixtures.
- [ ] (If touching transport/protocol) consider an `pnpm test:e2e` run against a local server.
