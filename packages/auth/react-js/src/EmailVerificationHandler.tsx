// Copy-paste drop-in for the /auth/verify-email route, over the useEmailVerification engine. Renders
// pending/success/error slots (with plain defaults) and fires onSuccess/onError.
import { useEffect } from "react";
import type { ReactNode } from "react";
import { useEmailVerification } from "./useEmailVerification.js";

/** Props for {@link EmailVerificationHandler}. */
export type EmailVerificationHandlerProps = {
  /** Full-page navigate here on success. Omit to render the `success` slot instead. */
  redirectTo?: string;
  /** Delay (ms) before the success redirect. Default 0. */
  redirectDelayMs?: number;
  /** Fired once verification succeeds. */
  onSuccess?: () => void;
  /** Fired with a user-facing message on failure. */
  onError?: (message: string) => void;
  /** Rendered while verifying. Defaults to "Verifying your email…". */
  pending?: ReactNode;
  /** Rendered on success (when not redirecting). Defaults to "Your email is verified." */
  success?: ReactNode;
  /** Rendered on error. Defaults to the message in a `<p>`. */
  error?: (message: string | null) => ReactNode;
};

/**
 * Drop-in email-verification page. Drives {@link useEmailVerification} and renders the three states.
 *
 * @param props - {@link EmailVerificationHandlerProps}
 * @example
 * // app route: /auth/verify-email
 * <EmailVerificationHandler redirectTo="/?verified=1" onError={(m) => toast(m)} />
 */
export function EmailVerificationHandler(props: EmailVerificationHandlerProps): JSX.Element {
  const { redirectTo, redirectDelayMs, onSuccess, onError, pending, success, error } = props;
  const { status, error: message } = useEmailVerification({ redirectTo, redirectDelayMs, onError });

  useEffect(() => {
    if (status === "success") onSuccess?.();
  }, [status, onSuccess]);

  if (status === "error") return <>{error ? error(message) : <p role="alert">{message}</p>}</>;
  if (status === "success") return <>{success ?? <p>Your email is verified.</p>}</>;
  return <>{pending ?? <p>Verifying your email…</p>}</>;
}
