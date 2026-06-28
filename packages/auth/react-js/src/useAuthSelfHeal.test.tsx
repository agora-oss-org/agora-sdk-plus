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
