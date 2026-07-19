// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("@agora-sdk/react-js", () => ({
  useAuth: vi.fn(),
  useUser: vi.fn(),
  useProject: vi.fn(),
}));

import { useAuth, useUser, useProject } from "@agora-sdk/react-js";
import { useAuthStatus } from "./useAuthStatus.js";

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
