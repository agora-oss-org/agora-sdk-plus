// TsMlsSecureChatCrypto — the real RFC 9420 implementation of the SecureChatCrypto seam, on ts-mls.
//
// Where it sits in the blind-server model: ALL MLS crypto is here, client-side. Only ciphertext,
// public KeyPackages, and Welcomes/Commits ever cross the wire; group secrets and private keys never
// leave this object. It mirrors MockSecureChatCrypto's shape — an in-memory Map<groupIdHex, ClientState>
// keyed by GroupHandle.mlsGroupId — so the interface and all call sites are unchanged.
//
// Security (CLAUDE.md #1): randomness is the platform CSPRNG (crypto.getRandomValues) + ts-mls/@noble;
// failed decode/decrypt/join fail closed (throw, drop); consumed key material is zeroized.
import {
  generateKeyPackageWithKey, defaultCapabilities, defaultLifetime,
  createGroup, createCommit, joinGroup, createApplicationMessage, processMessage,
  encodeMlsMessage, decodeMlsMessage, encodeGroupState, decodeGroupState, zeroOutUint8Array, acceptAll, emptyPskIndex,
  defaultKeyRetentionConfig, mlsExporter,
  type Credential, type CiphersuiteImpl, type KeyPackage, type PrivateKeyPackage, type ClientState,
} from "ts-mls";
// makeKeyPackageRef + getGroupMembers + defaultClientConfig aren't re-exported from the package root;
// ts-mls exposes every module via its "./*.js" export, so deep-import them.
import { makeKeyPackageRef } from "ts-mls/keyPackage.js";
import { getGroupMembers } from "ts-mls/clientState.js";
import { defaultClientConfig } from "ts-mls/clientConfig.js";
import type {
  SecureChatCrypto, DeviceIdentity, KeyPackageBundle, GroupHandle, GroupMemberIdentity, CommitResult, TargetedWelcome, PassphraseBackup,
  SecureDecryptFailureReason,
} from "../interface.js";
import { SecureChatDecryptError } from "../interface.js";
import { DEFAULT_CIPHERSUITE_ID, loadCiphersuite } from "./ciphersuite.js";
import { sealBackup, openBackup } from "./backup.js";
import { toHex, fromHex } from "./hex.js";

const utf8 = (s: string) => new TextEncoder().encode(s);
const MLS_VERSION = "mls10" as const;

/**
 * Map a ts-mls decrypt/process failure to a {@link SecureChatDecryptError} with a classified reason.
 * Matches on ts-mls's error messages/names (its secret-tree ratchet is the actual enforcement). The
 * returned message is generic-by-reason — we never echo internal bytes or plaintext into the error.
 */
function classifyDecryptError(err: unknown): SecureChatDecryptError {
  const msg = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";
  let reason: SecureDecryptFailureReason = "unknown";
  if (/desired gen(?:eration)? in the past/i.test(msg)) reason = "replay";
  else if (/too far in the future/i.test(msg)) reason = "gap-too-large";
  else if (/epoch too old|former epoch/i.test(msg)) reason = "epoch-too-old";
  else if (name === "CryptoVerificationError" || /signature|verif|auth/i.test(msg)) reason = "unauthenticated";
  else if (name === "CodecError" || /decode|malformed/i.test(msg)) reason = "malformed";
  return new SecureChatDecryptError(reason, `secure-chat: message decrypt rejected (${reason})`);
}

interface DeviceState {
  deviceId: string;
  ciphersuite: number;
  signKey: Uint8Array;   // signature PRIVATE key — never leaves the client in the clear
  publicKey: Uint8Array; // signature public key
}

/** One retained, not-yet-consumed KeyPackage (public for re-publish/debug, private to join with). */
interface PendingKeyPackage {
  publicPackage: KeyPackage;
  privatePackage: PrivateKeyPackage;
}

/**
 * Tuning for the MLS secret-tree ratchet that backs replay/gap enforcement (RFC 9420). These are the
 * legitimate dials — they tighten or loosen the window, they never disable enforcement. Omitted fields
 * fall back to ts-mls's conservative defaults.
 */
export interface KeyRetentionOptions {
  /** Max generations the ratchet will skip forward before rejecting (`gap-too-large`). ts-mls default 200. */
  maximumForwardRatchetSteps?: number;
  /** How many skipped per-sender message keys to retain (the out-of-order/reorder window). ts-mls default 10. */
  retainKeysForGenerations?: number;
  /** How many past epochs of receiver keys to retain (late delivery across a Commit). ts-mls default 4. */
  retainKeysForEpochs?: number;
}

/** Options for {@link TsMlsSecureChatCrypto}. */
export interface TsMlsSecureChatCryptoOptions {
  /** Numeric MLS ciphersuite id (RFC 9420). Defaults to 1 (the MTI baseline). */
  ciphersuite?: number;
  /**
   * Override the ts-mls key-retention window (replay/gap tolerance). Defaults to ts-mls's conservative
   * values. Tightening (e.g. a smaller `maximumForwardRatchetSteps`) narrows the accepted gap; it cannot
   * turn enforcement off. Applied consistently to created, joined, imported, and restored groups.
   */
  keyRetention?: KeyRetentionOptions;
}

/**
 * Real RFC 9420 MLS implementation of {@link SecureChatCrypto}, built on ts-mls. Construct via
 * `createTsMlsSecureChatCrypto`; inject into `<SecureChatProvider crypto={…}>`.
 */
export class TsMlsSecureChatCrypto implements SecureChatCrypto {
  private readonly ciphersuiteId: number;
  private csImpl: CiphersuiteImpl | null = null;
  private device?: DeviceState;
  private credential?: Credential;
  protected readonly pending = new Map<string, PendingKeyPackage>(); // hex(ref) → kp
  protected readonly groups = new Map<string, ClientState>();        // hex(groupId) → state
  // The single client config (ts-mls clientConfig holds non-serializable callbacks + the key-retention
  // window). Built once and attached to EVERY group we create/join/import/restore, so the configured
  // replay/gap window is consistent and survives a persistence round-trip (encodeGroupState drops the
  // config; we reattach this one rather than ts-mls's default).
  private readonly clientConfig: typeof defaultClientConfig;

  constructor(options: TsMlsSecureChatCryptoOptions = {}) {
    this.ciphersuiteId = options.ciphersuite ?? DEFAULT_CIPHERSUITE_ID;
    this.clientConfig = {
      ...defaultClientConfig,
      keyRetentionConfig: { ...defaultKeyRetentionConfig, ...options.keyRetention },
    };
  }

  /** Lazily load + memoize the ciphersuite primitives. */
  protected async cs(): Promise<CiphersuiteImpl> {
    if (!this.csImpl) this.csImpl = await loadCiphersuite(this.ciphersuiteId);
    return this.csImpl;
  }

  protected requireDevice(): DeviceState {
    if (!this.device || !this.credential) {
      throw new Error("secure-chat: no device identity (call generateDeviceIdentity or importDeviceState first)");
    }
    return this.device;
  }

  async generateDeviceIdentity(opts: { deviceId: string; ciphersuite?: number }): Promise<{
    identity: DeviceIdentity; privateState: Uint8Array;
  }> {
    const cs = await this.cs();
    const { publicKey, signKey } = await cs.signature.keygen();
    const credential: Credential = { credentialType: "basic", identity: utf8(opts.deviceId) };
    this.device = { deviceId: opts.deviceId, ciphersuite: this.ciphersuiteId, signKey, publicKey };
    this.credential = credential;
    const identity: DeviceIdentity = {
      deviceId: opts.deviceId,
      signaturePublicKey: publicKey,
      credential: utf8(opts.deviceId), // opaque to the blind server; peers use the claimed KeyPackage
      ciphersuite: this.ciphersuiteId,
    };
    return { identity, privateState: this.serializeDeviceState() };
  }

  async generateKeyPackages(count: number): Promise<KeyPackageBundle[]> {
    const cs = await this.cs();
    const dev = this.requireDevice();
    const out: KeyPackageBundle[] = [];
    for (let i = 0; i < count; i++) {
      const { publicPackage, privatePackage } = await generateKeyPackageWithKey(
        this.credential!, defaultCapabilities(), defaultLifetime, [], { signKey: dev.signKey, publicKey: dev.publicKey }, cs
      );
      const ref = await makeKeyPackageRef(publicPackage, cs.hash);
      const refHex = toHex(ref);
      this.pending.set(refHex, { publicPackage, privatePackage });
      out.push({
        keyPackageRef: refHex,
        keyPackage: encodeMlsMessage({ version: MLS_VERSION, wireformat: "mls_key_package", keyPackage: publicPackage }),
        ciphersuite: dev.ciphersuite,
      });
    }
    return out;
  }

  async createGroup(opts: {
    mlsGroupId?: Uint8Array;
    initialMembers: { deviceId: string; keyPackage: Uint8Array }[];
  }): Promise<{ group: GroupHandle; welcomes: TargetedWelcome[] }> {
    const cs = await this.cs();
    const dev = this.requireDevice();
    const groupId = opts.mlsGroupId ?? crypto.getRandomValues(new Uint8Array(32));

    // Seed the group with a fresh self KeyPackage (local-only; never published).
    const self = await generateKeyPackageWithKey(
      this.credential!, defaultCapabilities(), defaultLifetime, [], { signKey: dev.signKey, publicKey: dev.publicKey }, cs
    );
    let state = await createGroup(groupId, self.publicPackage, self.privatePackage, [], cs, this.clientConfig);

    const adds = opts.initialMembers.map((m) => ({
      proposalType: "add" as const, add: { keyPackage: this.decodeKeyPackage(m.keyPackage) },
    }));
    const commit = await createCommit({ state, cipherSuite: cs }, { extraProposals: adds, ratchetTreeExtension: true });
    state = commit.newState;
    this.zeroize(commit.consumed);
    this.groups.set(toHex(groupId), state);

    // ratchetTreeExtension:true → the tree rides inside the Welcome, so a recipient joins from it ALONE.
    const welcomeBytes = encodeMlsMessage({ version: MLS_VERSION, wireformat: "mls_welcome", welcome: commit.welcome! });
    const welcomes = opts.initialMembers.map((m) => ({ targetDeviceId: m.deviceId, payload: welcomeBytes }));
    return { group: { mlsGroupId: groupId, epoch: state.groupContext.epoch }, welcomes };
  }

  async addMember(group: GroupHandle, newDevice: { deviceId: string; keyPackage: Uint8Array }): Promise<CommitResult> {
    const cs = await this.cs();
    const state = this.lookupGroup(group);
    const commit = await createCommit(
      { state, cipherSuite: cs },
      { extraProposals: [{ proposalType: "add", add: { keyPackage: this.decodeKeyPackage(newDevice.keyPackage) } }], ratchetTreeExtension: true }
    );
    this.zeroize(commit.consumed);
    this.groups.set(toHex(group.mlsGroupId), commit.newState);
    return {
      commit: encodeMlsMessage(commit.commit),
      welcomes: [{
        targetDeviceId: newDevice.deviceId,
        payload: encodeMlsMessage({ version: MLS_VERSION, wireformat: "mls_welcome", welcome: commit.welcome! }),
      }],
      epoch: commit.newState.groupContext.epoch,
    };
  }

  // Membership churn (remove/leave) is Phase 3 (multi-device). Fail closed rather than ship untested
  // leaf-index handling: the DM happy path never calls this.
  removeMember(_group: GroupHandle, _leafDeviceId: string): Promise<CommitResult> {
    throw new Error("secure-chat: removeMember is not implemented in the Phase 2 web core (Phase 3)");
  }

  async encryptMessage(group: GroupHandle, plaintext: Uint8Array): Promise<{ ciphertext: Uint8Array; epoch: bigint }> {
    const cs = await this.cs();
    const state = this.lookupGroup(group);
    const res = await createApplicationMessage(state, plaintext, cs);
    this.zeroize(res.consumed);
    this.groups.set(toHex(group.mlsGroupId), res.newState);
    return {
      ciphertext: encodeMlsMessage({ version: MLS_VERSION, wireformat: "mls_private_message", privateMessage: res.privateMessage }),
      epoch: res.newState.groupContext.epoch,
    };
  }

  // ── RFC 9420 MLS Exporter (out-of-band authentication; e.g. the IUC SAS) ────
  async exportSecret(
    group: GroupHandle,
    label: string,
    context: Uint8Array,
    length: number
  ): Promise<Uint8Array> {
    if (length <= 0) throw new Error("secure-chat: exportSecret length must be > 0");
    const cs = await this.cs();
    const state = this.lookupGroup(group); // throws "unknown group (not joined or evicted)" — fail closed
    // RFC 9420 MLS Exporter over the current epoch's exporter_secret; the secret itself never leaves here.
    return mlsExporter(state.keySchedule.exporterSecret, label, context, length, cs);
  }

  async decryptMessage(group: GroupHandle, ciphertext: Uint8Array): Promise<{
    plaintext: Uint8Array; senderDeviceId: string; epoch: bigint;
  }> {
    const cs = await this.cs();
    const state = this.lookupGroup(group);
    // ts-mls's secret-tree ratchet is the enforcement point: it throws on a replayed generation, an
    // over-limit forward gap, a too-old epoch, or a failed authentication. We classify that throw (and
    // decode failures) into a SecureChatDecryptError and re-raise it — and crucially we do NOT advance
    // stored group state on failure (processMessage threw before returning newState), so a rejected
    // message never ratchets us forward. Fail closed.
    let res: Awaited<ReturnType<typeof processMessage>>;
    try {
      const decoded = decodeMlsMessage(ciphertext, 0);
      if (!decoded) throw new SecureChatDecryptError("malformed", "secure-chat: malformed MLS message");
      res = await processMessage(decoded[0] as never, state, emptyPskIndex, acceptAll, cs);
    } catch (err) {
      throw err instanceof SecureChatDecryptError ? err : classifyDecryptError(err);
    }
    this.zeroize(res.consumed);
    this.groups.set(toHex(group.mlsGroupId), res.newState);
    if (res.kind !== "applicationMessage") {
      throw new SecureChatDecryptError("malformed", "secure-chat: expected an application message");
    }
    return { plaintext: res.message, senderDeviceId: this.peerDeviceId(res.newState), epoch: res.newState.groupContext.epoch };
  }

  async exportGroupIdentities(group: GroupHandle): Promise<GroupMemberIdentity[]> {
    const state = this.lookupGroup(group);
    const out: GroupMemberIdentity[] = [];
    // Read the roster from the MLS ratchet tree (same source peerDeviceId uses). Only basic-credential
    // leaves carry a device-id identity; skip anything else rather than guess.
    for (const leaf of getGroupMembers(state)) {
      if (leaf.credential.credentialType !== "basic") continue;
      out.push({
        deviceId: new TextDecoder().decode(leaf.credential.identity),
        signaturePublicKey: leaf.signaturePublicKey,
      });
    }
    return out;
  }

  async processWelcome(welcomePayload: Uint8Array): Promise<GroupHandle> {
    const cs = await this.cs();
    const decoded = decodeMlsMessage(welcomePayload, 0);
    if (!decoded || decoded[0].wireformat !== "mls_welcome") throw new Error("secure-chat: malformed Welcome");
    const welcome = decoded[0].welcome;
    // Match the Welcome to one of our pending KeyPackages by its MLS ref (welcome.secrets[].newMember).
    let matchedRef: string | undefined;
    let matched: PendingKeyPackage | undefined;
    for (const s of welcome.secrets) {
      const refHex = toHex(s.newMember);
      const kp = this.pending.get(refHex);
      if (kp) { matchedRef = refHex; matched = kp; break; }
    }
    if (!matched || !matchedRef) throw new Error("secure-chat: no matching KeyPackage for this Welcome");
    // ratchetTree omitted — it rode in via the creator's ratchetTreeExtension. Pass our clientConfig
    // (positional args 6/7 — ratchetTree/resumingFromState — are unused here) so the joined group gets
    // the configured key-retention window, not ts-mls's default.
    const state = await joinGroup(welcome, matched.publicPackage, matched.privatePackage, emptyPskIndex, cs, undefined, undefined, this.clientConfig);
    this.pending.delete(matchedRef); // one-time: consumed
    this.groups.set(toHex(state.groupContext.groupId), state);
    return { mlsGroupId: state.groupContext.groupId, epoch: state.groupContext.epoch };
  }

  async processCommit(group: GroupHandle, commit: Uint8Array): Promise<GroupHandle> {
    const cs = await this.cs();
    const state = this.lookupGroup(group);
    const decoded = decodeMlsMessage(commit, 0);
    if (!decoded) throw new Error("secure-chat: malformed commit");
    const res = await processMessage(decoded[0] as never, state, emptyPskIndex, acceptAll, cs);
    this.zeroize(res.consumed);
    if (res.kind !== "newState") throw new Error("secure-chat: expected a commit/proposal, got an application message");
    this.groups.set(toHex(group.mlsGroupId), res.newState);
    return { mlsGroupId: group.mlsGroupId, epoch: res.newState.groupContext.epoch };
  }

  async processProposal(group: GroupHandle, proposal: Uint8Array): Promise<void> {
    const cs = await this.cs();
    const state = this.lookupGroup(group);
    const decoded = decodeMlsMessage(proposal, 0);
    if (!decoded) throw new Error("secure-chat: malformed proposal");
    const res = await processMessage(decoded[0] as never, state, emptyPskIndex, acceptAll, cs);
    this.zeroize(res.consumed);
    if (res.kind === "newState") this.groups.set(toHex(group.mlsGroupId), res.newState);
  }

  async exportGroupState(group: GroupHandle): Promise<Uint8Array> {
    // ClientState = GroupState & { clientConfig }. encodeGroupState serializes the GroupState; the
    // clientConfig (which holds non-serializable callbacks) is reattached from the default on import.
    return encodeGroupState(this.lookupGroup(group));
  }

  async importGroupState(state: Uint8Array): Promise<GroupHandle> {
    const decoded = decodeGroupState(state, 0);
    if (!decoded) throw new Error("secure-chat: corrupt group state");
    // Reattach OUR clientConfig (not ts-mls's default) so the configured key-retention window survives
    // the persistence round-trip — encodeGroupState drops the (callback-bearing) config.
    const clientState: ClientState = { ...decoded[0], clientConfig: this.clientConfig };
    this.groups.set(toHex(clientState.groupContext.groupId), clientState);
    return { mlsGroupId: clientState.groupContext.groupId, epoch: clientState.groupContext.epoch };
  }

  async exportDeviceState(): Promise<Uint8Array> {
    return this.serializeDeviceState();
  }

  async importDeviceState(state: Uint8Array): Promise<DeviceIdentity> {
    const p = JSON.parse(new TextDecoder().decode(state)) as {
      v: number; deviceId: string; ciphersuite: number; signKey: string; publicKey: string;
      pending: { ref: string; publicPackage: string; initPrivateKey: string; hpkePrivateKey: string; signaturePrivateKey: string }[];
    };
    if (p.v !== 1) throw new Error(`secure-chat: unsupported device-state version ${p.v}`);
    this.device = {
      deviceId: p.deviceId, ciphersuite: p.ciphersuite, signKey: fromHex(p.signKey), publicKey: fromHex(p.publicKey),
    };
    this.credential = { credentialType: "basic", identity: utf8(p.deviceId) };
    this.pending.clear();
    for (const e of p.pending) {
      this.pending.set(e.ref, {
        publicPackage: this.decodeKeyPackage(fromHex(e.publicPackage)),
        privatePackage: {
          initPrivateKey: fromHex(e.initPrivateKey),
          hpkePrivateKey: fromHex(e.hpkePrivateKey),
          signaturePrivateKey: fromHex(e.signaturePrivateKey),
        },
      });
    }
    return { deviceId: p.deviceId, signaturePublicKey: this.device.publicKey, credential: utf8(p.deviceId), ciphersuite: p.ciphersuite };
  }

  // Passphrase backup of ALL local key material: the device identity (incl. the signature private
  // key + pending KeyPackages, via serializeDeviceState) and every joined group's full MLS state.
  // The argon2id KDF + AEAD live in ./backup.ts; here we just (de)serialize the payload. The blob is
  // opaque to the blind server — only ciphertext crosses the wire.
  async exportBackup(passphrase: string): Promise<PassphraseBackup> {
    const payload = {
      v: 1,
      device: toHex(this.serializeDeviceState()),
      groups: [...this.groups.values()].map((st) => toHex(encodeGroupState(st))),
    };
    return sealBackup(utf8(JSON.stringify(payload)), passphrase);
  }

  async importBackup(passphrase: string, backup: PassphraseBackup): Promise<DeviceIdentity> {
    const plain = await openBackup(backup, passphrase);
    const payload = JSON.parse(new TextDecoder().decode(plain)) as {
      v: number; device: string; groups: string[];
    };
    if (payload.v !== 1) throw new Error(`secure-chat: unsupported backup payload version ${payload.v}`);
    // Restore the device identity first (also clears + repopulates the pending KeyPackages).
    const identity = await this.importDeviceState(fromHex(payload.device));
    // Then every group's full state, keyed by its MLS group id (mirrors importGroupState).
    for (const g of payload.groups) {
      const decoded = decodeGroupState(fromHex(g), 0);
      if (!decoded) throw new Error("secure-chat: corrupt group state in backup");
      const clientState: ClientState = { ...decoded[0], clientConfig: this.clientConfig };
      this.groups.set(toHex(clientState.groupContext.groupId), clientState);
    }
    return identity;
  }

  /** Serialize identity (incl. signature private key) + the pending KeyPackage store to an opaque blob. */
  protected serializeDeviceState(): Uint8Array {
    const dev = this.requireDevice();
    const payload = {
      v: 1,
      deviceId: dev.deviceId,
      ciphersuite: dev.ciphersuite,
      signKey: toHex(dev.signKey),
      publicKey: toHex(dev.publicKey),
      pending: [...this.pending.entries()].map(([ref, kp]) => ({
        ref,
        publicPackage: toHex(encodeMlsMessage({ version: MLS_VERSION, wireformat: "mls_key_package", keyPackage: kp.publicPackage })),
        initPrivateKey: toHex(kp.privatePackage.initPrivateKey),
        hpkePrivateKey: toHex(kp.privatePackage.hpkePrivateKey),
        signaturePrivateKey: toHex(kp.privatePackage.signaturePrivateKey),
      })),
    };
    return utf8(JSON.stringify(payload));
  }

  // Best-effort sender attribution for a DM: the one member that isn't us. Real per-message sender
  // attribution for >2-member groups arrives with multi-device (Phase 3); the server also attests
  // senderDeviceId on the message row independently, so a "" here degrades gracefully.
  private peerDeviceId(state: ClientState): string {
    try {
      const me = toHex(this.device!.publicKey);
      for (const leaf of getGroupMembers(state)) {
        if (leaf.credential.credentialType === "basic" && toHex(leaf.signaturePublicKey) !== me) {
          return new TextDecoder().decode(leaf.credential.identity);
        }
      }
    } catch {
      /* fall through to unknown */
    }
    return "";
  }

  // Helpers used across tasks 4–5.
  /** @internal */ protected zeroize(consumed: Uint8Array[]): void { for (const c of consumed) zeroOutUint8Array(c); }
  /** @internal */ protected lookupGroup(group: GroupHandle): ClientState {
    const state = this.groups.get(toHex(group.mlsGroupId));
    if (!state) throw new Error("secure-chat: unknown group (not joined or evicted)");
    return state;
  }
  /** @internal */ protected decodeKeyPackage(bytes: Uint8Array): KeyPackage {
    const d = decodeMlsMessage(bytes, 0);
    if (!d || d[0].wireformat !== "mls_key_package") throw new Error("secure-chat: malformed KeyPackage");
    return d[0].keyPackage;
  }
}
