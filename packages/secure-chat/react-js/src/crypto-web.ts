// Web `SecureChatCrypto` — Phase 2 placeholder.
//
// This is where the real MLS implementation lands: **ts-mls** (pure TS) or **OpenMLS→WASM**,
// behind the `SecureChatCrypto` interface, plus IndexedDB persistence of group state. Until then,
// `createWebSecureChatCrypto()` returns a stub whose methods throw a clear "not implemented" error,
// so apps can wire `<SecureChatProvider crypto={...}>` against the real shape now.
//
// For tests / early UI work, inject the deterministic `MockSecureChatCrypto` instead (it will ship
// from the published @agora-sdk/secure-chat-crypto package — see the repo STATUS.md).

import type { SecureChatCrypto } from "@agora-sdk/secure-chat-core";

const PHASE_2 = "Web SecureChatCrypto (ts-mls/OpenMLS-WASM) is not implemented yet — Phase 2.";

/**
 * Returns a placeholder web `SecureChatCrypto`. Every method throws until the real MLS core is
 * wired. Swap this for the concrete implementation (or a mock) when integrating.
 */
export function createWebSecureChatCrypto(): SecureChatCrypto {
  const notImplemented = (): never => {
    throw new Error(PHASE_2);
  };
  return {
    generateDeviceIdentity: notImplemented,
    generateKeyPackages: notImplemented,
    createGroup: notImplemented,
    addMember: notImplemented,
    removeMember: notImplemented,
    encryptMessage: notImplemented,
    decryptMessage: notImplemented,
    processWelcome: notImplemented,
    processCommit: notImplemented,
    processProposal: notImplemented,
    exportGroupState: notImplemented,
    importGroupState: notImplemented,
    exportBackup: notImplemented,
    importBackup: notImplemented,
  };
}
