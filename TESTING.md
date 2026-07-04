# Testing

How Agora SDK Plus is tested, why the harness is layered the way it is, and how to run and extend each
layer. The guiding idea: **each layer isolates a different fault domain**, so when something breaks you
can tell *which* layer it lives in instead of guessing.

> This is the client side of an E2EE messaging system against a **blind, untrusted** server (see
> [`CLAUDE.md`](CLAUDE.md) → "The model"). Tests reflect that: unit tests never touch a server or real
> crypto; the server-facing layers prove the wire contract and the blind-server invariant
> (ciphertext-only at rest) end to end.

## The four layers at a glance

| Layer | Command | Server? | Crypto | React? | Processes | Proves |
|---|---|---|---|---|---|---|
| **1. Unit suite** | `pnpm test` | no (mocked) | `MockSecureChatCrypto` | per-file (jsdom) | 1 | Logic of every unit in isolation: transport shaping, hooks, persistence, padding, safety numbers. |
| **2. Two-client hook composition** | `pnpm test` (unit files) | no (in-memory fake DS) | mock, real ts-mls, **and** the real web runtime | yes — real `useSecure*` (incl. StrictMode + IndexedDB) | 1 | The **hook orchestration**: two peers through the real provider+hooks against one shared fake server — mock crypto for speed, a ts-mls capstone for fidelity, and a browser-runtime case (StrictMode + IndexedDB + ts-mls). |
| **3. Foundation e2e** | `pnpm test:e2e` | **yes** (live agora-server) | mock **and** real ts-mls | no | 1 (two crypto instances) | The stack **below React** against a real server: transport, wire contract, ts-mls, server blindness, handshake inbox, reload/cursor catch-up. |
| **4. chat-diag** | `pnpm chat-diag -- --role …` | **yes** (live agora-server) | real ts-mls | no | **2 OS processes** | The same round-trip across a real process boundary, exercising the **device export/import "reload" seam**. |

Layers 1–2 run on every `pnpm test` and in CI (fully mocked, server-free). Layers 3–4 are **opt-in**
and need a running agora-server + a database — they are gated so the default test run never requires
either.

---

## Layer 1 — Unit suite (`pnpm test`)

[vitest](https://vitest.dev), driven by the root [`vitest.config.ts`](vitest.config.ts).

- **Glob:** `packages/**/src/**/*.test.{ts,tsx}` — co-located next to the code they cover. These files
  are excluded from every package's `tsc` build output.
- **Environment:** `node` by default. A hook/provider test opts into jsdom **per file** with a pragma
  on line 1:
  ```ts
  // @vitest-environment jsdom
  ```
- **Aliases (so tests run against source, no build needed):**
  - `@agora-sdk/secure-chat-crypto` and `…/testing` → the in-repo crypto package source, so tests
    `import { MockSecureChatCrypto } from "@agora-sdk/secure-chat-crypto/testing"` directly.
  - `@agora-sdk/secure-chat-core` and `@agora-sdk/social-core` → their source.
  - **No `@agora-sdk/core` alias.** Neither secure-chat nor social depends on `@agora-sdk/core` any
    more — they take `baseUrl` directly (see `CHANGELOG.md`) — so there is nothing to stub. The former
    `test-support/agora-sdk-core-stub.ts` was removed along with the alias.

**Rules for unit tests** (enforced expectations — see [`CLAUDE.md`](CLAUDE.md) → Engineering standards §5):

- Inject `MockSecureChatCrypto` from `@agora-sdk/secure-chat-crypto/testing`. **Never** reach for real
  MLS crypto or a live server in a unit test.
- Mock the transport at its boundary: `vi.spyOn(SecureChatRestClient.prototype, …)` /
  `vi.spyOn(SecureChatSocketClient.prototype, …)`. Assert on the **base64 / epoch wire shapes** the
  client emits.
- Cover the branches that matter: `@throws` paths, empty / `hasMore` pagination, the no-`group`
  "listed but undecrypted" path, realtime de-dup, fail-closed rejection.
- A bug fix starts with a test that **fails before** the fix and **passes after**.

Run:
```bash
pnpm test         # one-shot
pnpm test:watch   # watch mode
```

### Quieting an expected render-time throw

A negative test that asserts a hook throws when used outside its provider must suppress **two**
channels, or React 18's dev build spams stderr (the second is *not* `console.error`):

```ts
const errSpy = vi.spyOn(console, "error").mockImplementation(() => {}); // React's boundary warning
const swallow = (e: ErrorEvent) => e.preventDefault();                  // jsdom's jsdomError channel
window.addEventListener("error", swallow);
try {
  expect(() => renderHook(() => useThing())).toThrow(/within a <Provider>/);
} finally {
  window.removeEventListener("error", swallow);
  errSpy.mockRestore();
}
```
React re-dispatches the render throw onto a detached DOM node; jsdom catches it and reports via its
`jsdomError` virtual-console channel, which `preventDefault()` on the `error` event silences (jsdom's
`reportException` honors `defaultPrevented`).

---

## Layer 2 — Two-client hook composition

File: [`packages/secure-chat/core/src/hooks/two-client-handshake.test.tsx`](packages/secure-chat/core/src/hooks/two-client-handshake.test.tsx)
(runs as part of `pnpm test`).

This is the only unit-layer test that wires **two full clients through the real `useSecure*` hooks at
once**, so the hooks decide ordering at runtime — exactly what differs from the hand-sequenced server
layers. It is the bridge between "every unit works" (Layer 1) and "the round-trip works against a real
server" (Layers 3–4).

**How the shared fake server works.** A single in-memory `FakeServer` backs the REST + socket
boundary for *both* clients. Each client's provider is given a distinct bearer token
(`tok-alice` / `tok-bob`); the prototype spies read `this.config.getAccessToken()` to route a call to
the right caller's view of server state. The socket spy registers handlers per token, so the server can
fan a `secure:message` / `secure:welcome` to exactly one client.

**What it asserts.** The chain behind the app's "waiting for key update" state:

1. `useSecureMessages` lists a message it cannot decrypt yet → `status:"pending"`, `plaintext:null`.
2. `useSecureHandshakes` drains the Welcome from the inbox → `rememberGroup` → group-version bump.
3. The bump re-resolves the group in `useSecureMessages` → the `pending` row **flushes** to decrypted
   text — across both catch-up and live-socket delivery.

A companion case **characterizes the symptom**: mount the receive stack *without* `useSecureHandshakes`
and the DM lists but its message stays `pending` forever — proving that hook is the load-bearing piece.

It comes in two files:

- [`two-client-handshake.test.tsx`](packages/secure-chat/core/src/hooks/two-client-handshake.test.tsx)
  — **mock crypto**, fast. Four cases: the catch-up flush, the symptom characterization (no handshakes
  hook → stuck `pending`), live-socket delivery, and the **full `useSecureDevice` stack** (bob
  self-registers; the device→handshakes id handoff still joins + decrypts).
- [`two-client-ts-mls.test.tsx`](packages/secure-chat/core/src/hooks/two-client-ts-mls.test.tsx) —
  **real ts-mls**, the capstone. Bob registers + publishes real KeyPackages, alice claims a real one to
  build the group, and genuine MLS Welcomes/ciphertext flow through the hooks (catch-up + live). The
  fake server stores/dispenses real KeyPackages (the mock harness could hand back dummies). Slow by
  design, so it's intentionally small — orchestration coverage lives in the mock file; this proves it
  holds under real crypto.
- [`react-js/src/browser-runtime.test.tsx`](packages/secure-chat/react-js/src/browser-runtime.test.tsx)
  — the **real browser runtime**, using this package's actual web wiring: `createWebSecureChatCrypto()`
  (ts-mls) + `createIndexedDBStore()` (over `fake-indexeddb`, with real async transaction latency) +
  `<React.StrictMode>` (the dev mount→cleanup→mount double-invoke). Proves bob registers, joins, and
  decrypts — and that a "reload" (fresh crypto + fresh StrictMode mount on the same IndexedDB)
  rehydrates the device **without re-registering** (no churn). A sanity probe confirms StrictMode is
  genuinely doubling; the diagnostic shows why it's safe: `useSecureHandshakes` gates catch-up on a
  resolved device id, which is `undefined` on the doubled initial mount, so the real catch-up runs as a
  single dep-change re-run — the "double-process one Welcome" hazard never coincides with an active
  catch-up (observed: `processWelcome ×1`).

> **Diagnostic value.** These pass under mock crypto, real ts-mls, **and** the real browser runtime
> (StrictMode + IndexedDB). That exhausts the SDK: the conversations/handshakes/messages/device
> orchestration is sound in every combination a browser produces. A surviving "waiting for key update"
> therefore lives in the **consuming app's own provider/hook wiring** — e.g. re-creating the crypto or
> store on each render instead of memoizing them (which rebuilds the provider, churns the device, and
> drops the group cache) — not in this SDK (see the ladder below).

---

## Layer 3 — Foundation e2e (`pnpm test:e2e`)

File: [`e2e/secure-chat.e2e.ts`](e2e/secure-chat.e2e.ts), config
[`vitest.e2e.config.ts`](vitest.e2e.config.ts), fixtures [`e2e/bootstrap.ts`](e2e/bootstrap.ts).

The SDK's **real** transport clients talking to a **locally running agora-server**, proving the wire
contract end to end: register → publish/claim KeyPackages → start DM → recipient joins via the
handshake inbox → send → receive + decrypt → **server stored only ciphertext** → live `/secure`
realtime fan-out → fresh-client cursor catch-up (reload-survives) → backup/restore. The whole suite
runs **once per crypto variant**: the deterministic mock, then the real **ts-mls** core.

- **Separate config on purpose.** A different glob (`e2e/**/*.e2e.ts`, which the unit glob never
  matches) and **no `@agora-sdk/*` aliases** — the e2e imports the transport *source* by relative path
  to exercise the real client (it also confirms the transport loads under plain Node ESM with no React).
  30 s test/hook timeouts (a real socket + DB round-trip is slower than a unit test).
- **Single process, two crypto instances.** Both "alice" and "bob" are crypto instances in one Node
  process. There is **no React** here.
- **Opt-in gate.** The suite is `describe.skipIf(!env)` — skipped entirely unless
  `AGORA_E2E_DATABASE_URL` is set (see [Environment](#environment)). `bootstrap.ts` seeds a throwaway
  project + two users **directly into the server's database** and mints HS256 tokens under the server's
  `ACCESS_TOKEN_SECRET`, then drops the project (FK cascade) on teardown.

Run:
```bash
# 1. Start the standalone `@agora/secure-chat` process pointed at a Postgres you can write to
#    (default port :4002 — it serves both the secure REST and the /secure-socket/ realtime; the
#    main API on :4000 has neither). See the agora-server repo for the exact start command.
# 2. Run the e2e (env must match THAT running server — see Environment):
pnpm test:e2e
```

> **The #1 e2e gotcha:** `AGORA_E2E_DATABASE_URL` must point at the database the **running** secure-chat
> process actually reads (normally its DEV db) — **not** the server's own internal test database. If
> the test seeds one db and the server reads another, the seeded project is invisible to the server and
> **every** secure-chat request 404s (a long cascade of `undefined` ids). See [`.env.example`](.env.example).

---

## Layer 4 — chat-diag (`pnpm chat-diag -- --role initiator|responder`)

File: [`e2e/chat-diag.ts`](e2e/chat-diag.ts) (plan/spec under
[`docs/superpowers/`](docs/superpowers/)).

A **two-OS-process** diagnostic harness: it runs the full MLS round-trip with the **real ts-mls
crypto** against a live agora-server, split across two processes that hand off via
`~/.agora-chat-diag/session.json`. The responder **re-imports the initiator-exported device state**
into a fresh crypto instance — a faithful, observable stand-in for the browser's "reload, don't
re-register" seam, which is exactly the path the foundation e2e (one process) can't model.

It exists to **diagnose** the two-client handshake failure without cascading errors:

- A `step()` helper **hard-exits on the first failure**, so a root cause is never buried under a
  cascade of downstream `undefined` errors.
- Verbose per-step logging: REST paths, base64/epoch wire shapes, and the **`deviceId` (client text)
  vs `device.id` (server row UUID)** footgun — the row UUID is what Welcomes, KeyPackage claims, and
  message `senderDeviceId` actually route on.

Run (same env as the e2e; reuses `bootstrap.ts`):
```bash
pnpm chat-diag -- --role initiator    # seeds, registers, builds the group, sends, writes session.json
pnpm chat-diag -- --role responder    # fresh process: imports state, drains Welcome, joins, decrypts, tears down
```
`session.json` is keyed to the database the initiator seeded into — if you change `AGORA_E2E_DATABASE_URL`
or the server's DB, re-run the initiator before the responder.

---

## The fault-isolation ladder

The layers form a ladder from "pure logic" to "real processes". Reading it top-down is how you localize
a bug; each rung **eliminates** a fault domain so the next rung's failure is unambiguous.

```
Layer 1  unit             → a single unit's logic is wrong
Layer 2a hooks + mock      → the hook ORCHESTRATION is wrong (ordering, version-bump, flush, device id)
Layer 2b hooks + ts-mls    → real MLS under the hooks is wrong
Layer 2c browser runtime   → StrictMode double-invoke or real IndexedDB persistence is wrong
Layer 3  e2e (1 process)   → transport / wire contract / ts-mls / server blindness is wrong
Layer 4  chat-diag (2 procs)→ the device export/import "reload" seam is wrong across a real boundary
─────────────────────────────────────────────────────────────────────────────
everything above green     → the fault is in what NONE of them exercise:
                             the CONSUMING APP's own provider/hook wiring (e.g. crypto/store re-created
                             per render instead of memoized → provider rebuild → device churn)
```

Worked example (the "waiting for key update" investigation): Layers 3 and 4 went green — transport,
ts-mls, server blindness, the handshake inbox, and the reload seam are all sound, even across two
processes. Layer 2a — the conversations/handshakes/messages/device orchestration is sound under mock
crypto. Layer 2b — it holds under **real ts-mls under the hooks**. Layer 2c — it holds under the **real
browser runtime** (StrictMode double-invoke + real IndexedDB), including reload-without-churn. Every
rung is green, so the SDK is exhausted: a surviving bug is in the **consuming app's wiring** — most
commonly a `crypto`/`store` prop re-created on each render instead of being memoized, which rebuilds the
provider (new rest/socket/repo + a fresh group cache) and re-registers the device every render. That is
not reproducible at the SDK boundary because the SDK takes those as caller-owned props.

---

## Environment

Layers 3–4 need two env vars (the other two are optional). Copy [`.env.example`](.env.example) to
`.env` (gitignored; a repo `.envrc` containing `dotenv` auto-loads it via direnv):

| Var | Required | Meaning |
|---|---|---|
| `AGORA_E2E_DATABASE_URL` | **yes** (also the run gate) | Postgres the e2e seeds into — **must be the db the running server reads** (its DEV db), not the server's internal test db. |
| `AGORA_E2E_ACCESS_TOKEN_SECRET` | **yes** | The running server's `ACCESS_TOKEN_SECRET`; minted tokens must verify under it. |
| `AGORA_E2E_BASE_URL` | no (default `http://localhost:4002/v7`) | REST base incl. the `/v7` prefix — the standalone secure-chat process, not the main API on `:4000`. |
| `AGORA_E2E_SOCKET_URL` | no (default `http://localhost:4002`) | Socket.io origin (the client appends `/secure`). |

If `AGORA_E2E_DATABASE_URL` is set but `AGORA_E2E_ACCESS_TOKEN_SECRET` is missing, `bootstrap.ts` fails
fast with a clear message rather than deep inside an auth check.

---

## Quick reference

```bash
pnpm test            # Layers 1–2: unit suite + hook composition (mocked, server-free)
pnpm test:watch      # the same, in watch mode
pnpm typecheck       # tsc --noEmit at the root (must stay green)
pnpm test:e2e        # Layer 3: foundation e2e (needs a running server + env)
pnpm chat-diag -- --role initiator   # Layer 4: two-process diagnostic, sender half
pnpm chat-diag -- --role responder   #          receiver half (reload seam)
```

Before claiming work complete: `pnpm test` **and** `pnpm typecheck` green (see
[`CLAUDE.md`](CLAUDE.md) → Engineering standards).
