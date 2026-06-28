# `@agora-sdk/auth-react-js` — black-box OAuth callback + auth ergonomics

**Status:** Design (approved for planning)
**Date:** 2026-06-27
**Author:** Jenova Marie (with Claude)
**Source report:** `agora-sdk/docs/AUTH_IMPLEMENTATION.md` (the field report this design answers)

---

## 1. Problem

Email/password auth in the Agora SDK (`@agora-sdk/*`, a Replyke fork) is genuinely black-box.
**OAuth is not.** Wiring the live comments widget into `agora-www` (an Astro MPA) surfaced two leaks
that cost an afternoon of source-reading, captured in `agora-sdk/docs/AUTH_IMPLEMENTATION.md`:

1. **The persist → navigate race.** `handleOAuthCallback()` is fire-and-forget with *deferred*
   persistence. It stages tokens in Redux, kicks off an **async** user fetch, and returns `true`
   **synchronously** — but the session isn't written to `localStorage` until `useAccountSync`'s
   effects run several render cycles later, gated on a ~1.4s network round-trip. Any MPA callback that
   navigates on the synchronous return (the obvious thing, and what the JSDoc implies is safe) tears
   down the React tree + Redux store **before** persistence runs, silently losing the fresh session.
   The user lands logged out. The SPA demo never navigates, so it never sees this.

2. **`useAuth().signOut()` doesn't reliably end the session.** With more than one stored account it
   "switches to a remaining account" instead of logging out, and can't clear a stale/corrupt map.
   `useSignOutAll()` is the real logout, but nothing signals that the active-account variant is the
   wrong default for a single-session app. Separately, a stale refresh token (server-side family
   rotated away) sits in the accounts map and throws `unknown token` 401 on every activation, with no
   prune-on-failure — a returning user whose only session has gone stale boots straight to logged-out.

The report proposes P1–P7. **P1/P2/P6 are SDK-internal** (they change `oauthCore` / `useAccountSync` /
the Redux store and would widen the fork's divergence from upstream Replyke). **P3/P4/P5/P7 are
wrapper-able** — they can sit *outside* the SDK. This design productizes the wrapper-able set (plus a
safe, wrapper-only emulation of P1 and P6) as a new `agora-sdk-plus` package, so the fork stays a tiny
documented delta and the next integrator writes ~3 lines instead of reverse-engineering internals.

## 2. Goals / non-goals

**Goals**
- An MPA integrator never touches `localStorage` keys, counts render cycles, or reads `useAccountSync`.
- One tested, maintained helper replaces the per-integrator §6.1 workaround.
- Solve, via a wrapper: **P3** (MPA callback helper), **P1 emulated** (navigate only after real
  persistence), **P4** (first-class auth-ready status), **P5** (logout that ends the session),
  **P6** (self-heal a stale-only session), **P7** (docs).

**Non-goals**
- **No edits to the `agora-sdk` fork's behavior.** P1/P2 *proper* (awaitable callback; persist inside
  the auth thunk) stay future SDK work — a wrapper emulates the *observable outcome* of P1 but cannot
  move persistence into the thunk. The only optional fork touch is a one-line JSDoc cross-link (§8),
  explicitly skippable.
- **No React Native / Expo.** The teardown race is web-specific (cross-document navigation). RN/Expo
  OAuth uses an in-app browser and does not tear down the tree. Web-first, `react-js` only.

## 3. Architecture

### 3.1 Package shape

New feature group, mirroring the repo's `secure-chat` / `social` layout but **single-package**
because every line is web-coupled (`window`, `localStorage`, cross-document navigation, `react-js`
hooks) — there is no platform-agnostic core worth extracting:

```
packages/auth/react-js   →   @agora-sdk/auth-react-js   (web only; dual ESM + CJS)
```

- **peerDependencies:** `react`, `react-dom`, `@agora-sdk/react-js` (the consuming app already has
  all three; the helper runs *inside* `<ReplykeProvider>`).
- This is the **first plus feature that depends on `@agora-sdk/*`.** That is a deliberate, scoped
  exception: auth is intrinsically *about the SDK's own session*, unlike the standalone
  secure-chat / social features. Recorded in `CLAUDE.md` + `ARCHITECTURE.md` (§7).

### 3.2 Coupling model — observe, don't race

The helper runs inside `ReplykeProvider` and **observes the SDK's own auth state via its public
hooks** (`useAuth`, `useUser`, `useOAuthSignIn`, `useSignOutAll`) rather than re-implementing the auth
or storage contract. It reaches into `localStorage` for exactly two things hooks cannot express:
the final "the session row actually landed" gate (§3.3) and the P6 prune (§3.5). **All such access is
quarantined in one module, `accountStorage.ts`** — the single place that knows the
`replyke-accounts:<projectId>` key prefix and the `{ activeAccountId, accounts: { [userId]:
{ refreshToken, tokenExpiresAt, user } } }` map shape. If upstream changes the contract, one file
changes here instead of every integrator's callback page.

> This was the explicitly-rejected alternative: a *fully decoupled* helper that re-implements the
> storage key + REST endpoints would **duplicate** the exact internal contract the report calls a
> leak, across two repos that can silently drift — worse coupling, merely hidden. Observing the SDK's
> settled state is correct-by-construction.

### 3.3 The persistence gate (P1 emulated + P3 core)

`useOAuthCallback({ redirectTo })` is a small state machine — `status: 'pending' | 'success' |
'error'` — that gates navigation on **observed persistence**, not a timer:

1. **Parse once.** On mount, call `handleOAuthCallback()` exactly once (a `useRef` guard against
   StrictMode double-invoke / re-render). This only stages tokens in Redux and starts the async user
   fetch. If it returns a provider error (`?error=` in the callback query) → `status:'error'`, surface
   the message, clean the URL, **do not navigate**.
2. **Wait for the session to be real.** An effect watches `useAuth().accessToken` **and**
   `useUser().user?.id`. While either is missing, the user fetch is still in flight → stay `pending`.
3. **Confirm the write landed.** Once both exist, read the persisted account map via `accountStorage`
   and confirm `accounts[user.id].refreshToken` is present — the exact state the *next* document reads
   on boot. Only then → `status:'success'` and navigate to `redirectTo`. (This is §6.1's
   `requestAnimationFrame` poll, written once and tested.)

If persistence never lands (network dies mid-fetch), the machine stays `pending` forever rather than
faking success; the component layer (§3.4) renders a spinner and offers a caller-supplied
`onTimeout` / escape hatch. **Never a false success.**

### 3.4 Public API

```tsx
// P3 + P1(emulated) — headless engine. Drop onto the /auth/callback route.
const { status, error } = useOAuthCallback({
  redirectTo: '/#comments',           // where to go once the session is truly persisted
  onTimeout?: () => void,             // optional: persistence never landed
  timeoutMs?: number,                // optional, default e.g. 15000
});
//      status: 'pending' | 'success' | 'error'

// P3 — drop-in component over the same engine, for copy-paste integrators.
<OAuthCallbackHandler
  redirectTo="/"
  onSuccess={() => void}
  onError={(message: string) => void}
  onTimeout={() => void}
  pending={<Spinner/>}                // optional render slots
  error={(msg) => <ErrorPanel .../>}  // optional
/>

// P4 — first-class auth-ready signal, derived once instead of by every integrator.
const { status, isPersisted } = useAuthStatus();
//      status: 'initializing' | 'authenticated' | 'unauthenticated'
//      isPersisted: boolean  (the session exists in localStorage, not just Redux)

// P5 — logout that actually ends the session, named for intent. Wraps useSignOutAll.
const { signOutEverywhere, isPending } = useSignOutEverywhere();
```

`status: 'initializing'` is true until the SDK's `accountsReady` resolves; `'authenticated'` requires
`accessToken && user`; otherwise `'unauthenticated'`.

### 3.5 P6 — stale-account self-heal (observe-the-outcome)

A `useAuthSelfHeal()` effect (mounted by the same provider/component the integrator already uses)
prunes a dead session by **observing the SDK's settled outcome**, never by issuing its own refresh
call (an active probe would duplicate the SDK's refresh and re-create the "two refresh tokens in play"
race the report fingerprints).

It prunes the active account **only when all hold**: accounts are `ready`, an active account **exists
in storage**, and the SDK settled **unauthenticated** (`status === 'unauthenticated'` per §3.4 — i.e.
no `accessToken`/`user` after boot). It removes that one active id via `accountStorage`, then lets the
SDK re-evaluate the remaining accounts (Phase A's "default to first available").

**Safety guards:**
- A `useRef<Set<string>>` of already-healed ids → each dead id is pruned **at most once**, preventing
  a prune → re-eval → prune loop.
- Never runs while `status === 'initializing'`.
- Only prunes when the SDK *itself* failed to authenticate — heuristic, but it can only fire on a
  genuinely unusable active account.

## 4. Error handling

| Condition | Behavior |
|---|---|
| Provider error (`?error=` in callback query) | `status:'error'` + message; URL cleaned; no navigation. |
| User fetch still in flight | `status:'pending'`; spinner; no premature navigation. |
| Persistence never lands (network dies) | stays `pending` until `timeoutMs` → `onTimeout`; never false success. |
| Stale-only active account on boot | P6 prunes once; SDK falls back to remaining accounts or unauthenticated. |

**Security (plus standard #1):** never log, throw-with, or serialize tokens or refresh tokens. The
helper handles them only to hand back to the SDK and to read presence (not value) from storage.

## 5. Testing (vitest + jsdom)

Mock `@agora-sdk/react-js` hooks at the boundary and drive the race deterministically — assert the
machine does **not** navigate until **both** the store state (`accessToken` + `user.id`) *and* the
`localStorage` row exist. Co-located `*.test.tsx` (excluded from `tsc` build), per standard #5.

Cases:
- **Happy path:** parse → pending while user fetch in flight → success only after store + storage both
  present → navigates to `redirectTo`.
- **Provider error:** `?error=` → `status:'error'`, URL cleaned, no navigation.
- **Premature-nav guard:** store has `accessToken` but storage row absent → still `pending`, no nav.
- **Timeout:** persistence never lands → `onTimeout` fires, no false success.
- **P6 self-heal:** ready + stored active account + unauthenticated → prunes exactly once (asserts the
  already-healed guard prevents a second prune).
- **`useAuthStatus`:** the `initializing → authenticated` / `→ unauthenticated` transitions.

`pnpm test` green and `pnpm run typecheck` green before the work is complete.

## 6. Module layout

```
packages/auth/react-js/
  src/
    index.ts                  # public exports
    useOAuthCallback.ts       # P1-emulated + P3 engine (the persistence gate, §3.3)
    OAuthCallbackHandler.tsx  # P3 drop-in component over the engine
    useAuthStatus.ts          # P4 derived status + isPersisted
    useSignOutEverywhere.ts   # P5 wrapper over useSignOutAll
    useAuthSelfHeal.ts        # P6 observe-the-outcome prune (§3.5)
    accountStorage.ts         # the ONLY module that knows the storage key + map shape
    *.test.tsx                # co-located unit tests
  package.json  tsconfig.esm.json  tsconfig.cjs.json  README.md
```

## 7. Housekeeping / standards

- **TSDoc** on every exported symbol (standard #2): real descriptions, `@param`/`@returns`/`@throws`,
  `@example` for each hook + the component.
- **CHANGELOG** (standard #4): bullet under `[Unreleased] › Added` in the same commit.
- **CLAUDE.md + ARCHITECTURE.md:** record the scoped `@agora-sdk/react-js` peer-dep as a deliberate
  exception to the "no `@agora-sdk/core` dependency" invariant (auth is *about* the SDK session;
  secure-chat / social stay standalone). Add the package to the package graph + `build-all` /
  `version:*` / `publish-*` script lists in root `package.json`.
- **README:** the canonical MPA callback pattern (the thing everyone tries to write, now correct).

## 8. Optional, separate fork touch (P7, skippable)

One line in `agora-sdk`'s `useOAuthSignIn` JSDoc: *"For cross-document/MPA callbacks, prefer
`@agora-sdk/auth-react-js`'s `useOAuthCallback` — calling `handleOAuthCallback()` and navigating
immediately loses the session (deferred persistence)."* This is the only change that touches the fork
and is explicitly out of the package's critical path — it can land later or never.

## 9. Future work (not this spec)

- **P1/P2 proper** in the SDK: make `handleOAuthCallback()` return a `Promise` that resolves after
  persistence, and move persistence into the auth thunk via an injected storage adapter. That dissolves
  the race at the root and lets this package's `useOAuthCallback` shed its localStorage gate. Tracked
  as SDK work because it widens the fork delta — out of scope here.
- **RN / Expo** auth ergonomics if a native teardown case ever appears.
