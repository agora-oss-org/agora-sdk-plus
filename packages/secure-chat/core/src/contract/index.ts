// Secure-chat wire types — re-exported from the published `@agora-server/contract` (Apache-2.0).
//
// The dependency arrow is **SDK → contract**: agora-server owns the wire contract, this SDK depends
// on it. This module used to hold a byte-faithful *copy* of the types (a stand-in until the contract
// published); now that `@agora-server/contract` is published, it is a thin **type-only re-export** so
// there is exactly one source of truth and zero drift. The internal import path
// (`../contract/index.js`) is kept stable so call sites don't churn, and the re-export is scoped to
// the secure-chat surface (not the contract's reactions/pagination/etc.).
//
// Type-only on purpose: `@agora-server/contract` is ESM-only, but these `export type` re-exports are
// erased from the emitted JS, so core's dual ESM/CJS build never `require()`s it at runtime.
//
// Wire conventions (owned by the contract): every binary value is **base64**; MLS epochs are
// **decimal strings** (u64 exceeds JS safe-int range).

// ── response models (the route shapers' output) ──────────────────────────────
export type {
  SecureDeviceModel,
  SecureKeyPackageClaim,
  SecureConversationMemberModel,
  SecureConversationModel,
  SecureMessageModel,
  SecureHandshakeModel,
  SecureKeyBackupModel,
} from "@agora-server/contract";

// ── request bodies + reusable sub-objects (z.input of the contract's zod schemas) ──
export type {
  RegisterDeviceBody,
  PublishKeyPackagesBody,
  CreateSecureConversationBody,
  AddSecureMemberBody,
  RemoveSecureMemberBody,
  SendSecureMessageBody,
  UploadKeyBackupBody,
  WelcomeEnvelope,
  HandshakeBlob,
} from "@agora-server/contract";
