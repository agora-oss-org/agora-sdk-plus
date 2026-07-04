# `@agora-sdk/auth-react-js` — email-link handlers (verify / reset / resend)

**Status:** Design (approved for planning)
**Date:** 2026-07-04
**Author:** Jenova Marie (with Claude)
**Source report:** field report — `https://agora-oss.org/auth/verify-email?projectId=…&token=…` → **404**
**Related spec:** `2026-06-27-auth-react-js-oauth-callback-design.md` (the OAuth pair this mirrors)

---

## 1. Problem

The Agora server (native auth) emails transactional links that land on **the consuming front-end**,
not on the API. Two are landing pages the app must serve; one is a button action with no page:

| Flow | Emailed link (server builds it) | API endpoint the page must call |
|---|---|---|
| **Verify email** | `{origin}/auth/verify-email?projectId=…&token=…` | `POST /:pid/auth/verify-email { token }` |
| **Reset password** | `{origin}/auth/reset-password?projectId=…&token=…` | `POST /:pid/auth/reset-password { token, newPassword }` |
| **Resend verification** | *(no page — a "didn't get it?" button)* | `POST /:pid/auth/send-verification-email { email }` |

The server side is done (`sender.ts` `confirmLink()` / `resetLink()`, routes in
`agora-server/apps/api/src/routes/auth.ts`). The SDK ships the *transport* for two of the three
(`useVerifyEmail`, `useSendVerificationEmail` in `@agora-sdk/core`, re-exported by
`@agora-sdk/react-js`) — but **no page, no URL parsing, no redirect handling**. So every integrator
must hand-write the `/auth/verify-email` and `/auth/reset-password` pages, and until they do, the
emailed link **404s** — the exact failure observed on `agora-oss.org`.

This is the same problem class the black-box already solved once for the **OAuth callback**
(`useOAuthCallback` + `OAuthCallbackHandler`): a link lands on your app, you parse a token from the
URL, call an SDK primitive, show status, and redirect. We productize the remaining two landing pages
(and the resend action) the same way.

## 2. Goals / non-goals

**Goals**
- A native-auth integrator drops in `<EmailVerificationHandler>` / `<PasswordResetHandler>` and the
  emailed links Just Work — no URL parsing, no direct `axios`, no reverse-engineering.
- Mirror the existing OAuth ergonomics exactly: a **logic hook** + a **drop-in component** per flow.
- Stay **self-contained in this repo** — no new hook required in the `agora-sdk` fork.

**Non-goals**
- **No `agora-sdk` fork changes.** Reset-password lacks a core hook; rather than add one cross-repo,
  the black-box POSTs directly via the SDK's public `getApiBaseUrl()` — the identical pattern
  `@agora-sdk/react-js`'s own `PushTokenAdapter` already uses. Keeps the fork a tiny documented delta.
- **No React Native / Expo.** Like the OAuth handler, these are web landing pages (cross-document
  navigation, `window.location`). RN/Expo deep-link handling is separate, later work.
- **No new server or contract work.** The wire contract is shipped and fixed (§4).
- **Not the post-success destination logic.** Where the app sends the user *after* verify/reset is the
  app's concern; we expose `redirectTo` + status and stop there.

## 3. Architecture

All new code lives in the existing single package `packages/auth/react-js` (web-coupled: `window`,
`fetch`, `history`, `react-js` hooks). Each flow is one **logic hook** (parses URL, drives the API
call, exposes a small state machine) plus one **drop-in component** (default UI over the hook).

### 3.1 New modules

```
src/parseAuthLink.ts        # shared: read {token, projectId} from window.location; fail-closed guard
src/useEmailVerification.ts # hook: URL token → SDK useVerifyEmail → status; optional redirect
src/EmailVerificationHandler.tsx
src/usePasswordReset.ts     # hook: URL token + submit(newPassword) → POST /reset-password → status
src/PasswordResetHandler.tsx      # minimal default new-password form over the hook
src/useResendVerification.ts# hook: resend(email) → SDK useSendVerificationEmail → status
src/ResendVerificationButton.tsx  # small button-with-status over the hook
```

Each ships with a co-located `*.test.ts(x)`.

### 3.2 Shared link parsing + the fail-closed guard (`parseAuthLink.ts`)

Both landing pages read the same query shape. One helper:

```ts
type ParsedAuthLink =
  | { ok: true; token: string }
  | { ok: false; reason: "missing-token" | "project-mismatch" };

function parseAuthLink(providerProjectId: string | undefined, search?: string): ParsedAuthLink;
```

Rules:
- Read `token` and `projectId` from `search` (default `window.location.search`).
- **Fail closed on project mismatch.** If the URL carries a `projectId` and it differs from the
  provider's `projectId`, return `{ ok:false, reason:"project-mismatch" }` and **do not** send the
  token. A token minted for project A must never be replayed against project B's endpoint. (If the URL
  omits `projectId`, we proceed — the provider's id is authoritative; the server scopes by path.)
- Missing/empty `token` → `{ ok:false, reason:"missing-token" }`.
- **Never log the token.** After a successful consume, callers strip `token` from the URL via
  `history.replaceState` (§3.6) so it doesn't linger in the address bar or browser history.

### 3.3 Email verification — `useEmailVerification` + `<EmailVerificationHandler>`

Named `useEmailVerification` (not `useVerifyEmail`) to avoid clashing with the core hook it wraps.

```ts
type EmailVerificationStatus = "pending" | "success" | "error";
type UseEmailVerificationOptions = {
  redirectTo?: string;          // full-page navigate on success; omit to stay & show success UI
  redirectDelayMs?: number;     // default 0
  onError?: (message: string) => void;
};
type UseEmailVerificationReturn = { status: EmailVerificationStatus; error: string | null };
```

Behavior: on mount, parse the link once. On `project-mismatch` / `missing-token` → `status:"error"`
with a clear message (no network call). Otherwise call the SDK's `useVerifyEmail()({ token })`;
success → strip token from URL, `status:"success"`, optional redirect; thrown error →
`status:"error"`, `error` set, `onError` fired. Idempotent via a `useRef` "ran once" guard (React 18
StrictMode double-invoke safe), matching `useOAuthCallback`.

`<EmailVerificationHandler>` props: `{ redirectTo?, onError?, pending?, success?, error? }` — render
slots for each state, with plain sensible defaults ("Verifying…", "Email verified", the error string).

### 3.4 Password reset — `usePasswordReset` + `<PasswordResetHandler>`

Reset has **two steps on one page**: land (parse token) → user types a new password → submit.

```ts
type PasswordResetStatus = "ready" | "submitting" | "success" | "error" | "invalid-link";
type UsePasswordResetOptions = {
  redirectTo?: string;
  minLength?: number;           // default 8 (server enforces 8..128)
  onError?: (message: string) => void;
};
type UsePasswordResetReturn = {
  status: PasswordResetStatus;
  error: string | null;
  submit: (newPassword: string) => Promise<void>;
};
```

`invalid-link` is the mount-time state when the link is bad (missing token / project mismatch) — the
form should not render. Otherwise `ready`. `submit(newPassword)`:
- guards `newPassword.length >= minLength` client-side (mirrors the server's `z.string().min(8)`);
- `status:"submitting"`, then `POST {getApiBaseUrl()}/:pid/auth/reset-password` with
  `{ token, newPassword }` via `fetch` (the `PushTokenAdapter` pattern — public `getApiBaseUrl()`,
  no core internals, no auth header: reset is an unauthenticated recovery flow);
- 2xx → strip token from URL, `status:"success"`, optional redirect; non-2xx / network → `"error"`,
  surface a clean message (map the server's `{ error, code }` body when present).

**Never log or serialize `newPassword` or `token`.**

`<PasswordResetHandler>` ships a **minimal default form**: two `<input type="password">` (new +
confirm), a submit button, inline validation ("passwords don't match", "min N chars"), and
state-driven copy. It stays intentionally unstyled (semantic markup + stable `className`s /
`data-*` hooks for the app's CSS). A `renderForm?: (api) => ReactNode` escape hatch hands the hook's
`{ status, error, submit }` to a fully custom UI when the default doesn't fit.

### 3.5 Resend verification — `useResendVerification` + `<ResendVerificationButton>`

Not a landing page — an action ("Didn't get the email? Resend"). Hook wraps the SDK's
`useSendVerificationEmail`:

```ts
type ResendStatus = "idle" | "sending" | "sent" | "error";
type UseResendVerificationReturn = {
  resend: (email: string) => Promise<void>;
  status: ResendStatus;
  error: string | null;
};
```

`<ResendVerificationButton email={…}>` — a small button that calls `resend`, disables while
`sending`, and shows `sent` / `error` copy. Deliberately tiny (per the "a bit of component" call);
its value is the disable-and-status wiring, not layout.

### 3.6 Token hygiene (all consumed links)

After a successful verify or reset, replace the URL to drop the `token` param:
`history.replaceState(null, "", url.pathname + hashWithoutToken)`. Keeps a single-use recovery/confirm
token out of the address bar, browser history, and any downstream analytics that scrape
`location.href`. Best-effort (guarded for no-`history` environments); never throws into the flow.

## 4. Wire contract (fixed — do not re-derive)

From `agora-server/packages/contract/src/schemas.ts` + `routes/auth.ts`:

- **verify-email** — `POST /:projectId/auth/verify-email`, body `{ token }` (server also accepts
  `tokenHash`; core sends `token`). Optional `type: "signup"|"email"|"recovery"` — we omit it (server
  defaults for the confirmation flow, matching core's `useVerifyEmail`). Success `{ success: true }`.
- **reset-password** — `POST /:projectId/auth/reset-password`, body `{ token, newPassword }`,
  `newPassword` 8..128. Success `{ success: true }`. Errors carry `{ error, code }`.
- **send-verification-email** — `POST /:projectId/auth/send-verification-email`, body
  `{ email, emailRedirectTo? }`. Handled entirely by core's `useSendVerificationEmail`; we don't
  touch the wire for resend.

## 5. Error handling

| Condition | Surface |
|---|---|
| URL missing `token` | `error` state, message "This link is missing its verification token." No network call. |
| URL `projectId` ≠ provider `projectId` | `error` / `invalid-link`, "This link was issued for a different site." Fail closed — no call. |
| Expired / already-used token (server 4xx) | `error` with the server's message when present, else a generic "This link is no longer valid." |
| Reset password too short | client-side inline "Use at least N characters." — no request sent. |
| Network failure | `error`, "Couldn't reach the server. Try again." |

No token or password ever appears in a log line, thrown `Error` message, or `onError` payload.

## 6. Public API additions (`src/index.ts`)

```ts
export { useEmailVerification } from "./useEmailVerification";
export type { EmailVerificationStatus, UseEmailVerificationOptions, UseEmailVerificationReturn } from "./useEmailVerification";
export { EmailVerificationHandler } from "./EmailVerificationHandler";
export type { EmailVerificationHandlerProps } from "./EmailVerificationHandler";

export { usePasswordReset } from "./usePasswordReset";
export type { PasswordResetStatus, UsePasswordResetOptions, UsePasswordResetReturn } from "./usePasswordReset";
export { PasswordResetHandler } from "./PasswordResetHandler";
export type { PasswordResetHandlerProps } from "./PasswordResetHandler";

export { useResendVerification } from "./useResendVerification";
export type { ResendStatus, UseResendVerificationReturn } from "./useResendVerification";
export { ResendVerificationButton } from "./ResendVerificationButton";
export type { ResendVerificationButtonProps } from "./ResendVerificationButton";
```

## 7. Testing (vitest + jsdom, mirroring existing `*.test.tsx`)

Mock `@agora-sdk/react-js` (`useVerifyEmail`, `useSendVerificationEmail`, `useProject`,
`getApiBaseUrl`) and global `fetch`. Cases:
- verify: happy path (calls SDK with URL `token`, `status:"success"`, redirect fired, token stripped);
  missing-token; **project-mismatch fail-closed (no SDK call)**; SDK-thrown error → `error` + `onError`.
- reset: `invalid-link` on bad link (form not rendered); short-password guard (no fetch); happy submit
  POSTs `{ token, newPassword }` to the right URL, success + redirect + token stripped; server 4xx maps
  `{ error, code }`; **assert the request body never contains the password in any log spy**.
- resend: idle→sending→sent; error path; disabled while sending.
- `parseAuthLink`: token present/absent, projectId match/mismatch/absent.

## 8. Docs

- `README.md` — add a "Email links" section: the two drop-in pages + the resend button, ~3 lines each.
- `AUTH.md` — full guide entries mirroring the OAuth section (props, states, the fail-closed guard,
  token-hygiene note, the "reset uses `getApiBaseUrl` not a core hook, and why" rationale).
- TSDoc on every new export (block comments, `@param`/`@returns`/`@throws`/`@example`).
- `CHANGELOG.md` — `Added` bullet under `## [Unreleased]`.

## 9. Rollout

Ship in `@agora-sdk/auth-react-js` (next minor). Integrator adds two routes:

```tsx
// /auth/verify-email
<EmailVerificationHandler redirectTo="/?verified=1" />
// /auth/reset-password
<PasswordResetHandler redirectTo="/signin?reset=1" />
```

Non-breaking; purely additive. No server/contract/fork changes.
