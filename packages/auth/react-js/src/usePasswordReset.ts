// Drop-in engine for the emailed /auth/reset-password landing page. Parses the token from the URL
// (fail-closed on projectId mismatch), then submit(newPassword) POSTs { token, newPassword } to the
// blind server's reset endpoint. We POST directly via the SDK's public getApiBaseUrl() — the same
// pattern react-js's PushTokenAdapter uses — because core has no reset-password hook. The endpoint is
// intentionally unauthenticated (a recovery flow). The token and password are never logged.
import { useEffect, useRef, useState } from "react";
import { useProject, getApiBaseUrl } from "@agora-sdk/react-js";
import { parseAuthLink, stripTokenFromUrl } from "./parseAuthLink.js";

/** Lifecycle of the reset-password page. `invalid-link` means the landing link was bad; hide the form. */
export type PasswordResetStatus = "ready" | "submitting" | "success" | "error" | "invalid-link";

/** Options for {@link usePasswordReset}. */
export type UsePasswordResetOptions = {
  /** Full-page navigate here on success (e.g. your sign-in page). */
  redirectTo?: string;
  /** Delay (ms) before the success redirect. Default 0. */
  redirectDelayMs?: number;
  /** Minimum new-password length enforced client-side. Default 8 (the server enforces 8..128). */
  minLength?: number;
  /** Called with a user-facing message on failure. */
  onError?: (message: string) => void;
};

/** Return value of {@link usePasswordReset}. */
export type UsePasswordResetReturn = {
  /** Current {@link PasswordResetStatus}. */
  status: PasswordResetStatus;
  /** User-facing error, or null. Never contains the token or password. */
  error: string | null;
  /** Submit a new password for the token in the URL. No-op if the link was invalid. */
  submit: (newPassword: string) => Promise<void>;
};

/**
 * Drive the emailed password-reset landing page: parse the token once (fail-closed on projectId
 * mismatch → `invalid-link`), then `submit(newPassword)` to set the new password and optionally redirect.
 *
 * @param options - {@link UsePasswordResetOptions}
 * @returns {@link UsePasswordResetReturn} — status, error, and the `submit` action.
 * @example
 * const { status, error, submit } = usePasswordReset({ redirectTo: "/signin" });
 * if (status === "invalid-link") return <p>{error}</p>;
 * // render your own form and call submit(password)
 */
export function usePasswordReset(options: UsePasswordResetOptions = {}): UsePasswordResetReturn {
  const { redirectTo, redirectDelayMs = 0, minLength = 8, onError } = options;
  const { projectId } = useProject();

  const [status, setStatus] = useState<PasswordResetStatus>("ready");
  const [error, setError] = useState<string | null>(null);
  const tokenRef = useRef<string | null>(null);
  const parsedRef = useRef(false);

  useEffect(() => {
    if (parsedRef.current || !projectId) return;
    parsedRef.current = true;
    const link = parseAuthLink(projectId);
    if (!link.ok) {
      setError(
        link.reason === "project-mismatch"
          ? "This link was issued for a different site."
          : "This link is missing its reset token."
      );
      setStatus("invalid-link");
      return;
    }
    tokenRef.current = link.token;
  }, [projectId]);

  const submit = async (newPassword: string): Promise<void> => {
    const token = tokenRef.current;
    if (!token || !projectId) {
      setStatus("invalid-link");
      return;
    }
    if (newPassword.length < minLength) {
      const m = `Use at least ${minLength} characters.`;
      setError(m);
      setStatus("error");
      onError?.(m);
      return;
    }
    setStatus("submitting");
    setError(null);
    try {
      const res = await fetch(`${getApiBaseUrl()}/${projectId}/auth/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const m =
          body && typeof body.error === "string" && body.error
            ? body.error
            : "This reset link is no longer valid.";
        setError(m);
        setStatus("error");
        onError?.(m);
        return;
      }
      stripTokenFromUrl();
      setStatus("success");
      if (redirectTo) {
        window.setTimeout(() => window.location.replace(redirectTo), redirectDelayMs);
      }
    } catch {
      const m = "Couldn't reach the server. Please try again.";
      setError(m);
      setStatus("error");
      onError?.(m);
    }
  };

  return { status, error, submit };
}
