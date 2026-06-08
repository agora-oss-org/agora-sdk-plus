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
  encodeMlsMessage, decodeMlsMessage, zeroOutUint8Array, acceptAll, emptyPskIndex,
  type Credential, type CiphersuiteImpl, type KeyPackage, type PrivateKeyPackage, type ClientState,
} from "ts-mls";
// makeKeyPackageRef + getGroupMembers aren't re-exported from the package root; ts-mls exposes every
// module via its "./*.js" export, so deep-import them.
import { makeKeyPackageRef } from "ts-mls/keyPackage.js";
import { getGroupMembers } from "ts-mls/clientState.js";
import type {
  SecureChatCrypto, DeviceIdentity, KeyPackageBundle, GroupHandle, CommitResult, TargetedWelcome, PassphraseBackup,
} from "../interface.js";
import { DEFAULT_CIPHERSUITE_ID, loadCiphersuite } from "./ciphersuite.js";
import { toHex } from "./hex.js";

const utf8 = (s: string) => new TextEncoder().encode(s);
const MLS_VERSION = "mls10" as const;

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

/** Options for {@link TsMlsSecureChatCrypto}. */
export interface TsMlsSecureChatCryptoOptions {
  /** Numeric MLS ciphersuite id (RFC 9420). Defaults to 1 (the MTI baseline). */
  ciphersuite?: number;
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

  constructor(options: TsMlsSecureChatCryptoOptions = {}) {
    this.ciphersuiteId = options.ciphersuite ?? DEFAULT_CIPHERSUITE_ID;
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
    let state = await createGroup(groupId, self.publicPackage, self.privatePackage, [], cs);

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

  async decryptMessage(group: GroupHandle, ciphertext: Uint8Array): Promise<{
    plaintext: Uint8Array; senderDeviceId: string; epoch: bigint;
  }> {
    const cs = await this.cs();
    const state = this.lookupGroup(group);
    const decoded = decodeMlsMessage(ciphertext, 0);
    if (!decoded) throw new Error("secure-chat: malformed MLS message");
    const res = await processMessage(decoded[0] as never, state, emptyPskIndex, acceptAll, cs);
    this.zeroize(res.consumed);
    this.groups.set(toHex(group.mlsGroupId), res.newState);
    if (res.kind !== "applicationMessage") throw new Error("secure-chat: expected an application message");
    return { plaintext: res.message, senderDeviceId: this.peerDeviceId(res.newState), epoch: res.newState.groupContext.epoch };
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
    // ratchetTree omitted — it rode in via the creator's ratchetTreeExtension.
    const state = await joinGroup(welcome, matched.publicPackage, matched.privatePackage, emptyPskIndex, cs);
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

  exportGroupState(): never { throw new Error("not implemented yet (Task 5)"); }
  importGroupState(): never { throw new Error("not implemented yet (Task 5)"); }
  importDeviceState(): never { throw new Error("not implemented yet (Task 5)"); }
  exportDeviceState(): Promise<Uint8Array> { return Promise.resolve(this.serializeDeviceState()); }
  exportBackup(_passphrase: string): Promise<PassphraseBackup> {
    throw new Error("secure-chat: passphrase backup is not implemented in this core yet (Phase 2 task 5)");
  }
  importBackup(): never {
    throw new Error("secure-chat: passphrase restore is not implemented in this core yet (Phase 2 task 5)");
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
