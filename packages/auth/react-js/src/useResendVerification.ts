// Resend-confirmation action ("Didn't get the email?"). Not a landing page. We POST directly via the
// SDK's public getApiBaseUrl() with { email, emailRedirectTo } — core's useSendVerificationEmail omits
// the `email` the server's emailSchema requires, so wrapping it would 400. emailRedirectTo comes from
// getEmailRedirectTo() (same resolution chain sign-up / password-reset-request use: an env-var-style
// override, then window.location.origin) — @agora-sdk/core >=1.7.0 required, since this export didn't
// exist before.
import { useState } from "react";
import { useProject, getApiBaseUrl, getEmailRedirectTo } from "@agora-sdk/react-js";

/** Lifecycle of a resend action. */
export type ResendStatus = "idle" | "sending" | "sent" | "error";

/** Return value of {@link useResendVerification}. */
export type UseResendVerificationReturn = {
  /** Request a fresh confirmation email for `email`. */
  resend: (email: string) => Promise<void>;
  /** Current {@link ResendStatus}. */
  status: ResendStatus;
  /** User-facing error, or null. */
  error: string | null;
};

/**
 * Resend the email-verification link for an address.
 *
 * @returns {@link UseResendVerificationReturn} — the `resend` action plus status/error.
 * @example
 * const { resend, status } = useResendVerification();
 * <button disabled={status === "sending"} onClick={() => void resend(email)}>Resend</button>
 */
export function useResendVerification(): UseResendVerificationReturn {
  const { projectId } = useProject();
  const [status, setStatus] = useState<ResendStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const resend = async (email: string): Promise<void> => {
    if (!projectId) {
      setError("Not ready yet. Please try again.");
      setStatus("error");
      return;
    }
    const trimmed = email.trim();
    if (!trimmed) {
      setError("Enter your email address.");
      setStatus("error");
      return;
    }
    setStatus("sending");
    setError(null);
    const emailRedirectTo = getEmailRedirectTo();
    try {
      const res = await fetch(`${getApiBaseUrl()}/${projectId}/auth/send-verification-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed, ...(emailRedirectTo ? { emailRedirectTo } : {}) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const m =
          body && typeof body.error === "string" && body.error
            ? body.error
            : "Couldn't send the email. Please try again.";
        setError(m);
        setStatus("error");
        return;
      }
      setStatus("sent");
    } catch {
      setError("Couldn't reach the server. Please try again.");
      setStatus("error");
    }
  };

  return { resend, status, error };
}
