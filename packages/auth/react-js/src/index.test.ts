import { describe, expect, it, vi } from "vitest";

// The real @agora-sdk/react-js is bundler-only (its CJS output isn't natively loadable by Node/vitest;
// see agora-sdk docs/KNOWN_ISSUES.md). Mock the SDK boundary so the barrel can be imported under the
// test runner — consumers bundle in production, where react-js resolves via its ESM entry.
vi.mock("@agora-sdk/react-js", () => ({
  useOAuthSignIn: vi.fn(),
  useAuth: vi.fn(),
  useUser: vi.fn(),
  useProject: vi.fn(),
  useSignOutAll: vi.fn(),
  useVerifyEmail: vi.fn(),
  getApiBaseUrl: vi.fn(),
}));

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

  it("exports the email-link handlers", () => {
    expect(typeof api.useEmailVerification).toBe("function");
    expect(typeof api.EmailVerificationHandler).toBe("function");
    expect(typeof api.usePasswordReset).toBe("function");
    expect(typeof api.PasswordResetHandler).toBe("function");
    expect(typeof api.useResendVerification).toBe("function");
    expect(typeof api.ResendVerificationButton).toBe("function");
  });
});
