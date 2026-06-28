// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

vi.mock("@agora-sdk/react-js", () => ({
  useOAuthSignIn: vi.fn(),
  useProject: vi.fn(),
}));

import { useOAuthSignIn, useProject } from "@agora-sdk/react-js";
import { useOAuthCallback } from "./useOAuthCallback";
import { readAccountMap } from "./accountStorage";

const mockOAuth = useOAuthSignIn as unknown as ReturnType<typeof vi.fn>;
const mockProject = useProject as unknown as ReturnType<typeof vi.fn>;

const KEY = "replyke-accounts:p1";
let replace: ReturnType<typeof vi.fn>;

/** Write `userId` as the active account with the given refresh-token expiry. */
function persist(userId: string, tokenExpiresAt = 0) {
  localStorage.setItem(
    KEY,
    JSON.stringify({
      activeAccountId: userId,
      accounts: {
        ...readAccountMap("p1")?.accounts,
        [userId]: { refreshToken: `rt-${userId}-${tokenExpiresAt}`, tokenExpiresAt, user: { id: userId, name: null, email: null, avatar: null } },
      },
    })
  );
}

/** Advance enough fake time for several poll ticks to run. */
function pump(ms = 300) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  replace = vi.fn();
  Object.defineProperty(window, "location", { value: { replace, pathname: "/auth/callback" }, writable: true });
  mockProject.mockReturnValue({ projectId: "p1" });
  mockOAuth.mockReturnValue({ handleOAuthCallback: vi.fn(() => true), error: null });
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("useOAuthCallback", () => {
  it("parses the callback exactly once on mount", () => {
    const parse = vi.fn(() => true);
    mockOAuth.mockReturnValue({ handleOAuthCallback: parse, error: null });
    const { rerender } = renderHook(() => useOAuthCallback({ redirectTo: "/" }));
    rerender();
    rerender();
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("stays pending and does NOT navigate while nothing is persisted", () => {
    const { result } = renderHook(() => useOAuthCallback({ redirectTo: "/" }));
    pump();
    expect(result.current.status).toBe("pending");
    expect(replace).not.toHaveBeenCalled();
  });

  it("navigates once a FRESH account is persisted after mount", () => {
    const { result } = renderHook(() => useOAuthCallback({ redirectTo: "/#comments" }));
    pump(); // nothing yet
    expect(replace).not.toHaveBeenCalled();
    act(() => persist("u1", 1000)); // useAccountSync lands the fresh row
    pump();
    expect(result.current.status).toBe("success");
    expect(replace).toHaveBeenCalledWith("/#comments");
  });

  it("does NOT navigate for a pre-existing (unchanged) account — that's the stale boot state", () => {
    persist("stale", 500); // present BEFORE mount → it's the prior/active account, not a fresh login
    const { result } = renderHook(() => useOAuthCallback({ redirectTo: "/" }));
    pump();
    expect(result.current.status).toBe("pending");
    expect(replace).not.toHaveBeenCalled();
  });

  // A8: the stale active account's boot-refresh clobbers in-store auth, but the persisted row for the
  // NEW account is correct. The gate must navigate off the persisted row, not volatile store state.
  it("A8: navigates when a DIFFERENT fresh account replaces a stale active one (store irrelevant)", () => {
    persist("stale", 500); // stale account active at boot
    const { result } = renderHook(() => useOAuthCallback({ redirectTo: "/" }));
    pump();
    expect(replace).not.toHaveBeenCalled(); // still only the stale account
    act(() => persist("fresh", 2000)); // fresh OAuth account becomes active + persisted
    pump();
    expect(result.current.status).toBe("success");
    expect(replace).toHaveBeenCalledWith("/");
  });

  it("navigates on a same-user re-login (active id unchanged, token expiry advanced)", () => {
    persist("u1", 500); // prior session for the same user
    const { result } = renderHook(() => useOAuthCallback({ redirectTo: "/" }));
    pump();
    expect(replace).not.toHaveBeenCalled();
    act(() => persist("u1", 9999)); // fresh login mints a later-expiry token for the same id
    pump();
    expect(result.current.status).toBe("success");
    expect(replace).toHaveBeenCalledWith("/");
  });

  it("surfaces a provider error and does not navigate", () => {
    mockOAuth.mockReturnValue({ handleOAuthCallback: vi.fn(() => false), error: "access_denied" });
    const { result } = renderHook(() => useOAuthCallback({ redirectTo: "/" }));
    pump();
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("access_denied");
    expect(replace).not.toHaveBeenCalled();
  });

  it("fires onTimeout if a fresh session never persists", () => {
    const onTimeout = vi.fn();
    renderHook(() => useOAuthCallback({ redirectTo: "/", onTimeout, timeoutMs: 5000 }));
    act(() => vi.advanceTimersByTime(5000));
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
  });

  it("pruneStaleOnMount clears pre-existing accounts so the fresh login is unambiguous", () => {
    persist("stale", 500); // a stale account present at boot
    const { result } = renderHook(() =>
      useOAuthCallback({ redirectTo: "/", pruneStaleOnMount: true })
    );
    // pruned on mount → no accounts remain
    expect(readAccountMap("p1")?.accounts.stale).toBeUndefined();
    act(() => persist("fresh", 2000));
    pump();
    expect(result.current.status).toBe("success");
    expect(replace).toHaveBeenCalledWith("/");
  });
});
