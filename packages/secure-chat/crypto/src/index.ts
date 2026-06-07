// @agora-sdk/secure-chat-crypto — the SecureChatCrypto seam for Agora secure chat.
//
// The main entry exports ONLY the interface + types. The deterministic mock is intentionally NOT
// here — import it from the `@agora-sdk/secure-chat-crypto/testing` subpath so it can never be
// pulled into a production bundle by accident. The real MLS cores (ts-mls / OpenMLS-WASM) will plug
// in behind this interface (Phase 2).
export type {
  SecureChatCrypto,
  DeviceIdentity,
  KeyPackageBundle,
  GroupHandle,
  TargetedWelcome,
  CommitResult,
  PassphraseBackup,
} from "./interface.js";
