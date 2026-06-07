// @agora-sdk/secure-chat-core — platform-agnostic client for Agora end-to-end-encrypted chat.
//
// Transport (REST + /secure socket) + provider/hooks, with MLS crypto supplied by dependency
// injection of a `SecureChatCrypto`. Platform packages (@agora-sdk/secure-chat-react-js, etc.)
// re-export this and add the concrete crypto + persistence.

// ── context / provider ──────────────────────────────────────────────────────
export { SecureChatProvider, useSecureChat } from "./context/secure-chat-context";
export type {
  SecureChatProviderProps,
  SecureChatContextValue,
} from "./context/secure-chat-context";

// ── hooks ────────────────────────────────────────────────────────────────────
export { useSecureDevice } from "./hooks/useSecureDevice";
export type { UseSecureDeviceOptions, UseSecureDeviceValues } from "./hooks/useSecureDevice";
export { useSecureConversations } from "./hooks/useSecureConversations";
export type { UseSecureConversationsValues } from "./hooks/useSecureConversations";
export { useSecureMessages } from "./hooks/useSecureMessages";
export type {
  UseSecureMessagesOptions,
  UseSecureMessagesValues,
  DecryptedSecureMessage,
} from "./hooks/useSecureMessages";

// ── transport (for advanced / non-React use) ─────────────────────────────────
export { SecureChatRestClient } from "./transport/rest";
export type { SecureChatRestConfig } from "./transport/rest";
export { SecureChatSocketClient } from "./transport/socket";
export type {
  SecureSocket,
  SecureServerEvents,
  SecureClientEvents,
  SecureChatSocketConfig,
} from "./transport/socket";

// ── crypto seam (re-exported from @agora-sdk/secure-chat-crypto, the seam's home) ──
export type {
  SecureChatCrypto,
  DeviceIdentity,
  KeyPackageBundle,
  GroupHandle,
  TargetedWelcome,
  CommitResult,
  PassphraseBackup,
} from "@agora-sdk/secure-chat-crypto";

// ── wire contract types (transitional — see ./contract) ──────────────────────
export type * from "./contract";

// ── utils ────────────────────────────────────────────────────────────────────
export { toBase64, fromBase64, utf8ToBytes, bytesToUtf8 } from "./util/base64";
