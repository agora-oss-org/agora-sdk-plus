// Public entry for @agora-sdk/auth-react-js — black-box OAuth callback + auth ergonomics for Agora
// SDK (Replyke fork) web apps. Runs inside <ReplykeProvider>; observes the SDK's auth state.
export { useOAuthCallback } from "./useOAuthCallback.js";
export type {
  OAuthCallbackStatus,
  UseOAuthCallbackOptions,
  UseOAuthCallbackReturn,
} from "./useOAuthCallback.js";

export { OAuthCallbackHandler } from "./OAuthCallbackHandler.js";
export type { OAuthCallbackHandlerProps } from "./OAuthCallbackHandler.js";

export { useAuthStatus } from "./useAuthStatus.js";
export type { AuthReadyStatus, UseAuthStatusReturn } from "./useAuthStatus.js";

export { useSignOutEverywhere } from "./useSignOutEverywhere.js";
export type { UseSignOutEverywhereReturn } from "./useSignOutEverywhere.js";

export { useAuthSelfHeal } from "./useAuthSelfHeal.js";

export {
  accountsStorageKey,
  readAccountMap,
  readActiveAccount,
  hasPersistedRefreshToken,
  pruneAccount,
  pruneAllAccounts,
} from "./accountStorage.js";
export type { AccountMap, AccountEntry, AccountSummary } from "./accountStorage.js";

// Email-link handlers: drop-ins for the server's emailed /auth/verify-email + /auth/reset-password
// landing pages (+ a resend action), mirroring the OAuth callback pair above.
export { useEmailVerification } from "./useEmailVerification.js";
export type {
  EmailVerificationStatus,
  UseEmailVerificationOptions,
  UseEmailVerificationReturn,
} from "./useEmailVerification.js";
export { EmailVerificationHandler } from "./EmailVerificationHandler.js";
export type { EmailVerificationHandlerProps } from "./EmailVerificationHandler.js";

export { usePasswordReset } from "./usePasswordReset.js";
export type {
  PasswordResetStatus,
  UsePasswordResetOptions,
  UsePasswordResetReturn,
} from "./usePasswordReset.js";
export { PasswordResetHandler } from "./PasswordResetHandler.js";
export type { PasswordResetHandlerProps } from "./PasswordResetHandler.js";

export { useResendVerification } from "./useResendVerification.js";
export type { ResendStatus, UseResendVerificationReturn } from "./useResendVerification.js";
export { ResendVerificationButton } from "./ResendVerificationButton.js";
export type { ResendVerificationButtonProps } from "./ResendVerificationButton.js";
