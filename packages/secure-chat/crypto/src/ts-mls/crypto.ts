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
  encodeMlsMessage, decodeMlsMessage, zeroOutUint8Array,
  type Credential, type CiphersuiteImpl, type KeyPackage, type PrivateKeyPackage, type ClientState,
} from "ts-mls";
// makeKeyPackageRef isn't re-exported from the package root; ts-mls exposes every module via its
// "./*.js" export, so deep-import it.
import { makeKeyPackageRef } from "ts-mls/keyPackage.js";
import type {
  SecureChatCrypto, DeviceIdentity, KeyPackageBundle, GroupHandle, PassphraseBackup,
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

  // ── stubs filled in by later tasks (kept here so the class implements the interface from the start)
  createGroup(): never { throw new Error("not implemented yet (Task 4)"); }
  addMember(): never { throw new Error("not implemented yet (Task 4)"); }
  removeMember(): never { throw new Error("not implemented yet (Task 4)"); }
  encryptMessage(): never { throw new Error("not implemented yet (Task 4)"); }
  decryptMessage(): never { throw new Error("not implemented yet (Task 4)"); }
  processWelcome(): never { throw new Error("not implemented yet (Task 4)"); }
  processCommit(): never { throw new Error("not implemented yet (Task 4)"); }
  processProposal(): never { throw new Error("not implemented yet (Task 4)"); }
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
