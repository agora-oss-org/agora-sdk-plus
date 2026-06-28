# Auth ergonomics 🔑✨

> **Audience:** anyone wiring Agora SDK auth (especially **OAuth**) into a **web** app — and the folks
> maintaining `@agora-sdk/auth-react-js`.
> **Package:** `@agora-sdk/auth-react-js` (web only).
> **Field report this answers:** [`agora-sdk/docs/AUTH_IMPLEMENTATION.md`](https://github.com/jenova-marie/agora-sdk) (P1/P3/P4/P5/P6/P7).

---

## Overview 💡

The Agora SDK's email/password auth is already black-box: call the hook, `await`, done. **OAuth
isn't** — in a multi-page app (Astro, Next.js, Remix, SvelteKit) it leaks internal invariants the
integrator has to reverse-engineer, and the classic symptom is *signing in successfully and landing
back on the page logged out*. This package makes OAuth black-box too, by running **inside
`<ReplykeProvider>`** and **observing the SDK's own auth state** rather than racing it. You never
touch `localStorage` keys, count render cycles, or read `useAccountSync`.

> **Scope:** web only. The bug it fixes is specific to **cross-document navigation** (the React tree +
> Redux store are torn down between "tokens received" and "thread mounts"). React Native / Expo OAuth
> uses an in-app browser and doesn't tear the tree down, so there's nothing to fix there.

## The underlying problem 🧩

`handleOAuthCallback()` is **fire-and-forget with deferred persistence**: it stages tokens in Redux,
kicks off an *async* user fetch, and returns `true` **synchronously** — but the session isn't written
to `localStorage` until several render cycles later, gated on a network round-trip. A callback page
that navigates on that synchronous return — the obvious approach — destroys the React tree *before*
persistence runs, and the freshly minted session is lost. A single-page app that never navigates does
not hit this; a multi-page app always does.

## API: hooks + component 🧰

```bash
pnpm add @agora-sdk/auth-react-js
# peers you already have: react, react-dom, @agora-sdk/react-js
```

### `useOAuthCallback` — the callback page, done right

Parses the redirect once, waits until a fresh session is **actually persisted to `localStorage`** —
the exact state the destination document boots from — *then* navigates:

```tsx
import { useOAuthCallback } from "@agora-sdk/auth-react-js";

export default function Callback() {
  const { status, error } = useOAuthCallback({ redirectTo: "/#comments" });
  if (status === "error") return <p>Sign-in failed: {error}</p>;
  return <Spinner />; // on success it full-page-navigates to redirectTo for you
}
```

The gate keys on the **persisted row**, not on volatile in-store Redux auth — so it stays correct even
when a leftover **stale account** triggers an SDK boot-refresh that fails `401` and resets the
in-store token mid-flow (field report A8). For a **single-session** app you can additionally pass
`pruneStaleOnMount` to clear any pre-existing account before the callback is parsed, which silences
that cosmetic `401` (leave it off for multi-account apps, where a pre-existing account may still be
valid):

```tsx
useOAuthCallback({ redirectTo: "/#comments", pruneStaleOnMount: true });
```

### `<OAuthCallbackHandler>` — the copy-paste drop-in

```tsx
import { OAuthCallbackHandler } from "@agora-sdk/auth-react-js";

<OAuthCallbackHandler redirectTo="/" onError={(m) => toast(m)} pending={<Spinner />} />
```

### `useAuthStatus` — a first-class auth-ready signal

Stop re-deriving `Boolean(accessToken && user)` and guessing when the two settle:

```tsx
import { useAuthStatus } from "@agora-sdk/auth-react-js";
const { status, isPersisted } = useAuthStatus();
//      status: 'initializing' | 'authenticated' | 'unauthenticated'
```

### `useSignOutEverywhere` — logout that actually ends the session

```tsx
import { useSignOutEverywhere } from "@agora-sdk/auth-react-js";
const { signOutEverywhere, isPending } = useSignOutEverywhere();
<button disabled={isPending} onClick={() => void signOutEverywhere().catch(() => {})}>Sign out</button>
```

> Prefer this over the SDK's `useAuth().signOut()`, which is **active-account-only** — with more than
> one stored account it *switches* to a remaining account instead of logging out.

### `useAuthSelfHeal` — recover a stale-only session

A returning user whose only stored refresh token has been rotated away server-side would otherwise
boot → `unknown token` 401 → stuck logged out. Mount this once and it prunes that dead account:

```tsx
import { useAuthSelfHeal } from "@agora-sdk/auth-react-js";
function App() { useAuthSelfHeal(); return <Thread />; } // prunes a dead active account, once
```

## Design guarantees 🧼

- **Gates on the persisted row, not volatile store state.** `useOAuthCallback` declares success only
  once a *fresh* account (new active id, or an advanced token expiry) lands in `localStorage` — the
  exact thing the next document reads on boot. It deliberately ignores in-store Redux `accessToken`,
  which a competing stale-account boot-refresh can reset out from under a successful login (A8). The
  SDK's same-tab writes don't emit a `storage` event, so it polls.
- **One quarantined seam.** The only code that knows the SDK's storage contract
  (`replyke-accounts:<projectId>` key + map shape) lives in a single module, `accountStorage.ts`. If
  upstream changes the contract, one file changes here — not every integrator's callback page.
- **The lone SDK coupling.** This is the one `agora-sdk-plus` feature that depends on the SDK (a
  `@agora-sdk/react-js` **peerDependency**), deliberately: auth is *about* the SDK's session. Secure
  chat and social stay standalone. See [`CLAUDE.md`](../CLAUDE.md) for the scoped-exception note.

## The A8 race: fix choices, and the one we left upstream 🧭

The field report (A8) offered three ways to fix the stale-account race. They are **not mutually
exclusive** — they sit at different layers.

| | Fix | Layer | Status |
|---|---|---|---|
| **1** | Gate `useOAuthCallback` on the **persisted row**, not in-store auth | this package | ✅ **shipped** (the gate above) |
| **2** | **Prune** the stale account before parsing the callback | this package | ✅ shipped as opt-in `pruneStaleOnMount` |
| **3** | Stop a stale-account refresh failure from resetting auth a newer `setTokens` just established | **the SDK** (`agora-sdk`) | ⏳ **not done — deferred upstream** (see below) |

### Option 3 — the cleanest fix, and why it isn't here

Option 3 is the **root-cause** fix. The race is: the SDK boot-refreshes the stale account, its
`requestNewAccessTokenThunk` rejects `401`, and that rejection handler clears `accessToken` — clobbering
the token the fresh OAuth flow just set. Option 3 makes that handler **check whether the refresh token
it was operating on is still the current one**, and if a newer `setTokens` has since landed, ignore the
stale failure instead of clobbering. That kills the "two refresh tokens in play" race at its source, for
**every** consumer — not just this hook (e.g. an SPA that reads in-store `accessToken` right after OAuth
would benefit too). Our Fix 1 only makes *this* hook immune; the underlying SDK race still exists.

We deliberately did **not** implement Option 3 here:

- **It lives in the fork, in its most fragile spot.** The change is in `agora-sdk`'s `oauthCore.ts` /
  auth thunks / `authSlice` — exactly the files `agora-sdk/CLAUDE.md` flags as divergence #3, "the
  likely merge-conflict spots if upstream refactors auth." Hand-carrying a new divergence there is the
  highest-cost place to diverge, and the whole reason this feature lives in `agora-sdk-plus` was to
  keep the fork a tiny, documented delta.
- **Highest blast radius.** It's concurrency/ordering logic in shared auth code that *every* flow
  depends on (email/password, SPA, MPA, multi-account). A subtly wrong guard could mask a legitimate
  logout or token clear. Fix 1 touches one isolated hook in a package nothing else depends on.
- **Cadence mismatch.** This package ships independently and the consuming app already adopted it, so
  Fix 1 lands now. A fork change rides the upstream-sync lockstep cadence and a coordinated `agora-sdk`
  release.
- **It isn't Agora-specific.** The race is inherited from upstream Replyke's auth thunks, which makes
  Option 3 a strong **upstream Replyke PR candidate** — the fork's preferred path is to push generic
  fixes upstream and let the sync bring them down, rather than carry a fork divergence.

**Bottom line:** Fix 1 (shipped) makes the package correct today; Option 3 remains worth doing as an
upstream fix and is tracked as a follow-up. The two are complementary — Fix 1 is the belt, Option 3 is
the suspenders the rest of the ecosystem also gets to wear.

## Further reading 📚

- Design spec: [`docs/superpowers/specs/2026-06-27-auth-react-js-oauth-callback-design.md`](superpowers/specs/2026-06-27-auth-react-js-oauth-callback-design.md)
- The original field report: `agora-sdk/docs/AUTH_IMPLEMENTATION.md`
- Package README: [`packages/auth/react-js/README.md`](../packages/auth/react-js/README.md)
