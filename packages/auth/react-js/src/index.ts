// Public entry for @agora-sdk/auth-react-js — black-box OAuth callback + auth ergonomics for Agora
// SDK (Replyke fork) web apps. Runs inside <ReplykeProvider>; observes the SDK's auth state.
export { useOAuthCallback } from "./useOAuthCallback";
export type {
  OAuthCallbackStatus,
  UseOAuthCallbackOptions,
  UseOAuthCallbackReturn,
} from "./useOAuthCallback";

export { OAuthCallbackHandler } from "./OAuthCallbackHandler";
export type { OAuthCallbackHandlerProps } from "./OAuthCallbackHandler";

export { useAuthStatus } from "./useAuthStatus";
export type { AuthReadyStatus, UseAuthStatusReturn } from "./useAuthStatus";

export { useSignOutEverywhere } from "./useSignOutEverywhere";
export type { UseSignOutEverywhereReturn } from "./useSignOutEverywhere";

export { useAuthSelfHeal } from "./useAuthSelfHeal";

export {
  accountsStorageKey,
  readAccountMap,
  readActiveAccount,
  hasPersistedRefreshToken,
  pruneAccount,
  pruneAllAccounts,
} from "./accountStorage";
export type { AccountMap, AccountEntry, AccountSummary } from "./accountStorage";

// Email-link handlers: drop-ins for the server's emailed /auth/verify-email + /auth/reset-password
// landing pages (+ a resend action), mirroring the OAuth callback pair above.
export { useEmailVerification } from "./useEmailVerification";
export type {
  EmailVerificationStatus,
  UseEmailVerificationOptions,
  UseEmailVerificationReturn,
} from "./useEmailVerification";
export { EmailVerificationHandler } from "./EmailVerificationHandler";
export type { EmailVerificationHandlerProps } from "./EmailVerificationHandler";

export { usePasswordReset } from "./usePasswordReset";
export type {
  PasswordResetStatus,
  UsePasswordResetOptions,
  UsePasswordResetReturn,
} from "./usePasswordReset";
export { PasswordResetHandler } from "./PasswordResetHandler";
export type { PasswordResetHandlerProps } from "./PasswordResetHandler";

export { useResendVerification } from "./useResendVerification";
export type { ResendStatus, UseResendVerificationReturn } from "./useResendVerification";
export { ResendVerificationButton } from "./ResendVerificationButton";
export type { ResendVerificationButtonProps } from "./ResendVerificationButton";
