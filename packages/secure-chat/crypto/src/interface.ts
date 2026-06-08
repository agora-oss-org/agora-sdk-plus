// The `SecureChatCrypto` seam — the canonical client crypto interface for Agora secure chat.
//
// All MLS (RFC 9420) crypto lives CLIENT-side behind this one interface. The Agora server is a
// blind Delivery Service and depends on none of it — it only relays opaque base64 blobs. The
// concrete core — ts-mls (pure TS) or OpenMLS compiled to WASM — is a swappable implementation;
// this abstraction lets that choice be deferred and changed without touching call sites.
//
// This package is the home of record for the seam. The agora-server repo consumes it as a
// (dev)dependency for its integration tests — the server is a CONSUMER of this client crypto, not
// its owner. Binary is `Uint8Array` IN MEMORY; the network layer base64-encodes at the wire
// boundary. MLS epochs are u64 → `bigint`.

/** A device's long-lived MLS identity (one device = one leaf). The public half is published to
 *  the server; the private half stays on the device (and in the passphrase backup). */
export interface DeviceIdentity {
  deviceId: string;
  signaturePublicKey: Uint8Array;
  credential: Uint8Array;
  ciphersuite: number;
}

/** A one-time KeyPackage others consume to add this device to a group. */
export interface KeyPackageBundle {
  keyPackageRef: string;
  keyPackage: Uint8Array;
  ciphersuite: number;
  expiresAt?: string;
}

/** A handle to a local MLS group the client holds the secrets for. */
export interface GroupHandle {
  mlsGroupId: Uint8Array;
  epoch: bigint;
}

/** A Welcome destined for exactly one new-member device (the one whose KeyPackage was used). */
export interface TargetedWelcome {
  targetDeviceId: string;
  payload: Uint8Array;
}

/** The output of a group mutation: a Commit to broadcast + per-device Welcomes to deliver. */
export interface CommitResult {
  commit: Uint8Array;
  welcomes: TargetedWelcome[];
  epoch: bigint;
}

/** A serialized, passphrase-encrypted backup of all local key material (history-restore on a new
 *  browser; also the basis for cross-device history sync later). */
export interface PassphraseBackup {
  blob: Uint8Array;
  kdf: string;
  kdfParams: Record<string, unknown>;
  cipher: string;
  nonce: Uint8Array;
  version: number;
}

export interface SecureChatCrypto {
  // ── identity / device ──────────────────────────────────────────────────────
  generateDeviceIdentity(opts: { deviceId: string; ciphersuite?: number }): Promise<{
    identity: DeviceIdentity;
    privateState: Uint8Array;
  }>;
  generateKeyPackages(count: number): Promise<KeyPackageBundle[]>;

  // ── group lifecycle (client-side; the server only relays the outputs) ───────
  createGroup(opts: {
    mlsGroupId?: Uint8Array;
    initialMembers: { deviceId: string; keyPackage: Uint8Array }[];
  }): Promise<{ group: GroupHandle; welcomes: TargetedWelcome[] }>;
  addMember(
    group: GroupHandle,
    newDevice: { deviceId: string; keyPackage: Uint8Array }
  ): Promise<CommitResult>;
  removeMember(group: GroupHandle, leafDeviceId: string): Promise<CommitResult>;

  // ── application messages ────────────────────────────────────────────────────
  encryptMessage(
    group: GroupHandle,
    plaintext: Uint8Array
  ): Promise<{ ciphertext: Uint8Array; epoch: bigint }>;
  decryptMessage(
    group: GroupHandle,
    ciphertext: Uint8Array
  ): Promise<{ plaintext: Uint8Array; senderDeviceId: string; epoch: bigint }>;

  // ── processing inbound handshakes ───────────────────────────────────────────
  processWelcome(welcome: Uint8Array): Promise<GroupHandle>;
  processCommit(group: GroupHandle, commit: Uint8Array): Promise<GroupHandle>; // advances epoch
  processProposal(group: GroupHandle, proposal: Uint8Array): Promise<void>;

  // ── local MLS state persistence (IndexedDB on web; opaque serialization) ────
  exportGroupState(group: GroupHandle): Promise<Uint8Array>;
  importGroupState(state: Uint8Array): Promise<GroupHandle>;

  // ── device-state persistence (re-hydrate identity after a reload) ───────────
  /** Serialize this device's identity + private state to an opaque blob for persistence. */
  exportDeviceState(): Promise<Uint8Array>;
  /** Restore device identity + private state from {@link exportDeviceState} output. */
  importDeviceState(state: Uint8Array): Promise<DeviceIdentity>;

  // ── passphrase backup of all local key material ─────────────────────────────
  /**
   * Seal all local key material (device identity + private keys + every joined group's state) into a
   * passphrase-encrypted blob for upload to the blind server. The real cores use a memory-hard KDF
   * (argon2id) + an AEAD; the server stores the ciphertext verbatim and can never decrypt it.
   *
   * @param passphrase - The user's backup passphrase (never sent to the server).
   * @returns The encrypted backup envelope (base64-encode `blob`/`nonce` at the wire boundary).
   */
  exportBackup(passphrase: string): Promise<PassphraseBackup>;
  /**
   * Restore local key material from a {@link exportBackup} envelope, repopulating this instance's
   * device identity and group states. Symmetric with {@link importDeviceState}, it returns the
   * restored identity so a caller can re-assert the device server-side (idempotently) and rehydrate UI.
   *
   * @param passphrase - The user's backup passphrase.
   * @param backup - The encrypted envelope fetched from the server.
   * @returns The restored device identity.
   * @throws {Error} On a wrong passphrase or a corrupt/tampered backup (fails closed — no partial restore).
   */
  importBackup(passphrase: string, backup: PassphraseBackup): Promise<DeviceIdentity>;
}
