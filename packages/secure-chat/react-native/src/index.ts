// @agora-sdk/secure-chat-react-native — bare React Native bindings for Agora secure chat.
//
// Phase 3 (stub). Re-exports the platform-agnostic core; the native pieces — an MLS crypto with
// hardware-keystore-backed keys (Keychain), native group-state persistence, and multi-device
// linking — are not implemented yet. `createNativeSecureChatCrypto()` returns a placeholder whose
// methods throw until the native core is wired.

import type { SecureChatCrypto } from "@agora-sdk/secure-chat-core";

export * from "@agora-sdk/secure-chat-core";

const PHASE_3 = "Native SecureChatCrypto (React Native) is not implemented yet — Phase 3.";

/**
 * Returns a placeholder bare-React-Native `SecureChatCrypto`. Every method throws until the native
 * MLS core (hardware-keystore-backed keys + native group-state persistence) is wired in Phase 3.
 * Swap it for the concrete implementation (or a mock) when integrating.
 *
 * @returns A `SecureChatCrypto` whose every method throws a Phase 3 "not implemented" error.
 */
export function createNativeSecureChatCrypto(): SecureChatCrypto {
  const notImplemented = (): never => {
    throw new Error(PHASE_3);
  };
  return {
    generateDeviceIdentity: notImplemented,
    generateKeyPackages: notImplemented,
    createGroup: notImplemented,
    addMember: notImplemented,
    removeMember: notImplemented,
    encryptMessage: notImplemented,
    decryptMessage: notImplemented,
    exportGroupIdentities: notImplemented,
    processWelcome: notImplemented,
    processCommit: notImplemented,
    processProposal: notImplemented,
    exportGroupState: notImplemented,
    importGroupState: notImplemented,
    exportDeviceState: notImplemented,
    importDeviceState: notImplemented,
    exportBackup: notImplemented,
    importBackup: notImplemented,
  };
}
