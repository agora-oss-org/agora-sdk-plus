// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";

vi.mock("@agora-sdk/react-js", () => ({
  useProject: vi.fn(),
  getApiBaseUrl: vi.fn(() => "https://api.test/v7"),
  getEmailRedirectTo: vi.fn(() => "https://app.test"),
}));

import { useProject } from "@agora-sdk/react-js";
import { useResendVerification } from "./useResendVerification.js";
import { ResendVerificationButton } from "./ResendVerificationButton.js";

const mockProject = useProject as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockProject.mockReturnValue({ projectId: "p1" });
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

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

describe("ResendVerificationButton", () => {
  it("resends on click and shows Sent, firing onSent", async () => {
    const onSent = vi.fn();
    render(<ResendVerificationButton email="user@test.dev" onSent={onSent} />);
    fireEvent.click(screen.getByRole("button"));
    await screen.findByRole("button", { name: /sent/i });
    expect(onSent).toHaveBeenCalled();
  });
});
