// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, renderHook, screen, waitFor } from "@testing-library/react";

vi.mock("@agora-sdk/react-js", () => ({
  useProject: vi.fn(),
  useVerifyEmail: vi.fn(),
}));

import { useProject, useVerifyEmail } from "@agora-sdk/react-js";
import { useEmailVerification } from "./useEmailVerification";
import { EmailVerificationHandler } from "./EmailVerificationHandler";

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
