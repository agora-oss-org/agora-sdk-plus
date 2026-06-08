// @agora-sdk/secure-chat-crypto/ts-mls — the real RFC 9420 MLS core (ESM-only; pulls in ts-mls).
//
// Opt-in subpath so the heavy core is loaded ONLY by consumers that import it; the bare entry
// (interface) and ./testing (mock) stay dependency-free. ESM-only because ts-mls is ESM-only.
import { TsMlsSecureChatCrypto, type TsMlsSecureChatCryptoOptions } from "./crypto.js";
import type { SecureChatCrypto } from "../interface.js";

export { TsMlsSecureChatCrypto, type TsMlsSecureChatCryptoOptions } from "./crypto.js";

/**
 * Create the real ts-mls {@link SecureChatCrypto} for injection into `<SecureChatProvider crypto={…}>`.
 *
 * @param options - {@link TsMlsSecureChatCryptoOptions}; defaults to ciphersuite 1.
 * @returns A ready `SecureChatCrypto` backed by ts-mls.
 * @example
 * ```ts
 * import { createTsMlsSecureChatCrypto } from "@agora-sdk/secure-chat-crypto/ts-mls";
 * const crypto = createTsMlsSecureChatCrypto();
 * ```
 */
export function createTsMlsSecureChatCrypto(options?: TsMlsSecureChatCryptoOptions): SecureChatCrypto {
  return new TsMlsSecureChatCrypto(options);
}
