// Copy-paste drop-in for the /auth/reset-password route, over the usePasswordReset engine. Ships a
// minimal, unstyled new-password form (new + confirm, client-side match/length checks) with stable
// classNames for the app's CSS, plus a renderForm escape hatch for a fully custom UI.
import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { usePasswordReset } from "./usePasswordReset.js";
import type { UsePasswordResetReturn } from "./usePasswordReset.js";

/** Props for {@link PasswordResetHandler}. */
export type PasswordResetHandlerProps = {
  /** Full-page navigate here on success. */
  redirectTo?: string;
  /** Delay (ms) before the success redirect. Default 0. */
  redirectDelayMs?: number;
  /** Minimum password length. Default 8. */
  minLength?: number;
  /** Fired once the reset succeeds. */
  onSuccess?: () => void;
  /** Fired with a user-facing message on failure. */
  onError?: (message: string) => void;
  /** Rendered on success. Defaults to "Your password has been reset." */
  success?: ReactNode;
  /** Rendered when the landing link is invalid. Defaults to the message in a `<p>`. */
  invalidLink?: (message: string | null) => ReactNode;
  /** Replace the default form entirely; receives the hook's `{ status, error, submit }`. */
  renderForm?: (api: UsePasswordResetReturn) => ReactNode;
};

/**
 * Drop-in password-reset page with a minimal default form.
 *
 * @param props - {@link PasswordResetHandlerProps}
 * @example
 * // app route: /auth/reset-password
 * <PasswordResetHandler redirectTo="/signin?reset=1" />
 */
export function PasswordResetHandler(props: PasswordResetHandlerProps): JSX.Element {
  const { redirectTo, redirectDelayMs, minLength = 8, onSuccess, onError, success, invalidLink, renderForm } = props;
  const api = usePasswordReset({ redirectTo, redirectDelayMs, minLength, onError });
  const { status, error, submit } = api;

  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (status === "success") onSuccess?.();
  }, [status, onSuccess]);

  if (status === "success") return <>{success ?? <p>Your password has been reset.</p>}</>;
  if (status === "invalid-link") return <>{invalidLink ? invalidLink(error) : <p role="alert">{error}</p>}</>;
  if (renderForm) return <>{renderForm(api)}</>;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    if (pw !== confirm) {
      setLocalError("Passwords don't match.");
      return;
    }
    if (pw.length < minLength) {
      setLocalError(`Use at least ${minLength} characters.`);
      return;
    }
    void submit(pw);
  };

  return (
    <form className="agora-password-reset" onSubmit={onSubmit}>
      <label className="agora-password-reset-field" htmlFor="agora-password-reset-new">
        New password
      </label>
      <input
        id="agora-password-reset-new"
        type="password"
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        autoComplete="new-password"
        minLength={minLength}
        required
      />
      <label className="agora-password-reset-field" htmlFor="agora-password-reset-confirm">
        Confirm password
      </label>
      <input
        id="agora-password-reset-confirm"
        type="password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        autoComplete="new-password"
        required
      />
      {(localError ?? error) && (
        <p className="agora-password-reset-error" role="alert">
          {localError ?? error}
        </p>
      )}
      <button type="submit" disabled={status === "submitting"}>
        {status === "submitting" ? "Resetting…" : "Reset password"}
      </button>
    </form>
  );
}
