// @agora-sdk/secure-chat-expo — Expo bindings for Agora secure chat.
//
// Phase 3 (stub). Re-exports the platform-agnostic core; the Expo pieces — an MLS crypto with
// SecureStore-backed keys and native group-state persistence — are not implemented yet.
// `createExpoSecureChatCrypto()` returns a placeholder whose methods throw until the native core
// is wired.

import type { SecureChatCrypto } from "@agora-sdk/secure-chat-core";

export * from "@agora-sdk/secure-chat-core";

const PHASE_3 = "Expo SecureChatCrypto is not implemented yet — Phase 3.";

/**
 * Returns a placeholder Expo `SecureChatCrypto`. Every method throws until the Expo MLS core
 * (SecureStore-backed keys + native group-state persistence) is wired in Phase 3. Swap it for the
 * concrete implementation (or a mock) when integrating.
 *
 * @returns A `SecureChatCrypto` whose every method throws a Phase 3 "not implemented" error.
 */
export function createExpoSecureChatCrypto(): SecureChatCrypto {
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
    exportSecret: notImplemented,
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
