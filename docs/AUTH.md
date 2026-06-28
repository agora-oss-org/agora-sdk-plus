# Auth ergonomics 🔑✨

> **Audience:** anyone wiring Agora SDK auth (especially **OAuth**) into a **web** app — and the folks
> maintaining `@agora-sdk/auth-react-js`.
> **Package:** `@agora-sdk/auth-react-js` (web only).
> **Field report this answers:** [`agora-sdk/docs/AUTH_IMPLEMENTATION.md`](https://github.com/jenova-marie/agora-sdk) (P1/P3/P4/P5/P6/P7).

---

## The one idea 💡

The Agora SDK's email/password auth is already black-box: call the hook, `await`, done. **OAuth
isn't** — in a multi-page app (Astro, Next.js, Remix, SvelteKit) it leaks internal invariants the
integrator has to reverse-engineer, and the classic symptom is *signing in successfully and landing
back on the page logged out*. This package makes OAuth black-box too, by running **inside
`<ReplykeProvider>`** and **observing the SDK's own auth state** rather than racing it. You never
touch `localStorage` keys, count render cycles, or read `useAccountSync`.

> **Scope:** web only. The bug it fixes is specific to **cross-document navigation** (the React tree +
> Redux store are torn down between "tokens received" and "thread mounts"). React Native / Expo OAuth
> uses an in-app browser and doesn't tear the tree down, so there's nothing to fix there.

## Why it was hard 🫠

`handleOAuthCallback()` is **fire-and-forget with deferred persistence**: it stages tokens in Redux,
kicks off an *async* user fetch, and returns `true` **synchronously** — but the session isn't written
to `localStorage` until several render cycles later, gated on a network round-trip. A callback page
that navigates on that synchronous return (the obvious thing!) destroys the React tree *before*
persistence runs, and the freshly minted session is lost. The SPA demo never navigates, so it never
sees this; every MPA does.

## The hooks + component 🧩

```bash
pnpm add @agora-sdk/auth-react-js
# peers you already have: react, react-dom, @agora-sdk/react-js
```

### `useOAuthCallback` — the callback page, done right

Parses the redirect once, waits until the session is **actually persisted**, *then* navigates:

```tsx
import { useOAuthCallback } from "@agora-sdk/auth-react-js";

export default function Callback() {
  const { status, error } = useOAuthCallback({ redirectTo: "/#comments" });
  if (status === "error") return <p>Sign-in failed: {error}</p>;
  return <Spinner />; // on success it full-page-navigates to redirectTo for you
}
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

## How it stays honest 🧼

- **Observes, never races.** Success is gated on the SDK's *own* settled state (`accessToken` +
  `user`) **and** the persisted `localStorage` row — the exact thing the next document reads on boot.
- **One quarantined seam.** The only code that knows the SDK's storage contract
  (`replyke-accounts:<projectId>` key + map shape) lives in a single module, `accountStorage.ts`. If
  upstream changes the contract, one file changes here — not every integrator's callback page.
- **The lone SDK coupling.** This is the one `agora-sdk-plus` feature that depends on the SDK (a
  `@agora-sdk/react-js` **peerDependency**), deliberately: auth is *about* the SDK's session. Secure
  chat and social stay standalone. See [`CLAUDE.md`](../CLAUDE.md) for the scoped-exception note.

## Going deeper 📚

- Design spec: [`docs/superpowers/specs/2026-06-27-auth-react-js-oauth-callback-design.md`](superpowers/specs/2026-06-27-auth-react-js-oauth-callback-design.md)
- The original field report: `agora-sdk/docs/AUTH_IMPLEMENTATION.md`
- Package README: [`packages/auth/react-js/README.md`](../packages/auth/react-js/README.md)
