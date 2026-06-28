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
