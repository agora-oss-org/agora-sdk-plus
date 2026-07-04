# Auth Email-Link Handlers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add drop-in verify-email, reset-password, and resend-verification handlers to `@agora-sdk/auth-react-js` so the server's emailed auth links stop 404-ing on consumer apps.

**Architecture:** Mirror the existing OAuth black-box (`useOAuthCallback` + `OAuthCallbackHandler`): one logic hook + one component per flow, over a shared `parseAuthLink` helper that fails closed on projectId mismatch. Verify wraps core's `useVerifyEmail`; reset and resend POST directly via the SDK's public `getApiBaseUrl()` (the `PushTokenAdapter` pattern — no `agora-sdk` fork changes).

**Tech Stack:** TypeScript, React 18/19, `@agora-sdk/react-js` (peer), vitest + jsdom + `@testing-library/react`.

## Global Constraints

- All new code lives in `packages/auth/react-js/src/`. Web-only.
- TSDoc block comment (`/** … */`) on **every exported** symbol — real description, `@param`/`@returns`/`@throws`/`@example` on functions/hooks/components. `pnpm run typecheck` stays green.
- Lead each new source file with a header comment stating its purpose in the black-box model.
- **Security:** never log, throw-into, or serialize the `token` or any password. Fail closed on projectId mismatch (no network call). Strip `token` from the URL after a successful consume.
- Components return `JSX.Element`; import `ReactNode` as `import type { ReactNode } from "react"`.
- Tests: co-located `*.test.ts(x)`, first line `// @vitest-environment jsdom`. Mock `@agora-sdk/react-js` at the boundary. Run with `pnpm --filter @agora-sdk/auth-react-js test` (or `pnpm test <substring>` at root).
- Wire contract is fixed: verify `POST /:pid/auth/verify-email {token}`; reset `POST /:pid/auth/reset-password {token,newPassword}` (newPassword 8..128); resend `POST /:pid/auth/send-verification-email {email, emailRedirectTo?}` (email required).
- CHANGELOG bullet under `## [Unreleased]` in the same change.

---

### Task 1: Shared link parsing (`parseAuthLink` + `stripTokenFromUrl`)

**Files:**
- Create: `packages/auth/react-js/src/parseAuthLink.ts`
- Test: `packages/auth/react-js/src/parseAuthLink.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ParsedAuthLink = { ok: true; token: string } | { ok: false; reason: "missing-token" | "project-mismatch" }`
  - `function parseAuthLink(providerProjectId: string | undefined, search?: string): ParsedAuthLink`
  - `function stripTokenFromUrl(): void`

- [ ] **Step 1: Write the failing test**

`packages/auth/react-js/src/parseAuthLink.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { parseAuthLink, stripTokenFromUrl } from "./parseAuthLink";

describe("parseAuthLink", () => {
  it("returns the token when projectId matches", () => {
    expect(parseAuthLink("p1", "?projectId=p1&token=abc")).toEqual({ ok: true, token: "abc" });
  });
  it("trims the token", () => {
    expect(parseAuthLink("p1", "?token=%20abc%20")).toEqual({ ok: true, token: "abc" });
  });
  it("proceeds when the link omits projectId (provider is authoritative)", () => {
    expect(parseAuthLink("p1", "?token=abc")).toEqual({ ok: true, token: "abc" });
  });
  it("fails closed when the link projectId differs from the provider's", () => {
    expect(parseAuthLink("p1", "?projectId=p2&token=abc")).toEqual({ ok: false, reason: "project-mismatch" });
  });
  it("reports a missing token", () => {
    expect(parseAuthLink("p1", "?projectId=p1")).toEqual({ ok: false, reason: "missing-token" });
  });
});

describe("stripTokenFromUrl", () => {
  afterEach(() => window.history.replaceState(null, "", "/"));
  it("removes only the token param, keeping other query + path", () => {
    window.history.replaceState(null, "", "/auth/verify-email?projectId=p1&token=secret&x=1");
    stripTokenFromUrl();
    expect(window.location.search).toBe("?projectId=p1&x=1");
    expect(window.location.pathname).toBe("/auth/verify-email");
  });
  it("is a no-op when there is no token", () => {
    window.history.replaceState(null, "", "/auth/verify-email?projectId=p1");
    expect(() => stripTokenFromUrl()).not.toThrow();
    expect(window.location.search).toBe("?projectId=p1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agora-sdk/auth-react-js test parseAuthLink`
Expected: FAIL — cannot find module `./parseAuthLink`.

- [ ] **Step 3: Write minimal implementation**

`packages/auth/react-js/src/parseAuthLink.ts`:

```ts
// Shared parsing for the emailed auth landing pages (verify-email, reset-password). Both links arrive
// as {origin}/auth/<flow>?projectId=<pid>&token=<t>. This reads the token and FAILS CLOSED when the
// link's projectId disagrees with the provider's — a token minted for another project must never be
// replayed against this one. The token is single-use recovery/confirmation material: it is never
// logged, and stripTokenFromUrl() removes it from the address bar after a successful consume.

/** Outcome of parsing an emailed auth link's query string. */
export type ParsedAuthLink =
  | { ok: true; token: string }
  | { ok: false; reason: "missing-token" | "project-mismatch" };

/**
 * Parse the `token`/`projectId` query of an emailed auth link, failing closed on a projectId mismatch.
 *
 * @param providerProjectId - the projectId from the SDK's `useProject()`; the authority for this app.
 * @param search - the query string to parse. Defaults to `window.location.search`.
 * @returns {@link ParsedAuthLink} — `ok:true` with the token, or `ok:false` with the reason.
 * @example
 * const link = parseAuthLink(projectId);
 * if (!link.ok) return showError(link.reason);
 * await verifyEmail({ token: link.token });
 */
export function parseAuthLink(
  providerProjectId: string | undefined,
  search: string = typeof window !== "undefined" ? window.location.search : ""
): ParsedAuthLink {
  const params = new URLSearchParams(search);
  const token = params.get("token")?.trim();
  const linkProjectId = params.get("projectId")?.trim();
  // A link naming a different project than this app is configured for is not ours to consume — never
  // send its token. A link that omits projectId defers to the provider's id (the server scopes by path).
  if (linkProjectId && providerProjectId && linkProjectId !== providerProjectId) {
    return { ok: false, reason: "project-mismatch" };
  }
  if (!token) {
    return { ok: false, reason: "missing-token" };
  }
  return { ok: true, token };
}

/**
 * Remove the `token` query param from the current URL via `history.replaceState`, so a single-use
 * confirmation/recovery token doesn't linger in the address bar or browser history. Best-effort and
 * never throws — guarded for environments without `window.history`.
 */
export function stripTokenFromUrl(): void {
  if (typeof window === "undefined" || !window.history?.replaceState) return;
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("token")) return;
    url.searchParams.delete("token");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  } catch {
    // URL hygiene is best-effort and must never break the flow.
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agora-sdk/auth-react-js test parseAuthLink`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/auth/react-js/src/parseAuthLink.ts packages/auth/react-js/src/parseAuthLink.test.ts
git commit -m "feat(auth): shared parseAuthLink + stripTokenFromUrl (fail-closed on projectId mismatch)"
```

---

### Task 2: Email verification (`useEmailVerification` + `<EmailVerificationHandler>`)

**Files:**
- Create: `packages/auth/react-js/src/useEmailVerification.ts`
- Create: `packages/auth/react-js/src/EmailVerificationHandler.tsx`
- Test: `packages/auth/react-js/src/useEmailVerification.test.tsx`

**Interfaces:**
- Consumes: `parseAuthLink`, `stripTokenFromUrl` (Task 1); `useProject`, `useVerifyEmail` from `@agora-sdk/react-js` (`useVerifyEmail()` returns `(props: { token: string }) => Promise<{ success: boolean }>`).
- Produces:
  - `type EmailVerificationStatus = "pending" | "success" | "error"`
  - `type UseEmailVerificationOptions = { redirectTo?: string; redirectDelayMs?: number; onError?: (message: string) => void }`
  - `type UseEmailVerificationReturn = { status: EmailVerificationStatus; error: string | null }`
  - `function useEmailVerification(options?: UseEmailVerificationOptions): UseEmailVerificationReturn`
  - `type EmailVerificationHandlerProps` + `function EmailVerificationHandler(props): JSX.Element`

- [ ] **Step 1: Write the failing test**

`packages/auth/react-js/src/useEmailVerification.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

vi.mock("@agora-sdk/react-js", () => ({
  useProject: vi.fn(),
  useVerifyEmail: vi.fn(),
}));

import { useProject, useVerifyEmail } from "@agora-sdk/react-js";
import { useEmailVerification } from "./useEmailVerification";

const mockProject = useProject as unknown as ReturnType<typeof vi.fn>;
const mockUseVerify = useVerifyEmail as unknown as ReturnType<typeof vi.fn>;
let verify: ReturnType<typeof vi.fn>;
let replace: ReturnType<typeof vi.fn>;

function setUrl(search: string) {
  replace = vi.fn();
  Object.defineProperty(window, "location", {
    value: { search, href: `https://app.test/auth/verify-email${search}`, pathname: "/auth/verify-email", replace },
    writable: true,
  });
}

beforeEach(() => {
  verify = vi.fn().mockResolvedValue({ success: true });
  mockUseVerify.mockReturnValue(verify);
  mockProject.mockReturnValue({ projectId: "p1" });
  setUrl("?projectId=p1&token=tok123");
  vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
});
afterEach(() => vi.clearAllMocks());

describe("useEmailVerification", () => {
  it("calls verifyEmail with the URL token and reaches success", async () => {
    const { result } = renderHook(() => useEmailVerification());
    await waitFor(() => expect(result.current.status).toBe("success"));
    expect(verify).toHaveBeenCalledWith({ token: "tok123" });
  });

  it("redirects on success when redirectTo is set", async () => {
    const { result } = renderHook(() => useEmailVerification({ redirectTo: "/done" }));
    await waitFor(() => expect(result.current.status).toBe("success"));
    expect(replace).toHaveBeenCalledWith("/done");
  });

  it("fails closed on projectId mismatch without calling the SDK", async () => {
    setUrl("?projectId=OTHER&token=tok123");
    const onError = vi.fn();
    const { result } = renderHook(() => useEmailVerification({ onError }));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(verify).not.toHaveBeenCalled();
    expect(result.current.error).toMatch(/different site/i);
    expect(onError).toHaveBeenCalled();
  });

  it("surfaces a server error and never leaks the token", async () => {
    verify.mockRejectedValue(new Error("Token expired"));
    const { result } = renderHook(() => useEmailVerification());
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toBe("Token expired");
    expect(result.current.error).not.toContain("tok123");
  });

  it("errors on a missing token", async () => {
    setUrl("?projectId=p1");
    const { result } = renderHook(() => useEmailVerification());
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(verify).not.toHaveBeenCalled();
    expect(result.current.error).toMatch(/missing/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agora-sdk/auth-react-js test useEmailVerification`
Expected: FAIL — cannot find module `./useEmailVerification`.

- [ ] **Step 3: Write minimal implementation (hook)**

`packages/auth/react-js/src/useEmailVerification.ts`:

```ts
// Drop-in engine for the emailed /auth/verify-email landing page. Reads the token from the URL, fails
// closed if the link was minted for another project, calls the SDK's useVerifyEmail, then strips the
// token from the URL and (optionally) redirects. Mirrors useOAuthCallback's one-shot, ref-guarded shape.
import { useEffect, useRef, useState } from "react";
import { useProject, useVerifyEmail } from "@agora-sdk/react-js";
import { parseAuthLink, stripTokenFromUrl } from "./parseAuthLink";

/** Lifecycle of the verify-email page. */
export type EmailVerificationStatus = "pending" | "success" | "error";

/** Options for {@link useEmailVerification}. */
export type UseEmailVerificationOptions = {
  /** Full-page navigate here on success. Omit to stay on the page and show a success state. */
  redirectTo?: string;
  /** Delay (ms) before the success redirect. Default 0. */
  redirectDelayMs?: number;
  /** Called with a user-facing message on any failure (bad link or server rejection). */
  onError?: (message: string) => void;
};

/** Return value of {@link useEmailVerification}. */
export type UseEmailVerificationReturn = {
  /** `pending` while verifying; `success` once verified; `error` on a bad link or server rejection. */
  status: EmailVerificationStatus;
  /** User-facing error message when `status === "error"`. Never contains the token. */
  error: string | null;
};

const LINK_ERROR: Record<"missing-token" | "project-mismatch", string> = {
  "missing-token": "This link is missing its verification token.",
  "project-mismatch": "This link was issued for a different site.",
};

/**
 * Drive the emailed email-verification landing page: parse the token once, verify it via the SDK, then
 * strip the token from the URL and optionally redirect. Fails closed when the link's projectId differs
 * from the provider's (no network call).
 *
 * @param options - {@link UseEmailVerificationOptions}
 * @returns the {@link EmailVerificationStatus} and any user-facing error.
 * @example
 * function VerifyEmailPage() {
 *   const { status, error } = useEmailVerification({ redirectTo: "/?verified=1" });
 *   if (status === "error") return <p>{error}</p>;
 *   return <Spinner />;
 * }
 */
export function useEmailVerification(
  options: UseEmailVerificationOptions = {}
): UseEmailVerificationReturn {
  const { redirectTo, redirectDelayMs = 0, onError } = options;
  const { projectId } = useProject();
  const verifyEmail = useVerifyEmail();

  const [status, setStatus] = useState<EmailVerificationStatus>("pending");
  const [error, setError] = useState<string | null>(null);
  const ranRef = useRef(false);

  useEffect(() => {
    // Wait for the provider's projectId — the fail-closed guard needs it. Run exactly once (StrictMode).
    if (ranRef.current || !projectId) return;
    ranRef.current = true;

    const fail = (message: string) => {
      setError(message);
      setStatus("error");
      onError?.(message);
    };

    const link = parseAuthLink(projectId);
    if (!link.ok) {
      fail(LINK_ERROR[link.reason]);
      return;
    }

    verifyEmail({ token: link.token })
      .then(() => {
        stripTokenFromUrl();
        setStatus("success");
        if (redirectTo) {
          window.setTimeout(() => window.location.replace(redirectTo), redirectDelayMs);
        }
      })
      .catch((e: unknown) => {
        // Surface only the server/user-facing message — never the token.
        fail(e instanceof Error && e.message ? e.message : "This link is no longer valid.");
      });
  }, [projectId, verifyEmail, redirectTo, redirectDelayMs, onError]);

  return { status, error };
}
```

- [ ] **Step 4: Run hook test to verify it passes**

Run: `pnpm --filter @agora-sdk/auth-react-js test useEmailVerification`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the component**

`packages/auth/react-js/src/EmailVerificationHandler.tsx`:

```tsx
// Copy-paste drop-in for the /auth/verify-email route, over the useEmailVerification engine. Renders
// pending/success/error slots (with plain defaults) and fires onSuccess/onError.
import { useEffect } from "react";
import type { ReactNode } from "react";
import { useEmailVerification } from "./useEmailVerification";

/** Props for {@link EmailVerificationHandler}. */
export type EmailVerificationHandlerProps = {
  /** Full-page navigate here on success. Omit to render the `success` slot instead. */
  redirectTo?: string;
  /** Delay (ms) before the success redirect. Default 0. */
  redirectDelayMs?: number;
  /** Fired once verification succeeds. */
  onSuccess?: () => void;
  /** Fired with a user-facing message on failure. */
  onError?: (message: string) => void;
  /** Rendered while verifying. Defaults to "Verifying your email…". */
  pending?: ReactNode;
  /** Rendered on success (when not redirecting). Defaults to "Your email is verified." */
  success?: ReactNode;
  /** Rendered on error. Defaults to the message in a `<p>`. */
  error?: (message: string | null) => ReactNode;
};

/**
 * Drop-in email-verification page. Drives {@link useEmailVerification} and renders the three states.
 *
 * @param props - {@link EmailVerificationHandlerProps}
 * @example
 * // app route: /auth/verify-email
 * <EmailVerificationHandler redirectTo="/?verified=1" onError={(m) => toast(m)} />
 */
export function EmailVerificationHandler(props: EmailVerificationHandlerProps): JSX.Element {
  const { redirectTo, redirectDelayMs, onSuccess, onError, pending, success, error } = props;
  const { status, error: message } = useEmailVerification({ redirectTo, redirectDelayMs, onError });

  useEffect(() => {
    if (status === "success") onSuccess?.();
  }, [status, onSuccess]);

  if (status === "error") return <>{error ? error(message) : <p role="alert">{message}</p>}</>;
  if (status === "success") return <>{success ?? <p>Your email is verified.</p>}</>;
  return <>{pending ?? <p>Verifying your email…</p>}</>;
}
```

- [ ] **Step 6: Append a component test to the same file**

Add to `useEmailVerification.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { EmailVerificationHandler } from "./EmailVerificationHandler";

describe("EmailVerificationHandler", () => {
  it("renders the default success copy and fires onSuccess", async () => {
    const onSuccess = vi.fn();
    render(<EmailVerificationHandler onSuccess={onSuccess} />);
    await screen.findByText(/your email is verified/i);
    expect(onSuccess).toHaveBeenCalled();
  });

  it("renders the error slot on a bad link", async () => {
    setUrl("?projectId=OTHER&token=tok123");
    render(<EmailVerificationHandler />);
    await screen.findByText(/different site/i);
  });
});
```

- [ ] **Step 7: Run the full file and typecheck**

Run: `pnpm --filter @agora-sdk/auth-react-js test useEmailVerification`
Expected: PASS (7 tests).
Run: `pnpm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/auth/react-js/src/useEmailVerification.ts packages/auth/react-js/src/EmailVerificationHandler.tsx packages/auth/react-js/src/useEmailVerification.test.tsx
git commit -m "feat(auth): useEmailVerification hook + EmailVerificationHandler drop-in"
```

---

### Task 3: Password reset (`usePasswordReset` + `<PasswordResetHandler>`)

**Files:**
- Create: `packages/auth/react-js/src/usePasswordReset.ts`
- Create: `packages/auth/react-js/src/PasswordResetHandler.tsx`
- Test: `packages/auth/react-js/src/usePasswordReset.test.tsx`

**Interfaces:**
- Consumes: `parseAuthLink`, `stripTokenFromUrl` (Task 1); `useProject`, `getApiBaseUrl` from `@agora-sdk/react-js` (`getApiBaseUrl()` returns the API base, e.g. `https://api.example/v7`); global `fetch`.
- Produces:
  - `type PasswordResetStatus = "ready" | "submitting" | "success" | "error" | "invalid-link"`
  - `type UsePasswordResetOptions = { redirectTo?: string; redirectDelayMs?: number; minLength?: number; onError?: (message: string) => void }`
  - `type UsePasswordResetReturn = { status: PasswordResetStatus; error: string | null; submit: (newPassword: string) => Promise<void> }`
  - `function usePasswordReset(options?: UsePasswordResetOptions): UsePasswordResetReturn`
  - `type PasswordResetHandlerProps` + `function PasswordResetHandler(props): JSX.Element`

- [ ] **Step 1: Write the failing test**

`packages/auth/react-js/src/usePasswordReset.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

vi.mock("@agora-sdk/react-js", () => ({
  useProject: vi.fn(),
  getApiBaseUrl: vi.fn(() => "https://api.test/v7"),
}));

import { useProject } from "@agora-sdk/react-js";
import { usePasswordReset } from "./usePasswordReset";

const mockProject = useProject as unknown as ReturnType<typeof vi.fn>;
let replace: ReturnType<typeof vi.fn>;

function setUrl(search: string) {
  replace = vi.fn();
  Object.defineProperty(window, "location", {
    value: { search, href: `https://app.test/auth/reset-password${search}`, pathname: "/auth/reset-password", replace },
    writable: true,
  });
}

beforeEach(() => {
  mockProject.mockReturnValue({ projectId: "p1" });
  setUrl("?projectId=p1&token=rtok");
  vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) }) as unknown as typeof fetch;
});
afterEach(() => vi.clearAllMocks());

describe("usePasswordReset", () => {
  it("starts ready on a valid link", () => {
    const { result } = renderHook(() => usePasswordReset());
    expect(result.current.status).toBe("ready");
  });

  it("is invalid-link on projectId mismatch", () => {
    setUrl("?projectId=OTHER&token=rtok");
    const { result } = renderHook(() => usePasswordReset());
    expect(result.current.status).toBe("invalid-link");
    expect(result.current.error).toMatch(/different site/i);
  });

  it("rejects a too-short password before any request", async () => {
    const { result } = renderHook(() => usePasswordReset({ minLength: 8 }));
    await act(async () => { await result.current.submit("short"); });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.current.status).toBe("error");
    expect(result.current.error).toMatch(/at least 8/i);
  });

  it("POSTs { token, newPassword } and succeeds (never logging the password)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { result } = renderHook(() => usePasswordReset({ redirectTo: "/signin" }));
    await act(async () => { await result.current.submit("a-good-password"); });
    await waitFor(() => expect(result.current.status).toBe("success"));
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.test/v7/p1/auth/reset-password");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ token: "rtok", newPassword: "a-good-password" });
    expect(replace).toHaveBeenCalledWith("/signin");
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain("a-good-password");
    logSpy.mockRestore();
  });

  it("maps a server 4xx error body", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "Reset link expired", code: "auth/expired" }) }) as unknown as typeof fetch;
    const { result } = renderHook(() => usePasswordReset());
    await act(async () => { await result.current.submit("a-good-password"); });
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("Reset link expired");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agora-sdk/auth-react-js test usePasswordReset`
Expected: FAIL — cannot find module `./usePasswordReset`.

- [ ] **Step 3: Write the hook**

`packages/auth/react-js/src/usePasswordReset.ts`:

```ts
// Drop-in engine for the emailed /auth/reset-password landing page. Parses the token from the URL
// (fail-closed on projectId mismatch), then submit(newPassword) POSTs { token, newPassword } to the
// blind server's reset endpoint. We POST directly via the SDK's public getApiBaseUrl() — the same
// pattern react-js's PushTokenAdapter uses — because core has no reset-password hook. The endpoint is
// intentionally unauthenticated (a recovery flow). The token and password are never logged.
import { useEffect, useRef, useState } from "react";
import { useProject, getApiBaseUrl } from "@agora-sdk/react-js";
import { parseAuthLink, stripTokenFromUrl } from "./parseAuthLink";

/** Lifecycle of the reset-password page. `invalid-link` means the landing link was bad; hide the form. */
export type PasswordResetStatus = "ready" | "submitting" | "success" | "error" | "invalid-link";

/** Options for {@link usePasswordReset}. */
export type UsePasswordResetOptions = {
  /** Full-page navigate here on success (e.g. your sign-in page). */
  redirectTo?: string;
  /** Delay (ms) before the success redirect. Default 0. */
  redirectDelayMs?: number;
  /** Minimum new-password length enforced client-side. Default 8 (the server enforces 8..128). */
  minLength?: number;
  /** Called with a user-facing message on failure. */
  onError?: (message: string) => void;
};

/** Return value of {@link usePasswordReset}. */
export type UsePasswordResetReturn = {
  /** Current {@link PasswordResetStatus}. */
  status: PasswordResetStatus;
  /** User-facing error, or null. Never contains the token or password. */
  error: string | null;
  /** Submit a new password for the token in the URL. No-op if the link was invalid. */
  submit: (newPassword: string) => Promise<void>;
};

/**
 * Drive the emailed password-reset landing page: parse the token once (fail-closed on projectId
 * mismatch → `invalid-link`), then `submit(newPassword)` to set the new password and optionally redirect.
 *
 * @param options - {@link UsePasswordResetOptions}
 * @returns {@link UsePasswordResetReturn} — status, error, and the `submit` action.
 * @example
 * const { status, error, submit } = usePasswordReset({ redirectTo: "/signin" });
 * if (status === "invalid-link") return <p>{error}</p>;
 * // render your own form and call submit(password)
 */
export function usePasswordReset(options: UsePasswordResetOptions = {}): UsePasswordResetReturn {
  const { redirectTo, redirectDelayMs = 0, minLength = 8, onError } = options;
  const { projectId } = useProject();

  const [status, setStatus] = useState<PasswordResetStatus>("ready");
  const [error, setError] = useState<string | null>(null);
  const tokenRef = useRef<string | null>(null);
  const parsedRef = useRef(false);

  useEffect(() => {
    if (parsedRef.current || !projectId) return;
    parsedRef.current = true;
    const link = parseAuthLink(projectId);
    if (!link.ok) {
      setError(
        link.reason === "project-mismatch"
          ? "This link was issued for a different site."
          : "This link is missing its reset token."
      );
      setStatus("invalid-link");
      return;
    }
    tokenRef.current = link.token;
  }, [projectId]);

  const submit = async (newPassword: string): Promise<void> => {
    const token = tokenRef.current;
    if (!token || !projectId) {
      setStatus("invalid-link");
      return;
    }
    if (newPassword.length < minLength) {
      const m = `Use at least ${minLength} characters.`;
      setError(m);
      setStatus("error");
      onError?.(m);
      return;
    }
    setStatus("submitting");
    setError(null);
    try {
      const res = await fetch(`${getApiBaseUrl()}/${projectId}/auth/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const m =
          body && typeof body.error === "string" && body.error
            ? body.error
            : "This reset link is no longer valid.";
        setError(m);
        setStatus("error");
        onError?.(m);
        return;
      }
      stripTokenFromUrl();
      setStatus("success");
      if (redirectTo) {
        window.setTimeout(() => window.location.replace(redirectTo), redirectDelayMs);
      }
    } catch {
      const m = "Couldn't reach the server. Please try again.";
      setError(m);
      setStatus("error");
      onError?.(m);
    }
  };

  return { status, error, submit };
}
```

- [ ] **Step 4: Run hook test to verify it passes**

Run: `pnpm --filter @agora-sdk/auth-react-js test usePasswordReset`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the component (minimal default form)**

`packages/auth/react-js/src/PasswordResetHandler.tsx`:

```tsx
// Copy-paste drop-in for the /auth/reset-password route, over the usePasswordReset engine. Ships a
// minimal, unstyled new-password form (new + confirm, client-side match/length checks) with stable
// classNames for the app's CSS, plus a renderForm escape hatch for a fully custom UI.
import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { usePasswordReset } from "./usePasswordReset";
import type { UsePasswordResetReturn } from "./usePasswordReset";

/** Props for {@link PasswordResetHandler}. */
export type PasswordResetHandlerProps = {
  /** Full-page navigate here on success. */
  redirectTo?: string;
  /** Delay (ms) before the success redirect. Default 0. */
  redirectDelayMs?: number;
  /** Minimum password length. Default 8. */
  minLength?: number;
  /** Fired once the reset succeeds. */
  onSuccess?: () => void;
  /** Fired with a user-facing message on failure. */
  onError?: (message: string) => void;
  /** Rendered on success. Defaults to "Your password has been reset." */
  success?: ReactNode;
  /** Rendered when the landing link is invalid. Defaults to the message in a `<p>`. */
  invalidLink?: (message: string | null) => ReactNode;
  /** Replace the default form entirely; receives the hook's `{ status, error, submit }`. */
  renderForm?: (api: UsePasswordResetReturn) => ReactNode;
};

/**
 * Drop-in password-reset page with a minimal default form.
 *
 * @param props - {@link PasswordResetHandlerProps}
 * @example
 * // app route: /auth/reset-password
 * <PasswordResetHandler redirectTo="/signin?reset=1" />
 */
export function PasswordResetHandler(props: PasswordResetHandlerProps): JSX.Element {
  const { redirectTo, redirectDelayMs, minLength = 8, onSuccess, onError, success, invalidLink, renderForm } = props;
  const api = usePasswordReset({ redirectTo, redirectDelayMs, minLength, onError });
  const { status, error, submit } = api;

  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (status === "success") onSuccess?.();
  }, [status, onSuccess]);

  if (status === "success") return <>{success ?? <p>Your password has been reset.</p>}</>;
  if (status === "invalid-link") return <>{invalidLink ? invalidLink(error) : <p role="alert">{error}</p>}</>;
  if (renderForm) return <>{renderForm(api)}</>;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    if (pw !== confirm) {
      setLocalError("Passwords don't match.");
      return;
    }
    if (pw.length < minLength) {
      setLocalError(`Use at least ${minLength} characters.`);
      return;
    }
    void submit(pw);
  };

  return (
    <form className="agora-password-reset" onSubmit={onSubmit}>
      <label className="agora-password-reset-field">
        New password
        <input
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          autoComplete="new-password"
          minLength={minLength}
          required
        />
      </label>
      <label className="agora-password-reset-field">
        Confirm password
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          required
        />
      </label>
      {(localError ?? error) && (
        <p className="agora-password-reset-error" role="alert">
          {localError ?? error}
        </p>
      )}
      <button type="submit" disabled={status === "submitting"}>
        {status === "submitting" ? "Resetting…" : "Reset password"}
      </button>
    </form>
  );
}
```

- [ ] **Step 6: Append component tests to the same file**

Add to `usePasswordReset.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { PasswordResetHandler } from "./PasswordResetHandler";

describe("PasswordResetHandler", () => {
  it("shows a mismatch error without submitting", () => {
    render(<PasswordResetHandler />);
    fireEvent.change(screen.getByLabelText(/new password/i), { target: { value: "a-good-password" } });
    fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: "different" } });
    fireEvent.click(screen.getByRole("button", { name: /reset password/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/don't match/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("submits matching passwords and shows success", async () => {
    render(<PasswordResetHandler />);
    fireEvent.change(screen.getByLabelText(/new password/i), { target: { value: "a-good-password" } });
    fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: "a-good-password" } });
    fireEvent.click(screen.getByRole("button", { name: /reset password/i }));
    await screen.findByText(/your password has been reset/i);
  });

  it("renders the invalid-link slot on a bad landing link", () => {
    setUrl("?projectId=OTHER&token=rtok");
    render(<PasswordResetHandler />);
    expect(screen.getByRole("alert")).toHaveTextContent(/different site/i);
  });
});
```

> Note: `toHaveTextContent` needs `@testing-library/jest-dom`. If it isn't already set up in this
> package's tests, assert with `screen.getByText(/don't match/i)` / `screen.getByText(/different site/i)`
> instead — no extra dependency.

- [ ] **Step 7: Run the full file and typecheck**

Run: `pnpm --filter @agora-sdk/auth-react-js test usePasswordReset`
Expected: PASS (8 tests).
Run: `pnpm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/auth/react-js/src/usePasswordReset.ts packages/auth/react-js/src/PasswordResetHandler.tsx packages/auth/react-js/src/usePasswordReset.test.tsx
git commit -m "feat(auth): usePasswordReset hook + PasswordResetHandler drop-in form"
```

---

### Task 4: Resend verification (`useResendVerification` + `<ResendVerificationButton>`)

**Files:**
- Create: `packages/auth/react-js/src/useResendVerification.ts`
- Create: `packages/auth/react-js/src/ResendVerificationButton.tsx`
- Test: `packages/auth/react-js/src/useResendVerification.test.tsx`

**Interfaces:**
- Consumes: `useProject`, `getApiBaseUrl` from `@agora-sdk/react-js`; global `fetch`. (Does **not** use core's `useSendVerificationEmail` — it omits the `email` the server requires; see plan header + spec §1.)
- Produces:
  - `type ResendStatus = "idle" | "sending" | "sent" | "error"`
  - `type UseResendVerificationReturn = { resend: (email: string) => Promise<void>; status: ResendStatus; error: string | null }`
  - `function useResendVerification(): UseResendVerificationReturn`
  - `type ResendVerificationButtonProps` + `function ResendVerificationButton(props): JSX.Element`

- [ ] **Step 1: Write the failing test**

`packages/auth/react-js/src/useResendVerification.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

vi.mock("@agora-sdk/react-js", () => ({
  useProject: vi.fn(),
  getApiBaseUrl: vi.fn(() => "https://api.test/v7"),
}));

import { useProject } from "@agora-sdk/react-js";
import { useResendVerification } from "./useResendVerification";

const mockProject = useProject as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockProject.mockReturnValue({ projectId: "p1" });
  Object.defineProperty(window, "location", { value: { origin: "https://app.test" }, writable: true });
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) }) as unknown as typeof fetch;
});
afterEach(() => vi.clearAllMocks());

describe("useResendVerification", () => {
  it("POSTs { email, emailRedirectTo } and reaches sent", async () => {
    const { result } = renderHook(() => useResendVerification());
    await act(async () => { await result.current.resend("user@test.dev"); });
    await waitFor(() => expect(result.current.status).toBe("sent"));
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.test/v7/p1/auth/send-verification-email");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ email: "user@test.dev", emailRedirectTo: "https://app.test" });
  });

  it("errors without calling fetch when email is empty", async () => {
    const { result } = renderHook(() => useResendVerification());
    await act(async () => { await result.current.resend("  "); });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.current.status).toBe("error");
  });

  it("maps a server error body", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "Rate limited" }) }) as unknown as typeof fetch;
    const { result } = renderHook(() => useResendVerification());
    await act(async () => { await result.current.resend("user@test.dev"); });
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("Rate limited");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agora-sdk/auth-react-js test useResendVerification`
Expected: FAIL — cannot find module `./useResendVerification`.

- [ ] **Step 3: Write the hook**

`packages/auth/react-js/src/useResendVerification.ts`:

```ts
// Resend-confirmation action ("Didn't get the email?"). Not a landing page. We POST directly via the
// SDK's public getApiBaseUrl() with { email, emailRedirectTo } — core's useSendVerificationEmail omits
// the `email` the server's emailSchema requires, so wrapping it would 400. emailRedirectTo defaults to
// this origin so the confirmation link returns here (matching the server's own resolution order).
import { useState } from "react";
import { useProject, getApiBaseUrl } from "@agora-sdk/react-js";

/** Lifecycle of a resend action. */
export type ResendStatus = "idle" | "sending" | "sent" | "error";

/** Return value of {@link useResendVerification}. */
export type UseResendVerificationReturn = {
  /** Request a fresh confirmation email for `email`. */
  resend: (email: string) => Promise<void>;
  /** Current {@link ResendStatus}. */
  status: ResendStatus;
  /** User-facing error, or null. */
  error: string | null;
};

/**
 * Resend the email-verification link for an address.
 *
 * @returns {@link UseResendVerificationReturn} — the `resend` action plus status/error.
 * @example
 * const { resend, status } = useResendVerification();
 * <button disabled={status === "sending"} onClick={() => void resend(email)}>Resend</button>
 */
export function useResendVerification(): UseResendVerificationReturn {
  const { projectId } = useProject();
  const [status, setStatus] = useState<ResendStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const resend = async (email: string): Promise<void> => {
    if (!projectId) {
      setError("Not ready yet. Please try again.");
      setStatus("error");
      return;
    }
    const trimmed = email.trim();
    if (!trimmed) {
      setError("Enter your email address.");
      setStatus("error");
      return;
    }
    setStatus("sending");
    setError(null);
    const emailRedirectTo = typeof window !== "undefined" ? window.location.origin : undefined;
    try {
      const res = await fetch(`${getApiBaseUrl()}/${projectId}/auth/send-verification-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed, ...(emailRedirectTo ? { emailRedirectTo } : {}) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const m =
          body && typeof body.error === "string" && body.error
            ? body.error
            : "Couldn't send the email. Please try again.";
        setError(m);
        setStatus("error");
        return;
      }
      setStatus("sent");
    } catch {
      setError("Couldn't reach the server. Please try again.");
      setStatus("error");
    }
  };

  return { resend, status, error };
}
```

- [ ] **Step 4: Run hook test to verify it passes**

Run: `pnpm --filter @agora-sdk/auth-react-js test useResendVerification`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the component**

`packages/auth/react-js/src/ResendVerificationButton.tsx`:

```tsx
// Small drop-in button over useResendVerification: click to resend, disabled while sending, shows a
// "Sent"/error state. Deliberately tiny — its value is the disable-and-status wiring, not layout.
import { useEffect } from "react";
import type { ReactNode } from "react";
import { useResendVerification } from "./useResendVerification";

/** Props for {@link ResendVerificationButton}. */
export type ResendVerificationButtonProps = {
  /** The address to resend the confirmation email to. */
  email: string;
  /** Button label in the idle state. Defaults to "Resend verification email". */
  children?: ReactNode;
  /** Fired once the email is sent. */
  onSent?: () => void;
  /** Fired with a user-facing message on failure. */
  onError?: (message: string) => void;
  /** Optional class on the wrapping element. */
  className?: string;
};

/**
 * A resend-verification button with built-in sending/sent/error state.
 *
 * @param props - {@link ResendVerificationButtonProps}
 * @example
 * <ResendVerificationButton email={user.email} onSent={() => toast("Sent!")} />
 */
export function ResendVerificationButton(props: ResendVerificationButtonProps): JSX.Element {
  const { email, children, onSent, onError, className } = props;
  const { resend, status, error } = useResendVerification();

  useEffect(() => {
    if (status === "sent") onSent?.();
    if (status === "error" && error) onError?.(error);
  }, [status, error, onSent, onError]);

  return (
    <span className={className}>
      <button type="button" onClick={() => void resend(email)} disabled={status === "sending"}>
        {status === "sending" ? "Sending…" : status === "sent" ? "Sent" : children ?? "Resend verification email"}
      </button>
      {status === "error" && (
        <span className="agora-resend-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
```

- [ ] **Step 6: Append a component test to the same file**

Add to `useResendVerification.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { ResendVerificationButton } from "./ResendVerificationButton";

describe("ResendVerificationButton", () => {
  it("resends on click and shows Sent, firing onSent", async () => {
    const onSent = vi.fn();
    render(<ResendVerificationButton email="user@test.dev" onSent={onSent} />);
    fireEvent.click(screen.getByRole("button"));
    await screen.findByRole("button", { name: /sent/i });
    expect(onSent).toHaveBeenCalled();
  });
});
```

- [ ] **Step 7: Run the full file and typecheck**

Run: `pnpm --filter @agora-sdk/auth-react-js test useResendVerification`
Expected: PASS (4 tests).
Run: `pnpm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/auth/react-js/src/useResendVerification.ts packages/auth/react-js/src/ResendVerificationButton.tsx packages/auth/react-js/src/useResendVerification.test.tsx
git commit -m "feat(auth): useResendVerification hook + ResendVerificationButton (direct POST, sends email)"
```

---

### Task 5: Exports, docs, changelog

**Files:**
- Modify: `packages/auth/react-js/src/index.ts`
- Modify: `packages/auth/react-js/README.md`
- Modify: `packages/auth/react-js/AUTH.md`
- Modify: `CHANGELOG.md` (repo root)
- Test: `packages/auth/react-js/src/index.test.ts` (add assertions)

**Interfaces:**
- Consumes: every exported symbol from Tasks 1–4.
- Produces: the package's public surface.

- [ ] **Step 1: Add the exports**

Append to `packages/auth/react-js/src/index.ts` (after the existing exports):

```ts
export { useEmailVerification } from "./useEmailVerification";
export type {
  EmailVerificationStatus,
  UseEmailVerificationOptions,
  UseEmailVerificationReturn,
} from "./useEmailVerification";
export { EmailVerificationHandler } from "./EmailVerificationHandler";
export type { EmailVerificationHandlerProps } from "./EmailVerificationHandler";

export { usePasswordReset } from "./usePasswordReset";
export type {
  PasswordResetStatus,
  UsePasswordResetOptions,
  UsePasswordResetReturn,
} from "./usePasswordReset";
export { PasswordResetHandler } from "./PasswordResetHandler";
export type { PasswordResetHandlerProps } from "./PasswordResetHandler";

export { useResendVerification } from "./useResendVerification";
export type { ResendStatus, UseResendVerificationReturn } from "./useResendVerification";
export { ResendVerificationButton } from "./ResendVerificationButton";
export type { ResendVerificationButtonProps } from "./ResendVerificationButton";
```

- [ ] **Step 2: Extend the barrel test**

Open `packages/auth/react-js/src/index.test.ts`, and add assertions that the new symbols are exported. Match the existing file's style; if it imports `* as api`, add:

```ts
it("exports the email-link handlers", () => {
  expect(typeof api.useEmailVerification).toBe("function");
  expect(typeof api.EmailVerificationHandler).toBe("function");
  expect(typeof api.usePasswordReset).toBe("function");
  expect(typeof api.PasswordResetHandler).toBe("function");
  expect(typeof api.useResendVerification).toBe("function");
  expect(typeof api.ResendVerificationButton).toBe("function");
});
```

> If `index.test.ts` mocks `@agora-sdk/react-js`, ensure the mock includes `useProject`,
> `useVerifyEmail`, and `getApiBaseUrl` so the module graph loads.

- [ ] **Step 3: Run the barrel test**

Run: `pnpm --filter @agora-sdk/auth-react-js test index`
Expected: PASS.

- [ ] **Step 4: README section**

Add to `packages/auth/react-js/README.md` (after the OAuth callback section):

````markdown
## Email verification & password reset pages

The server emails links back to *your* app — `/auth/verify-email` and `/auth/reset-password`. Drop these
in on those routes so the links stop 404-ing:

```tsx
import { EmailVerificationHandler, PasswordResetHandler } from "@agora-sdk/auth-react-js";

// route: /auth/verify-email
<EmailVerificationHandler redirectTo="/?verified=1" />

// route: /auth/reset-password  (ships a minimal new-password form; pass renderForm for your own UI)
<PasswordResetHandler redirectTo="/signin?reset=1" />
```

Both fail closed if the link's `projectId` doesn't match your app's, and strip the one-time token from
the URL after use. For the "didn't get it?" flow:

```tsx
import { ResendVerificationButton } from "@agora-sdk/auth-react-js";
<ResendVerificationButton email={email} onSent={() => toast("Sent!")} />
```
````

- [ ] **Step 5: AUTH.md guide entries**

Add a full "Email links" section to `packages/auth/react-js/AUTH.md` mirroring the OAuth section:
each hook + component with its props table, the states, the fail-closed projectId guard, the
token-hygiene note, and the rationale that reset/resend POST via `getApiBaseUrl()` (public, no core
hook) rather than through the SDK — and specifically that resend can't use core's
`useSendVerificationEmail` because that hook omits the required `email`.

- [ ] **Step 6: CHANGELOG**

Add under `## [Unreleased]` → `### Added` in `CHANGELOG.md`:

```markdown
- **auth-react-js:** email-link handlers — `EmailVerificationHandler` / `useEmailVerification`,
  `PasswordResetHandler` / `usePasswordReset` (minimal default form), and `ResendVerificationButton` /
  `useResendVerification`. Drop-ins for the server's emailed `/auth/verify-email` and
  `/auth/reset-password` links (previously 404'd on consumer apps), mirroring the OAuth black-box.
  Fail closed on projectId mismatch; strip the one-time token from the URL after use. Reset and resend
  POST directly via the SDK's public `getApiBaseUrl()` (no `agora-sdk` fork change).
```

- [ ] **Step 7: Full suite + typecheck + build**

Run: `pnpm --filter @agora-sdk/auth-react-js test`
Expected: all green.
Run: `pnpm run typecheck`
Expected: no errors.
Run: `pnpm --filter @agora-sdk/auth-react-js run build`
Expected: builds clean (dual ESM/CJS).

- [ ] **Step 8: Commit**

```bash
git add packages/auth/react-js/src/index.ts packages/auth/react-js/src/index.test.ts packages/auth/react-js/README.md packages/auth/react-js/AUTH.md CHANGELOG.md
git commit -m "feat(auth): export email-link handlers; README/AUTH/CHANGELOG"
```

---

## Self-Review

**Spec coverage:**
- §3.2 `parseAuthLink` + fail-closed + token strip → Task 1. ✅
- §3.3 email verification hook + component → Task 2. ✅
- §3.4 password reset hook + component (minimal form + renderForm) → Task 3. ✅
- §3.5 resend hook + button (direct POST, sends `email`) → Task 4. ✅
- §3.6 token hygiene (`stripTokenFromUrl`) → Task 1, exercised in Tasks 2–3. ✅
- §4 wire contract → assertions in Tasks 2 (`{token}`), 3 (`{token,newPassword}` + URL), 4 (`{email,emailRedirectTo}` + URL). ✅
- §5 error handling (missing-token, project-mismatch, server 4xx, short password, network) → tests across Tasks 1–4. ✅
- §6 exports → Task 5. ✅
- §7 testing (fail-closed no-call, no-password-leak log spy) → Tasks 2 & 3. ✅
- §8 docs (README, AUTH.md, TSDoc, CHANGELOG) → Task 5 + TSDoc in every module. ✅

**Placeholder scan:** No TBD/TODO; every code + test step shows real content. AUTH.md step (5.5) is prose-descriptive by nature (long-form guide) but names exactly which entries to write.

**Type consistency:** `parseAuthLink`/`stripTokenFromUrl` signatures match across Tasks 1–4; status unions (`EmailVerificationStatus`, `PasswordResetStatus`, `ResendStatus`) and option/return types are defined once and consumed with the same names; `getApiBaseUrl()`/`useVerifyEmail()` usages match their confirmed SDK signatures.
