// Web `SecureChatCrypto` — the real ts-mls MLS core (Phase 2).
//
// Wires the concrete RFC 9420 implementation from @agora-sdk/secure-chat-crypto/ts-mls. All MLS crypto
// runs client-side behind the seam; the server only ever relays opaque base64 blobs. For tests / early
// UI work, inject `MockSecureChatCrypto` from `@agora-sdk/secure-chat-crypto/testing` instead.
import type { SecureChatCrypto } from "@agora-sdk/secure-chat-core";
import {
  createTsMlsSecureChatCrypto,
  type TsMlsSecureChatCryptoOptions,
} from "@agora-sdk/secure-chat-crypto/ts-mls";

/**
 * Create the web `SecureChatCrypto` (real ts-mls MLS core) for `<SecureChatProvider crypto={…}>`.
 *
 * @param options - Optional {@link TsMlsSecureChatCryptoOptions} (ciphersuite, `keyRetention` window).
 * @returns A ready ts-mls-backed `SecureChatCrypto`.
 * @example
 * ```tsx
 * <SecureChatProvider crypto={createWebSecureChatCrypto()} …>
 * ```
 */
export function createWebSecureChatCrypto(
  options?: TsMlsSecureChatCryptoOptions
): SecureChatCrypto {
  return createTsMlsSecureChatCrypto(options);
}
