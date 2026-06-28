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
