// Small drop-in button over useResendVerification: click to resend, disabled while sending, shows a
// "Sent"/error state. Deliberately tiny — its value is the disable-and-status wiring, not layout.
import { useEffect } from "react";
import type { ReactNode } from "react";
import { useResendVerification } from "./useResendVerification.js";

/** Props for {@link ResendVerificationButton}. */
export type ResendVerificationButtonProps = {
  /** The address to resend the confirmation email to. */
  email: string;
  /** Button label in the idle state. Defaults to "Resend verification email". */
  children?: ReactNode;
  /** Fired once the email is sent. */
  onSent?: () => void;
  /** Fired with a user-facing message on failure. */
  onError?: (message: string) => void;
  /** Optional class on the wrapping element. */
  className?: string;
};

/**
 * A resend-verification button with built-in sending/sent/error state.
 *
 * @param props - {@link ResendVerificationButtonProps}
 * @example
 * <ResendVerificationButton email={user.email} onSent={() => toast("Sent!")} />
 */
export function ResendVerificationButton(props: ResendVerificationButtonProps): JSX.Element {
  const { email, children, onSent, onError, className } = props;
  const { resend, status, error } = useResendVerification();

  useEffect(() => {
    if (status === "sent") onSent?.();
    if (status === "error" && error) onError?.(error);
  }, [status, error, onSent, onError]);

  return (
    <span className={className}>
      <button type="button" onClick={() => void resend(email)} disabled={status === "sending"}>
        {status === "sending" ? "Sending…" : status === "sent" ? "Sent" : children ?? "Resend verification email"}
      </button>
      {status === "error" && (
        <span className="agora-resend-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
