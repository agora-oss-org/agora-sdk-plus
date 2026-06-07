// Secure-chat wire contract — stand-in for @agora-server/contract (the Apache-2.0 server contract).
//
// Mirrors the response models + request bodies of agora-server's
// `packages/contract/src/secure-chat.ts`. That package is the source of truth (zod + TS); the
// client only needs the TypeScript shapes, so this copy is types-only.
//
// ⚠️ Keep this byte-faithful to the server contract. The arrow is SDK → contract: once
// `@agora-server/contract` is published, DELETE this file and `import type { ... } from "@agora-server/contract"`.
// Do NOT publish a separate `@agora-sdk/secure-chat-contract` (that would invert the dependency —
// see STATUS.md). Do not let this copy drift in the meantime.
//
// Wire conventions: every binary value is **base64** (the server stores/relays opaque blobs and
// never parses them); MLS epochs are **decimal strings** (u64 exceeds JS safe-int range).

export type SecureConversationType = "dm" | "group" | "channel";
export type SecureMemberRole = "admin" | "member";
export type SecureHandshakeKind = "welcome" | "commit" | "proposal";

// ─── reusable sub-objects ────────────────────────────────────────────────────
/** A Welcome targeted at the ONE device whose claimed KeyPackage was consumed. */
export interface WelcomeEnvelope {
  targetDeviceId: string;
  payload: string; // base64
  epoch: string; // decimal
}

/** A Commit/Proposal broadcast to the whole group (no target device). */
export interface HandshakeBlob {
  payload: string; // base64
  epoch: string; // decimal
}

// ─── request bodies ──────────────────────────────────────────────────────────
export interface RegisterDeviceBody {
  deviceId: string;
  displayName?: string | null;
  signaturePublicKey: string; // base64
  credential: string; // base64
  ciphersuite: number;
}

export interface PublishKeyPackagesBody {
  keyPackages: {
    keyPackageRef: string;
    keyPackage: string; // base64
    ciphersuite: number;
    expiresAt?: string | null;
  }[];
}

export interface CreateSecureConversationBody {
  type: SecureConversationType;
  mlsGroupId: string; // base64
  spaceId?: string | null; // required when type === "channel"
  name?: string | null; // optional plaintext label; prefer null
  memberUserIds?: string[];
  welcomes?: WelcomeEnvelope[];
}

export interface AddSecureMemberBody {
  userId: string;
  commit: HandshakeBlob;
  welcomes: WelcomeEnvelope[];
}

export interface RemoveSecureMemberBody {
  commit: HandshakeBlob;
}

export interface SendSecureMessageBody {
  ciphertext: string; // base64
  epoch: string; // decimal
  senderDeviceId: string;
  contentType?: string | null;
}

export interface UploadKeyBackupBody {
  deviceId?: string | null;
  blob: string; // base64
  nonce: string; // base64
  kdf: "argon2id" | "pbkdf2";
  kdfParams: Record<string, unknown>;
  cipher: "xchacha20poly1305" | "aes-256-gcm";
  version: number;
}

// ─── response models ─────────────────────────────────────────────────────────
export interface SecureDeviceModel {
  id: string;
  projectId: string;
  userId: string;
  deviceId: string;
  displayName: string | null;
  signaturePublicKey: string; // base64
  credential: string; // base64
  ciphersuite: number;
  revokedAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SecureKeyPackageClaim {
  deviceId: string; // the device row id whose KeyPackage was consumed
  keyPackageRef: string;
  keyPackage: string; // base64
  ciphersuite: number;
}

export interface SecureConversationMemberModel {
  id: string;
  projectId: string;
  conversationId: string;
  userId: string;
  role: SecureMemberRole;
  isActive: boolean;
  joinedAtEpoch: string | null;
  lastReadAt: string | null;
  leftAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SecureConversationModel {
  id: string;
  projectId: string;
  type: SecureConversationType;
  mlsGroupId: string; // base64
  spaceId: string | null;
  currentEpoch: string;
  name: string | null;
  createdById: string | null;
  lastMessageAt: string | null;
  memberCount?: number;
  unreadCount?: number;
  currentMember?: SecureConversationMemberModel;
  createdAt: string;
  updatedAt: string;
}

export interface SecureMessageModel {
  id: string;
  projectId: string;
  conversationId: string;
  senderUserId: string | null;
  senderDeviceId: string | null;
  epoch: string;
  ciphertext: string; // base64 (opaque MLS application message)
  contentType: string;
  createdAt: string;
}

export interface SecureHandshakeModel {
  id: string;
  seq: string; // monotonic delivery cursor — page by `since` = last seq processed
  kind: SecureHandshakeKind;
  conversationId: string;
  epoch: string;
  payload: string; // base64
  senderDeviceId: string | null;
  targetDeviceId: string | null;
}

export interface SecureKeyBackupModel {
  id: string;
  projectId: string;
  userId: string;
  deviceId: string | null;
  blob: string; // base64 (passphrase-encrypted; the server cannot decrypt)
  nonce: string; // base64
  kdf: string;
  kdfParams: Record<string, unknown>;
  cipher: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** Standard error envelope: `{ error, code, field? }` with `secure-chat/*` codes. */
export interface SecureChatErrorBody {
  error: string;
  code: string;
  field?: string;
}
