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
  hasPersistedRefreshToken,
  pruneAccount,
} from "./accountStorage";
export type { AccountMap, AccountEntry, AccountSummary } from "./accountStorage";
