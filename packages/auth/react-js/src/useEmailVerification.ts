// Drop-in engine for the emailed /auth/verify-email landing page. Reads the token from the URL, fails
// closed if the link was minted for another project, calls the SDK's useVerifyEmail, then strips the
// token from the URL and (optionally) redirects. Mirrors useOAuthCallback's one-shot, ref-guarded shape.
import { useEffect, useRef, useState } from "react";
import { useProject, useVerifyEmail } from "@agora-sdk/react-js";
import { parseAuthLink, stripTokenFromUrl } from "./parseAuthLink.js";

/** Lifecycle of the verify-email page. */
export type EmailVerificationStatus = "pending" | "success" | "error";

/** Options for {@link useEmailVerification}. */
export type UseEmailVerificationOptions = {
  /** Full-page navigate here on success. Omit to stay on the page and show a success state. */
  redirectTo?: string;
  /** Delay (ms) before the success redirect. Default 0. */
  redirectDelayMs?: number;
  /** Called with a user-facing message on any failure (bad link or server rejection). */
  onError?: (message: string) => void;
};

/** Return value of {@link useEmailVerification}. */
export type UseEmailVerificationReturn = {
  /** `pending` while verifying; `success` once verified; `error` on a bad link or server rejection. */
  status: EmailVerificationStatus;
  /** User-facing error message when `status === "error"`. Never contains the token. */
  error: string | null;
};

const LINK_ERROR: Record<"missing-token" | "project-mismatch", string> = {
  "missing-token": "This link is missing its verification token.",
  "project-mismatch": "This link was issued for a different site.",
};

/**
 * Drive the emailed email-verification landing page: parse the token once, verify it via the SDK, then
 * strip the token from the URL and optionally redirect. Fails closed when the link's projectId differs
 * from the provider's (no network call).
 *
 * @param options - {@link UseEmailVerificationOptions}
 * @returns the {@link EmailVerificationStatus} and any user-facing error.
 * @example
 * function VerifyEmailPage() {
 *   const { status, error } = useEmailVerification({ redirectTo: "/?verified=1" });
 *   if (status === "error") return <p>{error}</p>;
 *   return <Spinner />;
 * }
 */
export function useEmailVerification(
  options: UseEmailVerificationOptions = {}
): UseEmailVerificationReturn {
  const { redirectTo, redirectDelayMs = 0, onError } = options;
  const { projectId } = useProject();
  const verifyEmail = useVerifyEmail();

  const [status, setStatus] = useState<EmailVerificationStatus>("pending");
  const [error, setError] = useState<string | null>(null);
  const ranRef = useRef(false);

  useEffect(() => {
    // Wait for the provider's projectId — the fail-closed guard needs it. Run exactly once (StrictMode).
    if (ranRef.current || !projectId) return;
    ranRef.current = true;

    const fail = (message: string) => {
      setError(message);
      setStatus("error");
      onError?.(message);
    };

    const link = parseAuthLink(projectId);
    if (!link.ok) {
      fail(LINK_ERROR[link.reason]);
      return;
    }

    verifyEmail({ token: link.token })
      .then(() => {
        stripTokenFromUrl();
        setStatus("success");
        if (redirectTo) {
          window.setTimeout(() => window.location.replace(redirectTo), redirectDelayMs);
        }
      })
      .catch((e: unknown) => {
        // Surface only the server/user-facing message — never the token.
        fail(e instanceof Error && e.message ? e.message : "This link is no longer valid.");
      });
  }, [projectId, verifyEmail, redirectTo, redirectDelayMs, onError]);

  return { status, error };
}
