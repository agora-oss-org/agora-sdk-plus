// P3 — a copy-paste drop-in for the MPA callback route, over the useOAuthCallback engine. Integrators
// who don't want to wire status themselves render this and pass onSuccess/onError/redirectTo.
import { useEffect } from "react";
import type { ReactNode } from "react";
import { useOAuthCallback } from "./useOAuthCallback.js";

/** Props for {@link OAuthCallbackHandler}. */
export type OAuthCallbackHandlerProps = {
  /** Where to navigate once the session is truly persisted. */
  redirectTo: string;
  /** Fired once the session is persisted (just before navigation). */
  onSuccess?: () => void;
  /** Fired with the provider error message on failure. */
  onError?: (message: string | null) => void;
  /** Fired if persistence never lands within `timeoutMs`. */
  onTimeout?: () => void;
  /** How long to wait for persistence before `onTimeout`. Default 15000ms. */
  timeoutMs?: number;
  /** Rendered while waiting. Defaults to nothing. */
  pending?: ReactNode;
  /** Rendered on error. Defaults to nothing. */
  error?: (message: string | null) => ReactNode;
};

/**
 * Drop-in OAuth callback page. Drives {@link useOAuthCallback} and renders pending/error slots,
 * firing `onSuccess` / `onError` / `onTimeout` callbacks.
 *
 * @param props - {@link OAuthCallbackHandlerProps}
 * @example
 * <OAuthCallbackHandler redirectTo="/" onError={(m) => toast(m)} pending={<Spinner/>} />
 */
export function OAuthCallbackHandler(props: OAuthCallbackHandlerProps): JSX.Element {
  const { redirectTo, onSuccess, onError, onTimeout, timeoutMs, pending, error } = props;
  const { status, error: message } = useOAuthCallback({ redirectTo, onTimeout, timeoutMs });

  useEffect(() => {
    if (status === "success") onSuccess?.();
    if (status === "error") onError?.(message);
  }, [status, message, onSuccess, onError]);

  if (status === "error") return <>{error ? error(message) : null}</>;
  return <>{status === "pending" ? pending ?? null : null}</>;
}
