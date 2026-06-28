# `@agora-sdk/auth-react-js` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a new web-only `agora-sdk-plus` package that makes the Agora SDK's OAuth flow black-box for MPA integrators — navigate only after the session is truly persisted, expose a first-class auth-ready status, give a logout that actually ends the session, and self-heal a stale-only session.

**Architecture:** A single React package that runs *inside* `<ReplykeProvider>` and **observes** the SDK's own auth state through its public hooks (`useAuth`/`useUser`/`useProject`/`useOAuthSignIn`/`useSignOutAll`) rather than re-implementing the auth contract. The only `localStorage` access (the `replyke-accounts:<projectId>` key + map shape) is quarantined in one module, `accountStorage.ts`. It peer-depends on `@agora-sdk/react-js` — the first plus feature to depend on `@agora-sdk/*`, a deliberate scoped exception.

**Tech Stack:** TypeScript, React 18/19, vitest + jsdom + @testing-library/react, pnpm workspace, dual ESM+CJS build via `tsc`.

**Source spec:** `docs/superpowers/specs/2026-06-27-auth-react-js-oauth-callback-design.md`

## Global Constraints

- **Package name:** `@agora-sdk/auth-react-js`. **Location:** `packages/auth/react-js`.
- **License:** Apache-2.0. **Version:** `0.8.0` (match the workspace's lockstep version).
- **No edits to the `agora-sdk` fork.** All code lives in this repo. (The optional one-line SDK JSDoc cross-link from spec §8 is explicitly OUT of this plan.)
- **Web-only.** No React Native / Expo. Uses `window` / `localStorage` freely.
- **Coupling:** observe the SDK via its public hooks; touch `localStorage` ONLY inside `accountStorage.ts`. Never re-implement REST/auth endpoints.
- **Storage contract (verbatim from the SDK):** key = `` `replyke-accounts:${projectId}` ``; value shape = `{ activeAccountId: string | null, accounts: { [userId: string]: { refreshToken: string, tokenExpiresAt: number, user: { id, name, email, avatar } } } }`.
- **Security (plus standard #1):** NEVER log, throw-with, or serialize access tokens or refresh tokens. Read *presence*, not value, from storage when gating.
- **Standards:** TSDoc on every exported symbol (#2); `why`-comments on non-obvious logic (#3); CHANGELOG bullet under `[Unreleased] › Added` in the same commit (#4); co-located `*.test.tsx` unit tests for every feature (#5).
- **Build model:** dual ESM (`dist/esm`, `tsconfig.esm.json`) + CJS (`dist/cjs`, `tsconfig.cjs.json` + a `dist/cjs/package.json` `{"type":"commonjs"}` marker), modeled on `packages/secure-chat/core`.
- **Test discovery:** the root `vitest.config.ts` globs `packages/**/src/**/*.test.{ts,tsx}` automatically — no config edit needed. React tests opt into jsdom with a `// @vitest-environment jsdom` file pragma. Mock `@agora-sdk/react-js` with `vi.mock(...)` at the boundary.
- **Commands:** build one package `pnpm --filter @agora-sdk/auth-react-js run build`; typecheck `pnpm run typecheck`; tests `pnpm test` (or `pnpm vitest run packages/auth`).

---

### Task 1: Scaffold package + `accountStorage.ts` (the quarantined storage seam)

**Files:**
- Create: `packages/auth/react-js/package.json`
- Create: `packages/auth/react-js/tsconfig.json`
- Create: `packages/auth/react-js/tsconfig.esm.json`
- Create: `packages/auth/react-js/tsconfig.cjs.json`
- Create: `packages/auth/react-js/src/accountStorage.ts`
- Test: `packages/auth/react-js/src/accountStorage.test.ts`

**Interfaces:**
- Produces:
  - `type AccountSummary = { id: string; name: string | null; email: string | null; avatar: string | null }`
  - `type AccountEntry = { refreshToken: string; tokenExpiresAt: number; user: AccountSummary }`
  - `type AccountMap = { activeAccountId: string | null; accounts: Record<string, AccountEntry> }`
  - `accountsStorageKey(projectId: string): string`
  - `readAccountMap(projectId: string): AccountMap | null`
  - `hasPersistedRefreshToken(projectId: string, userId: string): boolean`
  - `pruneAccount(projectId: string, userId: string): AccountMap | null` — removes the entry, writes the map back, dispatches a synthetic `storage` event so the SDK's `useAccountSync` Phase D adopts the pruned map in-session, and returns the new map (or `null` if nothing changed).

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@agora-sdk/auth-react-js",
  "version": "0.8.0",
  "private": false,
  "license": "Apache-2.0",
  "author": "Agora SDK Plus, maintained by Jenova Marie",
  "description": "Black-box OAuth callback handling and auth ergonomics for Agora SDK (Replyke fork) web apps: persistence-gated callback redirect, auth-ready status, reliable logout, stale-account self-heal.",
  "keywords": ["agora", "replyke", "oauth", "auth", "react", "web", "typescript"],
  "bugs": { "url": "https://github.com/jenova-marie/agora-sdk-plus/issues" },
  "homepage": "https://github.com/jenova-marie/agora-sdk-plus",
  "repository": {
    "type": "git",
    "url": "https://github.com/jenova-marie/agora-sdk-plus.git",
    "directory": "packages/auth/react-js"
  },
  "main": "dist/cjs/index.js",
  "module": "dist/esm/index.js",
  "types": "dist/esm/index.d.ts",
  "type": "module",
  "scripts": {
    "build:esm": "tsc -p tsconfig.esm.json",
    "build:cjs": "tsc -p tsconfig.cjs.json && echo '{\"type\":\"commonjs\"}' > dist/cjs/package.json",
    "build": "rimraf dist && pnpm run build:esm && pnpm run build:cjs",
    "prepublish": "pnpm run build"
  },
  "publishConfig": { "access": "public" },
  "files": ["dist"],
  "peerDependencies": {
    "@agora-sdk/react-js": "^1.3.0",
    "@types/react": "^18.0.0 || ^19.0.0",
    "react": "^18.0.0 || ^19.0.0",
    "react-dom": "^18.0.0 || ^19.0.0"
  },
  "devDependencies": {
    "@agora-sdk/react-js": "^1.3.0"
  }
}
```

- [ ] **Step 2: Create the three tsconfigs**

`tsconfig.json` (base — modeled on `packages/secure-chat/core/tsconfig.json`):

```json
{
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "target": "ES2020",
    "module": "esnext",
    "lib": ["ES2020", "dom"],
    "jsx": "react-jsx",
    "declaration": true,
    "sourceMap": true,
    "strict": true,
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"],
  "exclude": ["dist", "**/*.test.ts", "**/*.test.tsx"]
}
```

`tsconfig.esm.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "outDir": "./dist/esm", "module": "esnext" }
}
```

`tsconfig.cjs.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist/cjs",
    "module": "commonjs",
    "moduleResolution": "node",
    "ignoreDeprecations": "5.0"
  }
}
```

- [ ] **Step 3: Install so the workspace links the new package**

Run: `pnpm install`
Expected: completes; `@agora-sdk/auth-react-js` recognized as a workspace package and `@agora-sdk/react-js` resolved from npm into `node_modules`.

- [ ] **Step 4: Write the failing test** — `src/accountStorage.test.ts`

```ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  accountsStorageKey,
  readAccountMap,
  hasPersistedRefreshToken,
  pruneAccount,
  type AccountMap,
} from "./accountStorage";

const PROJECT = "proj_123";
const KEY = `replyke-accounts:${PROJECT}`;

function seed(map: AccountMap) {
  localStorage.setItem(KEY, JSON.stringify(map));
}

describe("accountStorage", () => {
  beforeEach(() => localStorage.clear());

  it("derives the SDK storage key", () => {
    expect(accountsStorageKey(PROJECT)).toBe(KEY);
  });

  it("returns null when nothing is stored or JSON is corrupt", () => {
    expect(readAccountMap(PROJECT)).toBeNull();
    localStorage.setItem(KEY, "{not json");
    expect(readAccountMap(PROJECT)).toBeNull();
  });

  it("detects a persisted refresh token for a user", () => {
    seed({
      activeAccountId: "u1",
      accounts: {
        u1: { refreshToken: "rt1", tokenExpiresAt: 0, user: { id: "u1", name: null, email: null, avatar: null } },
      },
    });
    expect(hasPersistedRefreshToken(PROJECT, "u1")).toBe(true);
    expect(hasPersistedRefreshToken(PROJECT, "u2")).toBe(false);
  });

  it("prunes an account, rewrites storage, and dispatches a storage event", () => {
    seed({
      activeAccountId: "stale",
      accounts: {
        stale: { refreshToken: "dead", tokenExpiresAt: 0, user: { id: "stale", name: null, email: null, avatar: null } },
        good: { refreshToken: "rt", tokenExpiresAt: 0, user: { id: "good", name: null, email: null, avatar: null } },
      },
    });
    const events: StorageEvent[] = [];
    const handler = (e: StorageEvent) => events.push(e);
    window.addEventListener("storage", handler);

    const next = pruneAccount(PROJECT, "stale");
    window.removeEventListener("storage", handler);

    expect(next?.accounts.stale).toBeUndefined();
    expect(next?.accounts.good).toBeDefined();
    expect(readAccountMap(PROJECT)?.accounts.stale).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0].key).toBe(KEY);
    expect(events[0].newValue).toContain("good");
  });

  it("pruning a missing user is a no-op returning null", () => {
    seed({ activeAccountId: null, accounts: {} });
    expect(pruneAccount(PROJECT, "nobody")).toBeNull();
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `pnpm vitest run packages/auth/react-js/src/accountStorage.test.ts`
Expected: FAIL — `Cannot find module './accountStorage'`.

- [ ] **Step 6: Implement `src/accountStorage.ts`**

```ts
// The ONLY module that knows the Agora SDK's account-storage contract: the
// `replyke-accounts:<projectId>` key prefix and the multi-account map shape persisted by the SDK's
// `useAccountSync`. Quarantining it here means an upstream contract change touches one file, not every
// integrator's callback page. We read PRESENCE of a refresh token, never log its value.

/** One stored account's user summary (mirrors the SDK's persisted shape). */
export type AccountSummary = {
  id: string;
  name: string | null;
  email: string | null;
  avatar: string | null;
};

/** One stored account: its current refresh token, expiry, and user summary. */
export type AccountEntry = {
  refreshToken: string;
  tokenExpiresAt: number;
  user: AccountSummary;
};

/** The full multi-account map the SDK persists per project. */
export type AccountMap = {
  activeAccountId: string | null;
  accounts: Record<string, AccountEntry>;
};

/** The localStorage key the SDK persists the account map under, for a given project. */
export function accountsStorageKey(projectId: string): string {
  return `replyke-accounts:${projectId}`;
}

/** Read + parse the persisted account map, or null if absent/corrupt. Never throws. */
export function readAccountMap(projectId: string): AccountMap | null {
  try {
    const raw = localStorage.getItem(accountsStorageKey(projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AccountMap;
    if (!parsed || typeof parsed !== "object" || !parsed.accounts) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** True when the persisted map has a refresh token for this user — the exact state the next document reads on boot. */
export function hasPersistedRefreshToken(projectId: string, userId: string): boolean {
  const map = readAccountMap(projectId);
  return Boolean(map?.accounts?.[userId]?.refreshToken);
}

/**
 * Remove an account from the persisted map and write it back. Returns the new map, or null if the
 * user wasn't present (no-op). After writing, dispatches a synthetic `storage` event for the same
 * key so the SDK's `useAccountSync` Phase D listener adopts the pruned map IN THIS TAB (native
 * `storage` events fire only in OTHER tabs), letting the SDK re-evaluate remaining accounts without
 * reaching into its Redux store.
 */
export function pruneAccount(projectId: string, userId: string): AccountMap | null {
  const map = readAccountMap(projectId);
  if (!map || !map.accounts[userId]) return null;

  const accounts = { ...map.accounts };
  delete accounts[userId];
  const nextActive = map.activeAccountId === userId ? null : map.activeAccountId;
  const next: AccountMap = { activeAccountId: nextActive, accounts };

  const key = accountsStorageKey(projectId);
  const oldValue = localStorage.getItem(key);
  const newValue = JSON.stringify(next);
  localStorage.setItem(key, newValue);
  window.dispatchEvent(new StorageEvent("storage", { key, oldValue, newValue }));
  return next;
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm vitest run packages/auth/react-js/src/accountStorage.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 8: Build the package to confirm the scaffold compiles**

Run: `pnpm --filter @agora-sdk/auth-react-js exec tsc -p tsconfig.esm.json --noEmit`
Expected: no errors. (Full `build` runs after `index.ts` exists in Task 7.)

- [ ] **Step 9: Commit**

```bash
git add packages/auth/react-js/package.json packages/auth/react-js/tsconfig*.json \
  packages/auth/react-js/src/accountStorage.ts packages/auth/react-js/src/accountStorage.test.ts \
  pnpm-lock.yaml
git commit -m "feat(auth): scaffold @agora-sdk/auth-react-js + accountStorage seam"
```

---

### Task 2: `useAuthStatus.ts` (P4 — first-class auth-ready signal)

**Files:**
- Create: `packages/auth/react-js/src/useAuthStatus.ts`
- Test: `packages/auth/react-js/src/useAuthStatus.test.tsx`

**Interfaces:**
- Consumes: SDK hooks `useAuth()` (`{ initialized, accessToken }`), `useUser()` (`{ user }`), `useProject()` (`{ projectId }`); `hasPersistedRefreshToken` from Task 1.
- Produces:
  - `type AuthReadyStatus = "initializing" | "authenticated" | "unauthenticated"`
  - `type UseAuthStatusReturn = { status: AuthReadyStatus; isPersisted: boolean }`
  - `useAuthStatus(): UseAuthStatusReturn`

- [ ] **Step 1: Write the failing test** — `src/useAuthStatus.test.tsx`

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("@agora-sdk/react-js", () => ({
  useAuth: vi.fn(),
  useUser: vi.fn(),
  useProject: vi.fn(),
}));

import { useAuth, useUser, useProject } from "@agora-sdk/react-js";
import { useAuthStatus } from "./useAuthStatus";

const mockAuth = useAuth as unknown as ReturnType<typeof vi.fn>;
const mockUser = useUser as unknown as ReturnType<typeof vi.fn>;
const mockProject = useProject as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  mockProject.mockReturnValue({ projectId: "p1" });
});
afterEach(() => vi.clearAllMocks());

describe("useAuthStatus", () => {
  it("is initializing until the SDK reports initialized", () => {
    mockAuth.mockReturnValue({ initialized: false, accessToken: null });
    mockUser.mockReturnValue({ user: null });
    const { result } = renderHook(() => useAuthStatus());
    expect(result.current.status).toBe("initializing");
  });

  it("is authenticated when initialized with an access token and a user", () => {
    mockAuth.mockReturnValue({ initialized: true, accessToken: "at" });
    mockUser.mockReturnValue({ user: { id: "u1" } });
    const { result } = renderHook(() => useAuthStatus());
    expect(result.current.status).toBe("authenticated");
  });

  it("is unauthenticated when initialized with no session", () => {
    mockAuth.mockReturnValue({ initialized: true, accessToken: null });
    mockUser.mockReturnValue({ user: null });
    const { result } = renderHook(() => useAuthStatus());
    expect(result.current.status).toBe("unauthenticated");
  });

  it("reports isPersisted from the stored account map, not just Redux", () => {
    localStorage.setItem(
      "replyke-accounts:p1",
      JSON.stringify({ activeAccountId: "u1", accounts: { u1: { refreshToken: "rt", tokenExpiresAt: 0, user: { id: "u1", name: null, email: null, avatar: null } } } })
    );
    mockAuth.mockReturnValue({ initialized: true, accessToken: "at" });
    mockUser.mockReturnValue({ user: { id: "u1" } });
    const { result } = renderHook(() => useAuthStatus());
    expect(result.current.isPersisted).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/auth/react-js/src/useAuthStatus.test.tsx`
Expected: FAIL — `Cannot find module './useAuthStatus'`.

- [ ] **Step 3: Implement `src/useAuthStatus.ts`**

```ts
// P4 — a first-class auth-ready signal so integrators stop re-deriving `Boolean(accessToken && user)`
// and stop guessing when the two settle. Observes the SDK's own state via its public hooks; reads
// storage only to answer "is the session durable (in localStorage), not just in Redux?".
import { useAuth, useUser, useProject } from "@agora-sdk/react-js";
import { hasPersistedRefreshToken } from "./accountStorage";

/** Coarse, settled auth state derived once for the whole app. */
export type AuthReadyStatus = "initializing" | "authenticated" | "unauthenticated";

/** Return value of {@link useAuthStatus}. */
export type UseAuthStatusReturn = {
  /** `initializing` until the SDK has booted; then `authenticated` / `unauthenticated`. */
  status: AuthReadyStatus;
  /** True when the active session is written to localStorage (survives a reload), not just held in Redux. */
  isPersisted: boolean;
};

/**
 * Derive a single, first-class auth-ready signal from the SDK's auth + user slices.
 *
 * @returns the coarse {@link AuthReadyStatus} and whether the session is persisted.
 * @example
 * const { status } = useAuthStatus();
 * if (status === "initializing") return <Spinner />;
 * return status === "authenticated" ? <App /> : <Login />;
 */
export function useAuthStatus(): UseAuthStatusReturn {
  const { initialized, accessToken } = useAuth();
  const { user } = useUser();
  const { projectId } = useProject();

  const status: AuthReadyStatus = !initialized
    ? "initializing"
    : accessToken && user?.id
    ? "authenticated"
    : "unauthenticated";

  const isPersisted = Boolean(
    projectId && user?.id && hasPersistedRefreshToken(projectId, user.id)
  );

  return { status, isPersisted };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/auth/react-js/src/useAuthStatus.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/auth/react-js/src/useAuthStatus.ts packages/auth/react-js/src/useAuthStatus.test.tsx
git commit -m "feat(auth): useAuthStatus — first-class auth-ready signal (P4)"
```

---

### Task 3: `useOAuthCallback.ts` (P1-emulated + P3 — the persistence gate)

**Files:**
- Create: `packages/auth/react-js/src/useOAuthCallback.ts`
- Test: `packages/auth/react-js/src/useOAuthCallback.test.tsx`

**Interfaces:**
- Consumes: SDK hooks `useOAuthSignIn()` (`{ handleOAuthCallback(): boolean, error: string | null }`), `useAuth()` (`{ accessToken }`), `useUser()` (`{ user }`), `useProject()` (`{ projectId }`); `hasPersistedRefreshToken` from Task 1.
- Produces:
  - `type OAuthCallbackStatus = "pending" | "success" | "error"`
  - `type UseOAuthCallbackOptions = { redirectTo: string; onTimeout?: () => void; timeoutMs?: number }`
  - `type UseOAuthCallbackReturn = { status: OAuthCallbackStatus; error: string | null }`
  - `useOAuthCallback(options: UseOAuthCallbackOptions): UseOAuthCallbackReturn`

- [ ] **Step 1: Write the failing test** — `src/useOAuthCallback.test.tsx`

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

vi.mock("@agora-sdk/react-js", () => ({
  useOAuthSignIn: vi.fn(),
  useAuth: vi.fn(),
  useUser: vi.fn(),
  useProject: vi.fn(),
}));

import { useOAuthSignIn, useAuth, useUser, useProject } from "@agora-sdk/react-js";
import { useOAuthCallback } from "./useOAuthCallback";

const mockOAuth = useOAuthSignIn as unknown as ReturnType<typeof vi.fn>;
const mockAuth = useAuth as unknown as ReturnType<typeof vi.fn>;
const mockUser = useUser as unknown as ReturnType<typeof vi.fn>;
const mockProject = useProject as unknown as ReturnType<typeof vi.fn>;

const KEY = "replyke-accounts:p1";
let replace: ReturnType<typeof vi.fn>;

function persist(userId: string) {
  localStorage.setItem(KEY, JSON.stringify({ activeAccountId: userId, accounts: { [userId]: { refreshToken: "rt", tokenExpiresAt: 0, user: { id: userId, name: null, email: null, avatar: null } } } }));
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  replace = vi.fn();
  Object.defineProperty(window, "location", { value: { replace, pathname: "/auth/callback" }, writable: true });
  mockProject.mockReturnValue({ projectId: "p1" });
  mockOAuth.mockReturnValue({ handleOAuthCallback: vi.fn(() => true), error: null });
  mockAuth.mockReturnValue({ accessToken: null });
  mockUser.mockReturnValue({ user: null });
});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe("useOAuthCallback", () => {
  it("parses the callback exactly once on mount", () => {
    const parse = vi.fn(() => true);
    mockOAuth.mockReturnValue({ handleOAuthCallback: parse, error: null });
    const { rerender } = renderHook(() => useOAuthCallback({ redirectTo: "/" }));
    rerender();
    rerender();
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("stays pending and does NOT navigate while the user fetch is in flight", () => {
    // tokens staged but user not resolved yet
    mockAuth.mockReturnValue({ accessToken: "at" });
    mockUser.mockReturnValue({ user: null });
    const { result } = renderHook(() => useOAuthCallback({ redirectTo: "/" }));
    expect(result.current.status).toBe("pending");
    expect(replace).not.toHaveBeenCalled();
  });

  it("stays pending when Redux has a user but storage has not persisted yet", () => {
    mockAuth.mockReturnValue({ accessToken: "at" });
    mockUser.mockReturnValue({ user: { id: "u1" } }); // storage NOT seeded
    const { result } = renderHook(() => useOAuthCallback({ redirectTo: "/" }));
    expect(result.current.status).toBe("pending");
    expect(replace).not.toHaveBeenCalled();
  });

  it("navigates to redirectTo only after store + storage both confirm the session", () => {
    persist("u1");
    mockAuth.mockReturnValue({ accessToken: "at" });
    mockUser.mockReturnValue({ user: { id: "u1" } });
    const { result } = renderHook(() => useOAuthCallback({ redirectTo: "/#comments" }));
    expect(result.current.status).toBe("success");
    expect(replace).toHaveBeenCalledWith("/#comments");
  });

  it("surfaces a provider error, does not navigate", () => {
    mockOAuth.mockReturnValue({ handleOAuthCallback: vi.fn(() => false), error: "access_denied" });
    const { result } = renderHook(() => useOAuthCallback({ redirectTo: "/" }));
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("access_denied");
    expect(replace).not.toHaveBeenCalled();
  });

  it("fires onTimeout if persistence never lands", () => {
    const onTimeout = vi.fn();
    mockAuth.mockReturnValue({ accessToken: "at" });
    mockUser.mockReturnValue({ user: null }); // never resolves
    renderHook(() => useOAuthCallback({ redirectTo: "/", onTimeout, timeoutMs: 5000 }));
    act(() => { vi.advanceTimersByTime(5000); });
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/auth/react-js/src/useOAuthCallback.test.tsx`
Expected: FAIL — `Cannot find module './useOAuthCallback'`.

- [ ] **Step 3: Implement `src/useOAuthCallback.ts`**

```ts
// P1 (emulated) + P3 — the persistence gate. The SDK's handleOAuthCallback() is fire-and-forget with
// DEFERRED persistence: it stages tokens in Redux and starts an async user fetch, but the session
// isn't written to localStorage until useAccountSync's effects run several render cycles later. An MPA
// callback that navigates on the synchronous return tears down the tree before persistence lands and
// loses the session. This hook gates navigation on OBSERVED persistence (store state AND the
// localStorage row), never a timer — so the next document boots into a real session.
import { useEffect, useRef, useState } from "react";
import { useOAuthSignIn, useAuth, useUser, useProject } from "@agora-sdk/react-js";
import { hasPersistedRefreshToken } from "./accountStorage";

/** Lifecycle of an OAuth callback page. */
export type OAuthCallbackStatus = "pending" | "success" | "error";

/** Options for {@link useOAuthCallback}. */
export type UseOAuthCallbackOptions = {
  /** Where to navigate (full-page) once the session is truly persisted. */
  redirectTo: string;
  /** Called if persistence never lands within `timeoutMs` (e.g. the user fetch failed). */
  onTimeout?: () => void;
  /** How long to wait for persistence before giving up. Default 15000ms. */
  timeoutMs?: number;
};

/** Return value of {@link useOAuthCallback}. */
export type UseOAuthCallbackReturn = {
  /** `pending` while waiting for persistence; `success` just before navigation; `error` on a provider error. */
  status: OAuthCallbackStatus;
  /** Human-readable provider error, when `status === "error"`. */
  error: string | null;
};

/**
 * Drive an MPA OAuth callback page: parse the redirect once, wait until the session is actually
 * persisted to localStorage, then full-page-navigate to `redirectTo`. Resolves the persist→navigate
 * race so the destination document boots authenticated.
 *
 * @param options - {@link UseOAuthCallbackOptions}
 * @returns the {@link OAuthCallbackStatus} and any provider error.
 * @example
 * function Callback() {
 *   const { status, error } = useOAuthCallback({ redirectTo: "/#comments" });
 *   if (status === "error") return <p>Sign-in failed: {error}</p>;
 *   return <Spinner />; // success navigates away
 * }
 */
export function useOAuthCallback(options: UseOAuthCallbackOptions): UseOAuthCallbackReturn {
  const { redirectTo, onTimeout, timeoutMs = 15000 } = options;
  const { handleOAuthCallback, error: providerError } = useOAuthSignIn();
  const { accessToken } = useAuth();
  const { user } = useUser();
  const { projectId } = useProject();

  const [status, setStatus] = useState<OAuthCallbackStatus>("pending");
  const [error, setError] = useState<string | null>(null);
  const parsedRef = useRef(false);
  const doneRef = useRef(false);

  // Parse the redirect exactly once. This only stages tokens + starts the async user fetch.
  useEffect(() => {
    if (parsedRef.current) return;
    parsedRef.current = true;
    const ok = handleOAuthCallback();
    if (!ok) {
      doneRef.current = true;
      setError(providerError);
      setStatus("error");
    }
  }, [handleOAuthCallback, providerError]);

  // Navigate ONLY once store state (accessToken + user) AND the persisted localStorage row agree.
  useEffect(() => {
    if (doneRef.current) return;
    if (!accessToken || !user?.id || !projectId) return; // user fetch still in flight
    if (!hasPersistedRefreshToken(projectId, user.id)) return; // write hasn't landed yet
    doneRef.current = true;
    setStatus("success");
    window.location.replace(redirectTo);
  }, [accessToken, user, projectId, redirectTo]);

  // Escape hatch: if persistence never lands, tell the caller instead of hanging forever.
  useEffect(() => {
    if (doneRef.current) return;
    const id = setTimeout(() => {
      if (doneRef.current) return;
      doneRef.current = true;
      onTimeout?.();
    }, timeoutMs);
    return () => clearTimeout(id);
  }, [onTimeout, timeoutMs]);

  return { status, error };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/auth/react-js/src/useOAuthCallback.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/auth/react-js/src/useOAuthCallback.ts packages/auth/react-js/src/useOAuthCallback.test.tsx
git commit -m "feat(auth): useOAuthCallback — persistence-gated MPA callback (P1/P3)"
```

---

### Task 4: `OAuthCallbackHandler.tsx` (P3 — drop-in component)

**Files:**
- Create: `packages/auth/react-js/src/OAuthCallbackHandler.tsx`
- Test: `packages/auth/react-js/src/OAuthCallbackHandler.test.tsx`

**Interfaces:**
- Consumes: `useOAuthCallback` from Task 3.
- Produces:
  - `type OAuthCallbackHandlerProps = { redirectTo: string; onSuccess?: () => void; onError?: (message: string | null) => void; onTimeout?: () => void; timeoutMs?: number; pending?: React.ReactNode; error?: (message: string | null) => React.ReactNode }`
  - `OAuthCallbackHandler(props: OAuthCallbackHandlerProps): JSX.Element`

- [ ] **Step 1: Write the failing test** — `src/OAuthCallbackHandler.test.tsx`

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("./useOAuthCallback", () => ({ useOAuthCallback: vi.fn() }));
import { useOAuthCallback } from "./useOAuthCallback";
import { OAuthCallbackHandler } from "./OAuthCallbackHandler";

const mockCb = useOAuthCallback as unknown as ReturnType<typeof vi.fn>;
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.clearAllMocks());

describe("OAuthCallbackHandler", () => {
  it("renders the pending slot while pending", () => {
    mockCb.mockReturnValue({ status: "pending", error: null });
    render(<OAuthCallbackHandler redirectTo="/" pending={<span>loading</span>} />);
    expect(screen.getByText("loading")).toBeTruthy();
  });

  it("calls onError and renders the error slot on error", () => {
    mockCb.mockReturnValue({ status: "error", error: "denied" });
    const onError = vi.fn();
    render(<OAuthCallbackHandler redirectTo="/" onError={onError} error={(m) => <span>err:{m}</span>} />);
    expect(onError).toHaveBeenCalledWith("denied");
    expect(screen.getByText("err:denied")).toBeTruthy();
  });

  it("calls onSuccess on success", () => {
    mockCb.mockReturnValue({ status: "success", error: null });
    const onSuccess = vi.fn();
    render(<OAuthCallbackHandler redirectTo="/" onSuccess={onSuccess} />);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("forwards redirectTo/timeout options to the hook", () => {
    mockCb.mockReturnValue({ status: "pending", error: null });
    const onTimeout = vi.fn();
    render(<OAuthCallbackHandler redirectTo="/home" timeoutMs={9000} onTimeout={onTimeout} />);
    expect(mockCb).toHaveBeenCalledWith(
      expect.objectContaining({ redirectTo: "/home", timeoutMs: 9000, onTimeout })
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/auth/react-js/src/OAuthCallbackHandler.test.tsx`
Expected: FAIL — `Cannot find module './OAuthCallbackHandler'`.

- [ ] **Step 3: Implement `src/OAuthCallbackHandler.tsx`**

```tsx
// P3 — a copy-paste drop-in for the MPA callback route, over the useOAuthCallback engine. Integrators
// who don't want to wire status themselves render this and pass onSuccess/onError/redirectTo.
import { useEffect } from "react";
import type { ReactNode } from "react";
import { useOAuthCallback } from "./useOAuthCallback";

/** Props for {@link OAuthCallbackHandler}. */
export type OAuthCallbackHandlerProps = {
  /** Where to navigate once the session is truly persisted. */
  redirectTo: string;
  /** Fired once the session is persisted (just before navigation). */
  onSuccess?: () => void;
  /** Fired with the provider error message on failure. */
  onError?: (message: string | null) => void;
  /** Fired if persistence never lands within `timeoutMs`. */
  onTimeout?: () => void;
  /** How long to wait for persistence before `onTimeout`. Default 15000ms. */
  timeoutMs?: number;
  /** Rendered while waiting. Defaults to nothing. */
  pending?: ReactNode;
  /** Rendered on error. Defaults to nothing. */
  error?: (message: string | null) => ReactNode;
};

/**
 * Drop-in OAuth callback page. Drives {@link useOAuthCallback} and renders pending/error slots,
 * firing `onSuccess` / `onError` / `onTimeout` callbacks.
 *
 * @param props - {@link OAuthCallbackHandlerProps}
 * @example
 * <OAuthCallbackHandler redirectTo="/" onError={(m) => toast(m)} pending={<Spinner/>} />
 */
export function OAuthCallbackHandler(props: OAuthCallbackHandlerProps): JSX.Element {
  const { redirectTo, onSuccess, onError, onTimeout, timeoutMs, pending, error } = props;
  const { status, error: message } = useOAuthCallback({ redirectTo, onTimeout, timeoutMs });

  useEffect(() => {
    if (status === "success") onSuccess?.();
    if (status === "error") onError?.(message);
  }, [status, message, onSuccess, onError]);

  if (status === "error") return <>{error ? error(message) : null}</>;
  return <>{status === "pending" ? pending ?? null : null}</>;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/auth/react-js/src/OAuthCallbackHandler.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/auth/react-js/src/OAuthCallbackHandler.tsx packages/auth/react-js/src/OAuthCallbackHandler.test.tsx
git commit -m "feat(auth): OAuthCallbackHandler drop-in component (P3)"
```

---

### Task 5: `useSignOutEverywhere.ts` (P5 — logout that ends the session)

**Files:**
- Create: `packages/auth/react-js/src/useSignOutEverywhere.ts`
- Test: `packages/auth/react-js/src/useSignOutEverywhere.test.tsx`

**Interfaces:**
- Consumes: SDK hook `useSignOutAll()` (`{ signOutAll(): Promise<void> }`).
- Produces:
  - `type UseSignOutEverywhereReturn = { signOutEverywhere: () => Promise<void>; isPending: boolean }`
  - `useSignOutEverywhere(): UseSignOutEverywhereReturn`

- [ ] **Step 1: Write the failing test** — `src/useSignOutEverywhere.test.tsx`

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

vi.mock("@agora-sdk/react-js", () => ({ useSignOutAll: vi.fn() }));
import { useSignOutAll } from "@agora-sdk/react-js";
import { useSignOutEverywhere } from "./useSignOutEverywhere";

const mockSignOutAll = useSignOutAll as unknown as ReturnType<typeof vi.fn>;
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.clearAllMocks());

describe("useSignOutEverywhere", () => {
  it("calls the SDK's signOutAll and toggles isPending", async () => {
    const signOutAll = vi.fn().mockResolvedValue(undefined);
    mockSignOutAll.mockReturnValue({ signOutAll });
    const { result } = renderHook(() => useSignOutEverywhere());

    expect(result.current.isPending).toBe(false);
    await act(async () => { await result.current.signOutEverywhere(); });
    expect(signOutAll).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.isPending).toBe(false));
  });

  it("resets isPending even when signOutAll rejects", async () => {
    const signOutAll = vi.fn().mockRejectedValue(new Error("revoke failed"));
    mockSignOutAll.mockReturnValue({ signOutAll });
    const { result } = renderHook(() => useSignOutEverywhere());

    await act(async () => {
      await expect(result.current.signOutEverywhere()).rejects.toThrow("revoke failed");
    });
    await waitFor(() => expect(result.current.isPending).toBe(false));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/auth/react-js/src/useSignOutEverywhere.test.tsx`
Expected: FAIL — `Cannot find module './useSignOutEverywhere'`.

- [ ] **Step 3: Implement `src/useSignOutEverywhere.ts`**

```ts
// P5 — the logout integrators actually want. The SDK's useAuth().signOut() is active-account-only: with
// more than one stored account it SWITCHES to a remaining account instead of ending the session, and
// can't clear a corrupt map. useSignOutAll() wipes the whole map — the reliable full logout. This wraps
// it under an intent-revealing name and adds a pending flag for button state.
import { useCallback, useRef, useState } from "react";
import { useSignOutAll } from "@agora-sdk/react-js";

/** Return value of {@link useSignOutEverywhere}. */
export type UseSignOutEverywhereReturn = {
  /** End the session on every stored account and clear the map. Rejects if the server revoke fails (local state is still cleared by the SDK). */
  signOutEverywhere: () => Promise<void>;
  /** True while the sign-out is in flight. */
  isPending: boolean;
};

/**
 * Reliable full logout for a single-session app — wraps the SDK's `useSignOutAll`.
 *
 * @returns {@link UseSignOutEverywhereReturn}
 * @example
 * const { signOutEverywhere, isPending } = useSignOutEverywhere();
 * <button disabled={isPending} onClick={() => void signOutEverywhere().catch(() => {})}>Sign out</button>
 */
export function useSignOutEverywhere(): UseSignOutEverywhereReturn {
  const { signOutAll } = useSignOutAll();
  const [isPending, setIsPending] = useState(false);
  const mounted = useRef(true);

  const signOutEverywhere = useCallback(async () => {
    setIsPending(true);
    try {
      await signOutAll();
    } finally {
      if (mounted.current) setIsPending(false);
    }
  }, [signOutAll]);

  return { signOutEverywhere, isPending };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/auth/react-js/src/useSignOutEverywhere.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/auth/react-js/src/useSignOutEverywhere.ts packages/auth/react-js/src/useSignOutEverywhere.test.tsx
git commit -m "feat(auth): useSignOutEverywhere — reliable full logout (P5)"
```

---

### Task 6: `useAuthSelfHeal.ts` (P6 — observe-the-outcome stale-account prune)

**Files:**
- Create: `packages/auth/react-js/src/useAuthSelfHeal.ts`
- Test: `packages/auth/react-js/src/useAuthSelfHeal.test.tsx`

**Interfaces:**
- Consumes: `useAuthStatus` from Task 2; `useProject()` from `@agora-sdk/react-js`; `readAccountMap` + `pruneAccount` from Task 1.
- Produces:
  - `useAuthSelfHeal(): void`

- [ ] **Step 1: Write the failing test** — `src/useAuthSelfHeal.test.tsx`

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("@agora-sdk/react-js", () => ({ useProject: vi.fn() }));
vi.mock("./useAuthStatus", () => ({ useAuthStatus: vi.fn() }));

import { useProject } from "@agora-sdk/react-js";
import { useAuthStatus } from "./useAuthStatus";
import { useAuthSelfHeal } from "./useAuthSelfHeal";
import { readAccountMap } from "./accountStorage";

const mockProject = useProject as unknown as ReturnType<typeof vi.fn>;
const mockStatus = useAuthStatus as unknown as ReturnType<typeof vi.fn>;
const KEY = "replyke-accounts:p1";

function seedStale() {
  localStorage.setItem(KEY, JSON.stringify({ activeAccountId: "stale", accounts: { stale: { refreshToken: "dead", tokenExpiresAt: 0, user: { id: "stale", name: null, email: null, avatar: null } } } }));
}

beforeEach(() => {
  localStorage.clear();
  mockProject.mockReturnValue({ projectId: "p1" });
});
afterEach(() => vi.clearAllMocks());

describe("useAuthSelfHeal", () => {
  it("prunes the active account when the SDK settled unauthenticated with a stored account", () => {
    seedStale();
    mockStatus.mockReturnValue({ status: "unauthenticated", isPersisted: false });
    renderHook(() => useAuthSelfHeal());
    expect(readAccountMap("p1")?.accounts.stale).toBeUndefined();
  });

  it("does nothing while initializing", () => {
    seedStale();
    mockStatus.mockReturnValue({ status: "initializing", isPersisted: false });
    renderHook(() => useAuthSelfHeal());
    expect(readAccountMap("p1")?.accounts.stale).toBeDefined();
  });

  it("does nothing when authenticated", () => {
    seedStale();
    mockStatus.mockReturnValue({ status: "authenticated", isPersisted: true });
    renderHook(() => useAuthSelfHeal());
    expect(readAccountMap("p1")?.accounts.stale).toBeDefined();
  });

  it("prunes each dead account at most once (no prune→re-eval→prune loop)", () => {
    seedStale();
    mockStatus.mockReturnValue({ status: "unauthenticated", isPersisted: false });
    const { rerender } = renderHook(() => useAuthSelfHeal());
    // Re-seed the same stale id and re-render: the guard must NOT prune it again.
    seedStale();
    rerender();
    expect(readAccountMap("p1")?.accounts.stale).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/auth/react-js/src/useAuthSelfHeal.test.tsx`
Expected: FAIL — `Cannot find module './useAuthSelfHeal'`.

- [ ] **Step 3: Implement `src/useAuthSelfHeal.ts`**

```ts
// P6 — self-heal a stale-only session. A returning user whose only stored refresh token has been
// rotated away server-side boots → `unknown token` 401 → stuck logged out, because the dead entry
// stays in the map with no prune-on-failure. We heal by OBSERVING the SDK's settled outcome (it ended
// up unauthenticated despite a stored active account) and pruning that one account — never by issuing
// our own refresh call, which would duplicate the SDK's and re-create the "two refresh tokens in play"
// race. pruneAccount() also dispatches a synthetic storage event so the SDK re-evaluates remaining
// accounts in-session.
import { useEffect, useRef } from "react";
import { useProject } from "@agora-sdk/react-js";
import { useAuthStatus } from "./useAuthStatus";
import { readAccountMap, pruneAccount } from "./accountStorage";

/**
 * Mount this once inside `<ReplykeProvider>` (alongside the comment/thread UI) to prune a stale-only
 * session that left the user logged out. Prunes the active account only when the SDK settled
 * `unauthenticated` while a stored active account exists, and at most once per dead id.
 *
 * @example
 * function App() { useAuthSelfHeal(); return <Thread />; }
 */
export function useAuthSelfHeal(): void {
  const { projectId } = useProject();
  const { status } = useAuthStatus();
  const healedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (status !== "unauthenticated" || !projectId) return; // wait until the SDK has settled
    const map = readAccountMap(projectId);
    const activeId = map?.activeAccountId;
    if (!activeId || !map?.accounts[activeId]) return; // nothing stored to heal
    if (healedRef.current.has(activeId)) return; // already pruned this dead id once
    healedRef.current.add(activeId);
    pruneAccount(projectId, activeId);
  }, [status, projectId]);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/auth/react-js/src/useAuthSelfHeal.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/auth/react-js/src/useAuthSelfHeal.ts packages/auth/react-js/src/useAuthSelfHeal.test.tsx
git commit -m "feat(auth): useAuthSelfHeal — stale-account self-heal (P6)"
```

---

### Task 7: Barrel exports, build wiring, docs & housekeeping

**Files:**
- Create: `packages/auth/react-js/src/index.ts`
- Create: `packages/auth/react-js/README.md`
- Modify: `package.json` (root) — add the package to `build-all`, `version:patch`, `version:minor`, `publish-prod`, `publish-beta` script lists.
- Modify: `CHANGELOG.md` (root) — `[Unreleased] › Added` bullet.
- Modify: `CLAUDE.md` (root) — record the scoped `@agora-sdk/react-js` peer-dep exception + add the package to the layout list.
- Modify: `ARCHITECTURE.md` (root) — add the package to the package graph.

**Interfaces:**
- Consumes: every public symbol from Tasks 1–6.
- Produces: the package's public entry `@agora-sdk/auth-react-js`.

- [ ] **Step 1: Write the failing test** — `src/index.test.ts`

```ts
import { describe, expect, it } from "vitest";
import * as api from "./index";

describe("public API", () => {
  it("exports every hook + the component", () => {
    expect(typeof api.useOAuthCallback).toBe("function");
    expect(typeof api.OAuthCallbackHandler).toBe("function");
    expect(typeof api.useAuthStatus).toBe("function");
    expect(typeof api.useSignOutEverywhere).toBe("function");
    expect(typeof api.useAuthSelfHeal).toBe("function");
    // storage seam is exported for advanced consumers
    expect(typeof api.accountsStorageKey).toBe("function");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/auth/react-js/src/index.test.ts`
Expected: FAIL — `Cannot find module './index'`.

- [ ] **Step 3: Create `src/index.ts`**

```ts
// Public entry for @agora-sdk/auth-react-js — black-box OAuth callback + auth ergonomics for Agora
// SDK (Replyke fork) web apps. Runs inside <ReplykeProvider>; observes the SDK's auth state.
export { useOAuthCallback } from "./useOAuthCallback";
export type {
  OAuthCallbackStatus,
  UseOAuthCallbackOptions,
  UseOAuthCallbackReturn,
} from "./useOAuthCallback";

export { OAuthCallbackHandler } from "./OAuthCallbackHandler";
export type { OAuthCallbackHandlerProps } from "./OAuthCallbackHandler";

export { useAuthStatus } from "./useAuthStatus";
export type { AuthReadyStatus, UseAuthStatusReturn } from "./useAuthStatus";

export { useSignOutEverywhere } from "./useSignOutEverywhere";
export type { UseSignOutEverywhereReturn } from "./useSignOutEverywhere";

export { useAuthSelfHeal } from "./useAuthSelfHeal";

export {
  accountsStorageKey,
  readAccountMap,
  hasPersistedRefreshToken,
  pruneAccount,
} from "./accountStorage";
export type { AccountMap, AccountEntry, AccountSummary } from "./accountStorage";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/auth/react-js/src/index.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Write `README.md`** — the canonical MPA pattern (P7 docs)

````markdown
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
````

- [ ] **Step 6: Wire the package into the root `package.json` scripts**

In `package.json` (root), append `&& pnpm --filter @agora-sdk/auth-react-js run build` to the end of the `build-all` script value, and add `--filter @agora-sdk/auth-react-js` to the filter lists of `version:patch`, `version:minor`, `publish-prod`, and `publish-beta`. (Match the existing `&&`-chained / `--filter`-listed style exactly.)

- [ ] **Step 7: Add the CHANGELOG entry**

In `CHANGELOG.md` (root), under `## [Unreleased]` → `### Added`, add:

```markdown
- **`@agora-sdk/auth-react-js`** (new web package): black-box OAuth callback handling and auth
  ergonomics for Agora SDK (Replyke fork) web apps — `useOAuthCallback` / `OAuthCallbackHandler`
  (persistence-gated MPA redirect), `useAuthStatus` (auth-ready signal), `useSignOutEverywhere`
  (reliable full logout), `useAuthSelfHeal` (stale-account prune). First plus feature that peer-depends
  on `@agora-sdk/react-js` — a deliberate, scoped exception to the "no `@agora-sdk/core` dependency"
  rule (auth is *about* the SDK session). Answers `agora-sdk/docs/AUTH_IMPLEMENTATION.md` P1/P3/P4/P5/P6/P7.
```

- [ ] **Step 8: Record the scoped exception in `CLAUDE.md` + `ARCHITECTURE.md`**

In `CLAUDE.md` (root), in the package layout list under "## Architecture", add a row for
`packages/auth/react-js → @agora-sdk/auth-react-js` (web: OAuth callback + auth ergonomics; **peer-deps
`@agora-sdk/react-js`**), and add a one-paragraph note that this is the single deliberate exception to
the "no `@agora-sdk/core` dependency" invariant (auth is intrinsically about the SDK session;
secure-chat / social stay standalone). In `ARCHITECTURE.md`, add the package as a node in the package
graph with an edge `auth-react-js -->|peer-dep| @agora-sdk/react-js`.

- [ ] **Step 9: Full verification — typecheck, build, and the whole suite green**

Run: `pnpm run typecheck && pnpm --filter @agora-sdk/auth-react-js run build && pnpm test`
Expected: typecheck clean; `dist/esm` + `dist/cjs` (with `dist/cjs/package.json` `{"type":"commonjs"}`) produced; all auth tests + the existing suite PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/auth/react-js/src/index.ts packages/auth/react-js/src/index.test.ts \
  packages/auth/react-js/README.md package.json CHANGELOG.md CLAUDE.md ARCHITECTURE.md
git commit -m "feat(auth): public barrel, build wiring, README + housekeeping (P7)"
```

---

## Self-Review

**1. Spec coverage** (against `2026-06-27-auth-react-js-oauth-callback-design.md`):
- §3.1 package shape → Task 1 (package.json, tsconfigs, dual build) + Task 7 (root wiring). ✓
- §3.2 coupling model (observe via hooks; storage quarantined) → `accountStorage.ts` is the only storage module (Task 1); every hook consumes SDK hooks (Tasks 2–6). ✓
- §3.3 persistence gate (P1-emulated + P3) → Task 3. ✓
- §3.4 public API (`useOAuthCallback`, `OAuthCallbackHandler`, `useAuthStatus`, `useSignOutEverywhere`) → Tasks 3, 4, 2, 5; barrel in Task 7. ✓
- §3.5 P6 observe-the-outcome + guards (once-per-id, not while initializing) → Task 6. ✓
- §4 error handling (provider error, in-flight, timeout, stale-heal) → Task 3 tests (error/in-flight/timeout) + Task 6 (stale-heal). ✓
- §5 testing (jsdom, mock SDK hooks, all named cases) → tests in every task. ✓
- §6 module layout → matches Tasks 1–7 file list exactly. ✓
- §7 housekeeping (TSDoc, CHANGELOG, CLAUDE/ARCHITECTURE, README, root scripts) → Task 7. ✓
- §8 optional SDK JSDoc touch → explicitly excluded (noted in Global Constraints). ✓
- §9 future work → out of scope; not planned. ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to" — every code + test step carries complete content. ✓

**3. Type consistency:** `AccountMap`/`AccountEntry`/`AccountSummary` defined in Task 1 and reused verbatim in Tasks 2/3/6 and re-exported in Task 7. `OAuthCallbackStatus`/`UseOAuthCallbackOptions` defined in Task 3, consumed by Task 4's props and barrel. `AuthReadyStatus` defined in Task 2, consumed by Task 6 via `useAuthStatus`. `useSignOutEverywhere`/`useAuthSelfHeal`/`useAuthStatus`/`useOAuthCallback`/`OAuthCallbackHandler` names identical across definition, tests, and barrel. ✓
