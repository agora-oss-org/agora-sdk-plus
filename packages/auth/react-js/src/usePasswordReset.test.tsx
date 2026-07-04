// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";

vi.mock("@agora-sdk/react-js", () => ({
  useProject: vi.fn(),
  getApiBaseUrl: vi.fn(() => "https://api.test/v7"),
}));

import { useProject } from "@agora-sdk/react-js";
import { usePasswordReset } from "./usePasswordReset";
import { PasswordResetHandler } from "./PasswordResetHandler";

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
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

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

describe("PasswordResetHandler", () => {
  it("shows a mismatch error without submitting", () => {
    render(<PasswordResetHandler />);
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "a-good-password" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "different" } });
    fireEvent.click(screen.getByRole("button", { name: /reset password/i }));
    expect(screen.getByText(/don't match/i)).toBeTruthy();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("submits matching passwords and shows success", async () => {
    render(<PasswordResetHandler />);
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "a-good-password" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "a-good-password" } });
    fireEvent.click(screen.getByRole("button", { name: /reset password/i }));
    await screen.findByText(/your password has been reset/i);
  });

  it("renders the invalid-link slot on a bad landing link", () => {
    setUrl("?projectId=OTHER&token=rtok");
    render(<PasswordResetHandler />);
    expect(screen.getByText(/different site/i)).toBeTruthy();
  });
});
