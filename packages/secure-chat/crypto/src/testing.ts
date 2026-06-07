// @agora-sdk/secure-chat-crypto/testing — the deterministic mock, kept off the main entry.
//
// NOT cryptographically secure. Use it in tests and early UI work (and the agora-server integration
// suite consumes it from here). Never ship it as production crypto.
export { MockSecureChatCrypto } from "./mock-crypto.js";
