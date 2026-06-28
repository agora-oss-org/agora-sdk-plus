# @agora-sdk/auth-react-js

Black-box OAuth callback handling + auth ergonomics for **Agora SDK** (a Replyke fork) **web** apps.
It runs *inside* `<ReplykeProvider>` and observes the SDK's own auth state — you never touch
`localStorage` keys, count render cycles, or read `useAccountSync`.

## Why

The SDK's `handleOAuthCallback()` stages tokens in Redux and starts an async user fetch, but the
session isn't written to `localStorage` until several render cycles later. In a multi-page app (Astro,
Next.js, Remix, SvelteKit), navigating away on its synchronous return tears down the React tree
*before* persistence runs — and the freshly minted session is lost. This package gates navigation on
**actual persistence**.

## Install

```bash
pnpm add @agora-sdk/auth-react-js
# peers (you already have these): react, react-dom, @agora-sdk/react-js
```

## OAuth callback page (the thing everyone tries to write — now correct)

```tsx
import { useOAuthCallback } from "@agora-sdk/auth-react-js";

export default function Callback() {
  const { status, error } = useOAuthCallback({ redirectTo: "/#comments" });
  if (status === "error") return <p>Sign-in failed: {error}</p>;
  return <Spinner />; // success full-page-navigates to redirectTo
}
```

It gates navigation on a fresh session actually landing in `localStorage` (the state the next document
boots from), not on volatile in-store auth — so it stays correct even when a leftover stale account's
boot-refresh fails `401` mid-flow. Single-session apps can pass `pruneStaleOnMount: true` to clear any
pre-existing account first and silence that cosmetic `401`.

Or the drop-in component:

```tsx
import { OAuthCallbackHandler } from "@agora-sdk/auth-react-js";

<OAuthCallbackHandler redirectTo="/" onError={(m) => toast(m)} pending={<Spinner />} />
```

## Auth-ready status

```tsx
import { useAuthStatus } from "@agora-sdk/auth-react-js";
const { status } = useAuthStatus(); // 'initializing' | 'authenticated' | 'unauthenticated'
```

## Reliable logout

```tsx
import { useSignOutEverywhere } from "@agora-sdk/auth-react-js";
const { signOutEverywhere, isPending } = useSignOutEverywhere();
<button disabled={isPending} onClick={() => void signOutEverywhere().catch(() => {})}>Sign out</button>
```

> Prefer this over the SDK's `useAuth().signOut()`, which is active-account-only (it switches accounts
> rather than ending the session).

## Self-heal a stale-only session

```tsx
import { useAuthSelfHeal } from "@agora-sdk/auth-react-js";
function App() { useAuthSelfHeal(); return <Thread />; } // prunes a dead active account once
```

## Scope

Web only. The callback race is specific to cross-document navigation; React Native / Expo OAuth does
not tear down the tree.
