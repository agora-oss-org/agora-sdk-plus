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
