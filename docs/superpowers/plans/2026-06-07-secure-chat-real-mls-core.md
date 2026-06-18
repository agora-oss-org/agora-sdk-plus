# Real MLS Core (ts-mls) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the throwing web-crypto stub with a real RFC 9420 MLS implementation built on **ts-mls**, behind the existing `SecureChatCrypto` interface, with real group/device-state serialization wired into the existing persistence layer, proven by the e2e against a running agora-server.

**Architecture:** A new `TsMlsSecureChatCrypto` class in `@agora-sdk/secure-chat-crypto`, shipped on an opt-in `./ts-mls` subpath (the bare entry + `./testing` mock stay dependency-free). It mirrors `MockSecureChatCrypto`'s shape — an in-memory `Map<groupIdHex, ClientState>` keyed by `GroupHandle.mlsGroupId` — so the interface and every call site (core hooks, transport, e2e) are unchanged. The recipient joins from the Welcome alone via ts-mls's `ratchetTreeExtension: true`; persistence uses ts-mls's `encodeGroupState`/`decodeGroupState`.

**Tech Stack:** TypeScript, [ts-mls](https://github.com/LukaJCB/ts-mls) `1.6.2` (pure TS; `@hpke/core`), vitest, pnpm workspace dual ESM/CJS build.

---

## Verified ts-mls 1.6.2 API (the facts this plan is built on)

All imported from the package root `"ts-mls"` unless noted. Confirmed from the published `.d.ts`.

```ts
// ciphersuite
const ciphersuites: { MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519: 1, /* …→88 */ }   // name→numeric id
function getCiphersuiteFromName(name: CiphersuiteName): Ciphersuite
function getCiphersuiteImpl(cs: Ciphersuite, provider?): Promise<CiphersuiteImpl>       // CiphersuiteImpl has .hash .signature .hpke .kdf .rng
type Credential = { credentialType: "basic"; identity: Uint8Array } | { credentialType: "x509"; … }

// keys
// signatureKeyPair via cs.signature.keygen(): Promise<{ publicKey: Uint8Array; signKey: Uint8Array }>
function generateKeyPackageWithKey(credential, capabilities, lifetime, extensions: Extension[],
  signatureKeyPair: { signKey: Uint8Array; publicKey: Uint8Array }, cs: CiphersuiteImpl, leafNodeExtensions?)
  : Promise<{ publicPackage: KeyPackage; privatePackage: PrivateKeyPackage }>
function makeKeyPackageRef(kp: KeyPackage, h: Hash): Promise<Uint8Array>
interface PrivateKeyPackage { initPrivateKey: Uint8Array; hpkePrivateKey: Uint8Array; signaturePrivateKey: Uint8Array }
const defaultCapabilities: () => Capabilities                  // a FUNCTION
const defaultLifetime: Lifetime                                // a VALUE

// group lifecycle
function createGroup(groupId: Uint8Array, keyPackage: KeyPackage, privateKeyPackage: PrivateKeyPackage,
  extensions: Extension[], cs: CiphersuiteImpl, clientConfig?): Promise<ClientState>
interface MLSContext { state: ClientState; cipherSuite: CiphersuiteImpl; pskIndex?: PskIndex }
interface CreateCommitOptions { extraProposals?: Proposal[]; ratchetTreeExtension?: boolean; … }
interface CreateCommitResult { newState: ClientState; welcome: Welcome | undefined; commit: MLSMessage; consumed: Uint8Array[] }
function createCommit(context: MLSContext, options?: CreateCommitOptions): Promise<CreateCommitResult>
function joinGroup(welcome: Welcome, keyPackage: KeyPackage, privateKeys: PrivateKeyPackage,
  pskSearch: PskIndex, cs: CiphersuiteImpl, ratchetTree?: RatchetTree, …): Promise<ClientState>
type Proposal = { proposalType: "add"; add: { keyPackage: KeyPackage } } | { proposalType: "remove"; remove: { removed: number } } | …

// messages
function createApplicationMessage(state, message: Uint8Array, cs, authenticatedData?)
  : Promise<{ newState: ClientState; privateMessage: PrivateMessage; consumed: Uint8Array[] }>
type ProcessMessageResult =
  | { kind: "newState"; newState: ClientState; actionTaken; consumed: Uint8Array[] }
  | { kind: "applicationMessage"; message: Uint8Array; newState: ClientState; consumed: Uint8Array[] }
function processMessage(message: MlsPrivateMessage | MlsPublicMessage, state, pskIndex: PskIndex,
  action: IncomingMessageCallback, cs): Promise<ProcessMessageResult>
const acceptAll: IncomingMessageCallback
const emptyPskIndex: PskIndex

// wire codec — Encoder<T> = (t)=>Uint8Array ; Decoder<T> = (b, offset)=>[T, number] | undefined
type MLSMessage = { version: ProtocolVersionName } & ( { wireformat: "mls_welcome"; welcome: Welcome }
  | { wireformat: "mls_private_message"; privateMessage: PrivateMessage }
  | { wireformat: "mls_key_package"; keyPackage: KeyPackage } | … )
const encodeMlsMessage: (m: MLSMessage) => Uint8Array
const decodeMlsMessage: (b: Uint8Array, offset: number) => [MLSMessage, number] | undefined
const protocolVersions = { mls10: 1 }                          // version string is "mls10"

// state + epoch + serialization
type ClientState = GroupState & { clientConfig: ClientConfig }
interface GroupState { groupContext: GroupContext; … }         // GroupContext.epoch: bigint, .groupId: Uint8Array
const encodeGroupState: (s: GroupState) => Uint8Array
const decodeGroupState: (b: Uint8Array, offset: number) => [GroupState, number] | undefined
interface Welcome { cipherSuite; secrets: { newMember: Uint8Array /* = KeyPackageRef */; … }[]; encryptedGroupInfo }
function zeroOutUint8Array(a: Uint8Array): void
// defaultClientConfig is NOT on the package root — deep-import: `import { defaultClientConfig } from "ts-mls/clientConfig.js"`
```

**Packaging fact:** ts-mls is **ESM-only** (`"type":"module"`, exports has no `require` condition) and depends on `@hpke/core`. Therefore the `./ts-mls` subpath of our crypto package must be **ESM-only**; the `ts-mls/` source dir is **excluded from the CJS build**. The bare entry (`.`) and `./testing` stay dual ESM/CJS and dependency-free.

---

## File structure

```
packages/secure-chat/crypto/
  package.json                     MODIFY  add ts-mls dep + "./ts-mls" export (esm-only)
  tsconfig.cjs.json                MODIFY  exclude src/ts-mls/** from the CJS build
  src/ts-mls/
    _characterization.test.ts      CREATE  Task 1 — pins the raw ts-mls API end to end
    ciphersuite.ts                 CREATE  Task 2 — number↔name map + default + impl loader
    ciphersuite.test.ts            CREATE  Task 2
    hex.ts                         CREATE  Task 3 — local toHex/fromHex (pkg stays base64-free)
    crypto.ts                      CREATE  Tasks 3–5 — the TsMlsSecureChatCrypto class
    crypto.test.ts                 CREATE  Tasks 3–5 — two-party real-crypto flow + persistence round-trips
    index.ts                       CREATE  Task 6 — createTsMlsSecureChatCrypto() (the only public export)
packages/secure-chat/react-js/
  package.json                     MODIFY  Task 7 — depend on @agora-sdk/secure-chat-crypto
  src/crypto-web.ts                MODIFY  Task 7 — return the real core
e2e/
  crypto-factory.ts                CREATE  Task 7 — named crypto factories for the e2e
  secure-chat.e2e.ts               MODIFY  Task 7 — parametrize over the factory; run mock + ts-mls
CHANGELOG.md / STATUS.md / packages/secure-chat/ROADMAP.md   MODIFY  Task 8
```

---

## Task 1: Pin the ts-mls API with a characterization test

Install ts-mls and prove — with a real two-party flow against the **raw** library (no wrapper) — that every signature this plan relies on is correct, that a recipient joins from the Welcome **alone** (`ratchetTreeExtension: true`), and that `encodeGroupState`/`decodeGroupState` round-trip. This test stays in the repo as executable documentation of the dependency contract.

**Files:**
- Modify: `packages/secure-chat/crypto/package.json` (add dep)
- Test: `packages/secure-chat/crypto/src/ts-mls/_characterization.test.ts`

- [ ] **Step 1: Install ts-mls into the crypto package**

Run:
```bash
pnpm --filter @agora-sdk/secure-chat-crypto add ts-mls@1.6.2
```
Expected: `ts-mls` (and transitive `@hpke/core`) added to `packages/secure-chat/crypto/package.json` `dependencies`; lockfile updated.

- [ ] **Step 2: Write the characterization test**

Create `packages/secure-chat/crypto/src/ts-mls/_characterization.test.ts`:
```ts
// Characterization test: pins the exact ts-mls 1.6.2 API the wrapper depends on. Not a wrapper test —
// it exercises the raw library so a future ts-mls upgrade that changes a signature fails HERE, loudly,
// with a minimal repro. Proves: two-party DM, recipient joins from the Welcome ALONE, state round-trips.
import { describe, it, expect } from "vitest";
import {
  ciphersuites, getCiphersuiteFromName, getCiphersuiteImpl,
  generateKeyPackageWithKey, makeKeyPackageRef, defaultCapabilities, defaultLifetime,
  createGroup, createCommit, joinGroup, createApplicationMessage, processMessage,
  encodeMlsMessage, decodeMlsMessage, encodeGroupState, decodeGroupState,
  acceptAll, emptyPskIndex, type Credential, type CiphersuiteName,
} from "ts-mls";
import { defaultClientConfig } from "ts-mls/clientConfig.js";

const NAME: CiphersuiteName = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519";
const utf8 = (s: string) => new TextEncoder().encode(s);
const fromUtf8 = (b: Uint8Array) => new TextDecoder().decode(b);

async function device(id: string, cs: Awaited<ReturnType<typeof getCiphersuiteImpl>>) {
  const { publicKey, signKey } = await cs.signature.keygen();
  const credential: Credential = { credentialType: "basic", identity: utf8(id) };
  const kp = await generateKeyPackageWithKey(credential, defaultCapabilities(), defaultLifetime, [], { signKey, publicKey }, cs);
  return { credential, signKey, publicKey, kp };
}

describe("ts-mls 1.6.2 characterization", () => {
  it("runs a two-party DM where the recipient joins from the Welcome alone", async () => {
    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(NAME));
    expect(ciphersuites[NAME]).toBe(1);

    const alice = await device("alice", cs);
    const bob = await device("bob", cs);

    // alice creates the group (seeded with her own key package), then commits an Add for bob.
    const groupId = crypto.getRandomValues(new Uint8Array(32));
    let aliceState = await createGroup(groupId, alice.kp.publicPackage, alice.kp.privatePackage, [], cs);
    const commit = await createCommit(
      { state: aliceState, cipherSuite: cs },
      { extraProposals: [{ proposalType: "add", add: { keyPackage: bob.kp.publicPackage } }], ratchetTreeExtension: true }
    );
    aliceState = commit.newState;
    expect(commit.welcome).toBeDefined();
    expect(aliceState.groupContext.epoch).toBe(1n);

    // The Welcome carries bob's KeyPackage ref so a recipient can match it.
    const bobRef = await makeKeyPackageRef(bob.kp.publicPackage, cs.hash);
    expect(commit.welcome!.secrets.some((s) => Buffer.from(s.newMember).equals(Buffer.from(bobRef)))).toBe(true);

    // bob joins with ONLY the welcome (ratchetTree omitted — it rode in via ratchetTreeExtension).
    let bobState = await joinGroup(commit.welcome!, bob.kp.publicPackage, bob.kp.privatePackage, emptyPskIndex, cs);
    expect(Buffer.from(bobState.groupContext.groupId).equals(Buffer.from(groupId))).toBe(true);

    // alice → bob application message, round-tripped through the MLSMessage wire envelope.
    const app = await createApplicationMessage(aliceState, utf8("hello bob"), cs);
    aliceState = app.newState;
    const wire = encodeMlsMessage({ version: "mls10", wireformat: "mls_private_message", privateMessage: app.privateMessage });
    const decoded = decodeMlsMessage(wire, 0);
    expect(decoded).toBeDefined();
    const res = await processMessage(decoded![0] as never, bobState, emptyPskIndex, acceptAll, cs);
    expect(res.kind).toBe("applicationMessage");
    if (res.kind === "applicationMessage") expect(fromUtf8(res.message)).toBe("hello bob");

    // group state serializes and rebuilds (clientConfig reattached from the default).
    const blob = encodeGroupState(aliceState);
    const back = decodeGroupState(blob, 0);
    expect(back).toBeDefined();
    const rebuilt = { ...back![0], clientConfig: defaultClientConfig };
    expect(rebuilt.groupContext.epoch).toBe(aliceState.groupContext.epoch);
  });
});
```

- [ ] **Step 3: Run it; it must pass**

Run: `pnpm test -- _characterization`
Expected: PASS (1 test). If any import/signature is wrong, this fails with the exact mismatch — fix the call to match the installed `.d.ts` before continuing (do **not** edit the library).

- [ ] **Step 4: Commit**

```bash
git add packages/secure-chat/crypto/package.json pnpm-lock.yaml packages/secure-chat/crypto/src/ts-mls/_characterization.test.ts
git commit -m "test(crypto): pin ts-mls 1.6.2 API with a characterization test"
```

---

## Task 2: Ciphersuite map (number ↔ ts-mls name)

The wire contract carries `ciphersuite` as a number; ts-mls uses string names. One small module owns the mapping + the suite-1 default + a memo-friendly impl loader.

**Files:**
- Create: `packages/secure-chat/crypto/src/ts-mls/ciphersuite.ts`
- Test: `packages/secure-chat/crypto/src/ts-mls/ciphersuite.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/secure-chat/crypto/src/ts-mls/ciphersuite.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { DEFAULT_CIPHERSUITE_ID, ciphersuiteNameFromId, ciphersuiteIdFromName, loadCiphersuite } from "./ciphersuite.js";

describe("ciphersuite map", () => {
  it("defaults to suite 1", () => {
    expect(DEFAULT_CIPHERSUITE_ID).toBe(1);
    expect(ciphersuiteNameFromId(1)).toBe("MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519");
  });
  it("round-trips id ↔ name", () => {
    expect(ciphersuiteIdFromName(ciphersuiteNameFromId(1))).toBe(1);
  });
  it("throws on an unknown id (fail closed)", () => {
    expect(() => ciphersuiteNameFromId(9999)).toThrow();
  });
  it("loads a usable CiphersuiteImpl for the default", async () => {
    const cs = await loadCiphersuite(1);
    expect(typeof cs.signature.keygen).toBe("function");
  });
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `pnpm test -- ciphersuite`
Expected: FAIL — `Cannot find module './ciphersuite.js'`.

- [ ] **Step 3: Implement**

Create `packages/secure-chat/crypto/src/ts-mls/ciphersuite.ts`:
```ts
// Maps the wire contract's numeric MLS ciphersuite id (RFC 9420 / IANA) to ts-mls's string name and
// back, owns the suite-1 default, and loads a usable CiphersuiteImpl. One place so adding a suite is a
// one-line change and an unknown id fails closed rather than silently picking a wrong suite.
import { ciphersuites, getCiphersuiteFromName, getCiphersuiteImpl, type CiphersuiteName, type CiphersuiteImpl } from "ts-mls";

/** RFC 9420 mandatory-to-implement baseline; our default. */
export const DEFAULT_CIPHERSUITE_ID = 1 as const;

// Invert ts-mls's name→id constant once.
const ID_TO_NAME = new Map<number, CiphersuiteName>(
  (Object.entries(ciphersuites) as [CiphersuiteName, number][]).map(([name, id]) => [id, name])
);

/** Resolve a ts-mls suite name from a numeric contract id. @throws {Error} on an unknown id. */
export function ciphersuiteNameFromId(id: number): CiphersuiteName {
  const name = ID_TO_NAME.get(id);
  if (!name) throw new Error(`secure-chat: unsupported MLS ciphersuite id ${id}`);
  return name;
}

/** Resolve the numeric contract id from a ts-mls suite name. */
export function ciphersuiteIdFromName(name: CiphersuiteName): number {
  return ciphersuites[name];
}

/** Load a ready CiphersuiteImpl (crypto primitives) for a numeric id. @throws {Error} on an unknown id. */
export function loadCiphersuite(id: number): Promise<CiphersuiteImpl> {
  return getCiphersuiteImpl(getCiphersuiteFromName(ciphersuiteNameFromId(id)));
}
```

- [ ] **Step 4: Run it; verify it passes**

Run: `pnpm test -- ciphersuite`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/secure-chat/crypto/src/ts-mls/ciphersuite.ts packages/secure-chat/crypto/src/ts-mls/ciphersuite.test.ts
git commit -m "feat(crypto): ts-mls ciphersuite number↔name map (suite-1 default)"
```

---

## Task 3: Device identity + KeyPackages

Start the `TsMlsSecureChatCrypto` class: a stable signature keypair, a basic credential, and one-time KeyPackages whose private halves are retained in a pending store keyed by their MLS ref (so an inbound Welcome can find them).

**Files:**
- Create: `packages/secure-chat/crypto/src/ts-mls/hex.ts`
- Create: `packages/secure-chat/crypto/src/ts-mls/crypto.ts`
- Test: `packages/secure-chat/crypto/src/ts-mls/crypto.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/secure-chat/crypto/src/ts-mls/crypto.test.ts`:
```ts
// Two-party real-crypto tests for TsMlsSecureChatCrypto — the ts-mls implementation of the seam.
// Mirrors mock-crypto.test.ts: encryption hides plaintext, a second instance joins via the Welcome
// and decrypts, and device/group state survives a round-trip onto a FRESH instance.
import { describe, it, expect } from "vitest";
import { TsMlsSecureChatCrypto } from "./crypto.js";

const utf8 = (s: string) => new TextEncoder().encode(s);
const fromUtf8 = (b: Uint8Array) => new TextDecoder().decode(b);

describe("TsMlsSecureChatCrypto: device + key packages", () => {
  it("generates a stable identity and one-time key packages", async () => {
    const c = new TsMlsSecureChatCrypto();
    const { identity, privateState } = await c.generateDeviceIdentity({ deviceId: "alice-web" });
    expect(identity.deviceId).toBe("alice-web");
    expect(identity.ciphersuite).toBe(1);
    expect(identity.signaturePublicKey.length).toBeGreaterThan(0);
    expect(privateState.length).toBeGreaterThan(0);

    const kps = await c.generateKeyPackages(3);
    expect(kps).toHaveLength(3);
    // distinct refs, non-empty wire blobs
    expect(new Set(kps.map((k) => k.keyPackageRef)).size).toBe(3);
    for (const k of kps) expect(k.keyPackage.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `pnpm test -- ts-mls/crypto`
Expected: FAIL — `Cannot find module './crypto.js'`.

- [ ] **Step 3: Create the hex helper**

Create `packages/secure-chat/crypto/src/ts-mls/hex.ts`:
```ts
// Local hex helpers so this package stays free of the core's base64 (the seam works in Uint8Array;
// the network layer base64-encodes at the wire boundary). Used to key in-memory maps and to serialize
// raw key bytes in device-state JSON.
export function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
export function fromHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
```

- [ ] **Step 4: Create the class with identity + key packages**

Create `packages/secure-chat/crypto/src/ts-mls/crypto.ts`:
```ts
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
  generateKeyPackageWithKey, makeKeyPackageRef, defaultCapabilities, defaultLifetime,
  createGroup, createCommit, joinGroup, createApplicationMessage, processMessage,
  encodeMlsMessage, decodeMlsMessage, encodeGroupState, decodeGroupState,
  acceptAll, emptyPskIndex, zeroOutUint8Array,
  type Credential, type CiphersuiteImpl, type KeyPackage, type PrivateKeyPackage, type ClientState,
} from "ts-mls";
import { defaultClientConfig } from "ts-mls/clientConfig.js";
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
 * {@link createTsMlsSecureChatCrypto}; inject into `<SecureChatProvider crypto={…}>`.
 */
export class TsMlsSecureChatCrypto implements SecureChatCrypto {
  private readonly ciphersuiteId: number;
  private csImpl: CiphersuiteImpl | null = null;
  private device?: DeviceState;
  private credential?: Credential;
  private readonly pending = new Map<string, PendingKeyPackage>(); // hex(ref) → kp
  private readonly groups = new Map<string, ClientState>();        // hex(groupId) → state

  constructor(options: TsMlsSecureChatCryptoOptions = {}) {
    this.ciphersuiteId = options.ciphersuite ?? DEFAULT_CIPHERSUITE_ID;
  }

  /** Lazily load + memoize the ciphersuite primitives. */
  private async cs(): Promise<CiphersuiteImpl> {
    if (!this.csImpl) this.csImpl = await loadCiphersuite(this.ciphersuiteId);
    return this.csImpl;
  }

  private requireDevice(): DeviceState {
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
  exportDeviceState(): Promise<Uint8Array> { return Promise.resolve(this.serializeDeviceState()); }
  importDeviceState(): never { throw new Error("not implemented yet (Task 5)"); }
  exportBackup(_passphrase: string): Promise<PassphraseBackup> {
    throw new Error("secure-chat: passphrase backup is not implemented in this core yet (Phase 2 task 5)");
  }
  importBackup(): never {
    throw new Error("secure-chat: passphrase restore is not implemented in this core yet (Phase 2 task 5)");
  }

  /** Serialize identity (incl. signature private key) + the pending KeyPackage store to an opaque blob. */
  private serializeDeviceState(): Uint8Array {
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
```

Note: the `createGroup`/etc. stubs above are temporary scaffolding so the class satisfies `SecureChatCrypto` from Task 3 onward; Task 4 and Task 5 replace them with real method bodies. The `protected` helpers and imports they need (`createCommit`, `joinGroup`, etc.) are already imported.

- [ ] **Step 5: Run it; verify it passes**

Run: `pnpm test -- ts-mls/crypto`
Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add packages/secure-chat/crypto/src/ts-mls/hex.ts packages/secure-chat/crypto/src/ts-mls/crypto.ts packages/secure-chat/crypto/src/ts-mls/crypto.test.ts
git commit -m "feat(crypto): ts-mls device identity + key packages"
```

---

## Task 4: Group lifecycle + messages

Replace the Task-3 stubs with real bodies: create a group and emit a Welcome the recipient can join from alone, add/remove members, encrypt/decrypt application messages, and process inbound Welcomes/Commits/Proposals.

**Files:**
- Modify: `packages/secure-chat/crypto/src/ts-mls/crypto.ts`
- Test: `packages/secure-chat/crypto/src/ts-mls/crypto.test.ts`

- [ ] **Step 1: Add the failing two-party flow test**

Append to `packages/secure-chat/crypto/src/ts-mls/crypto.test.ts`:
```ts
/** Stand up alice+bob and a shared DM; returns both crypto instances and both group handles. */
async function twoPartyDM() {
  const alice = new TsMlsSecureChatCrypto();
  const bob = new TsMlsSecureChatCrypto();
  await alice.generateDeviceIdentity({ deviceId: "alice-web" });
  await bob.generateDeviceIdentity({ deviceId: "bob-web" });
  // bob publishes a KeyPackage; alice claims it (we just take the wire bytes directly here).
  const [bobKp] = await bob.generateKeyPackages(1);
  const { group: aliceGroup, welcomes } = await alice.createGroup({
    initialMembers: [{ deviceId: "bob-row", keyPackage: bobKp.keyPackage }],
  });
  const bobGroup = await bob.processWelcome(welcomes[0]!.payload);
  return { alice, bob, aliceGroup, bobGroup };
}

describe("TsMlsSecureChatCrypto: DM round-trip", () => {
  it("alice encrypts, bob decrypts; ciphertext hides the plaintext", async () => {
    const { alice, bob, aliceGroup, bobGroup } = await twoPartyDM();
    const pt = "hello bob";
    const { ciphertext } = await alice.encryptMessage(aliceGroup, new TextEncoder().encode(pt));
    // server-blindness: the wire blob never contains the plaintext bytes
    expect(fromUtf8(ciphertext).includes(pt)).toBe(false);
    const { plaintext } = await bob.decryptMessage(bobGroup, ciphertext);
    expect(fromUtf8(plaintext)).toBe(pt);
  });

  it("both sides agree on the group id", async () => {
    const { aliceGroup, bobGroup } = await twoPartyDM();
    expect(Buffer.from(bobGroup.mlsGroupId).equals(Buffer.from(aliceGroup.mlsGroupId))).toBe(true);
  });

  it("fails closed on a malformed ciphertext", async () => {
    const { bob, bobGroup } = await twoPartyDM();
    await expect(bob.decryptMessage(bobGroup, new Uint8Array([1, 2, 3]))).rejects.toThrow();
  });

  it("decrypting against an unknown group throws", async () => {
    const { bob } = await twoPartyDM();
    await expect(
      bob.decryptMessage({ mlsGroupId: new Uint8Array([9, 9, 9]), epoch: 0n }, new Uint8Array([1]))
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `pnpm test -- ts-mls/crypto`
Expected: FAIL — `not implemented yet (Task 4)`.

- [ ] **Step 3: Replace the Task-4 stubs with real implementations**

In `packages/secure-chat/crypto/src/ts-mls/crypto.ts`, delete the eight `Task 4` stub lines (`createGroup` … `processProposal`) and insert these method bodies:
```ts
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
```

Also add this private helper next to the other helpers (above `serializeDeviceState`):
```ts
  // Best-effort sender attribution for a DM: the one member that isn't us. Real per-message sender
  // attribution for >2-member groups arrives with multi-device (Phase 3); the server also attests
  // senderDeviceId on the message row independently.
  private peerDeviceId(state: ClientState): string {
    try {
      const me = toHex(this.device!.publicKey);
      for (const leaf of getGroupMembers(state)) {
        const id = new TextDecoder().decode(leaf.credential.identity);
        if (leaf.credential.credentialType === "basic" && toHex(leaf.signaturePublicKey) !== me) return id;
      }
    } catch { /* fall through */ }
    return "";
  }
```
And extend the ts-mls import to include `getGroupMembers`:
```ts
import {
  generateKeyPackageWithKey, makeKeyPackageRef, defaultCapabilities, defaultLifetime,
  createGroup, createCommit, joinGroup, createApplicationMessage, processMessage, getGroupMembers,
  encodeMlsMessage, decodeMlsMessage, encodeGroupState, decodeGroupState,
  acceptAll, emptyPskIndex, zeroOutUint8Array,
  type Credential, type CiphersuiteImpl, type KeyPackage, type PrivateKeyPackage, type ClientState,
} from "ts-mls";
```

> Note on `leaf.credential` / `leaf.signaturePublicKey`: `getGroupMembers` returns `LeafNode[]`. If the property paths differ in the installed types, adjust to the `.d.ts` (the characterization test imports give you the shapes); `peerDeviceId` is best-effort and falls back to `""`, so a mismatch degrades gracefully rather than breaking decryption.

- [ ] **Step 4: Run it; verify it passes**

Run: `pnpm test -- ts-mls/crypto`
Expected: PASS (device test from Task 3 + 4 new DM tests).

- [ ] **Step 5: Commit**

```bash
git add packages/secure-chat/crypto/src/ts-mls/crypto.ts packages/secure-chat/crypto/src/ts-mls/crypto.test.ts
git commit -m "feat(crypto): ts-mls group lifecycle + application messages"
```

---

## Task 5: State serialization (persistence)

Replace the Task-5 stubs so group + device state round-trip through bytes onto a **fresh** instance — the contract the existing IndexedDB persistence layer relies on. No persistence-layer changes.

**Files:**
- Modify: `packages/secure-chat/crypto/src/ts-mls/crypto.ts`
- Test: `packages/secure-chat/crypto/src/ts-mls/crypto.test.ts`

- [ ] **Step 1: Add the failing persistence test**

Append to `packages/secure-chat/crypto/src/ts-mls/crypto.test.ts`:
```ts
describe("TsMlsSecureChatCrypto: persistence round-trips", () => {
  it("a fresh instance restores device + group state and keeps decrypting", async () => {
    const { alice, bob, aliceGroup, bobGroup } = await twoPartyDM();

    // alice sends one message before the "reload".
    const m1 = await alice.encryptMessage(aliceGroup, new TextEncoder().encode("before reload"));
    expect(fromUtf8((await bob.decryptMessage(bobGroup, m1.ciphertext)).plaintext)).toBe("before reload");

    // Snapshot bob, then rebuild him on a brand-new instance from the blobs alone.
    const deviceBlob = await bob.exportDeviceState();
    const groupBlob = await bob.exportGroupState(bobGroup);

    const bob2 = new TsMlsSecureChatCrypto();
    await bob2.importDeviceState(deviceBlob);
    const bobGroup2 = await bob2.importGroupState(groupBlob);
    expect(Buffer.from(bobGroup2.mlsGroupId).equals(Buffer.from(bobGroup.mlsGroupId))).toBe(true);

    // alice sends again; the restored bob decrypts it.
    const m2 = await alice.encryptMessage(aliceGroup, new TextEncoder().encode("after reload"));
    expect(fromUtf8((await bob2.decryptMessage(bobGroup2, m2.ciphertext)).plaintext)).toBe("after reload");
  });

  it("exportBackup/importBackup are explicitly deferred (task 5 UX)", async () => {
    const c = new TsMlsSecureChatCrypto();
    await c.generateDeviceIdentity({ deviceId: "x" });
    await expect(c.exportBackup("pw")).rejects.toThrow(/not implemented/);
  });
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `pnpm test -- ts-mls/crypto`
Expected: FAIL — `not implemented yet (Task 5)` on `exportGroupState`/`importGroupState`/`importDeviceState`.

- [ ] **Step 3: Replace the Task-5 stubs with real implementations**

In `packages/secure-chat/crypto/src/ts-mls/crypto.ts`, delete the three `Task 5` stub lines (`exportGroupState`, `importGroupState`, `importDeviceState`) and the temporary `exportDeviceState` one-liner, and insert:
```ts
  async exportGroupState(group: GroupHandle): Promise<Uint8Array> {
    // ClientState = GroupState & { clientConfig }. encodeGroupState serializes the GroupState; the
    // clientConfig (which holds non-serializable callbacks) is reattached from the default on import.
    return encodeGroupState(this.lookupGroup(group));
  }

  async importGroupState(state: Uint8Array): Promise<GroupHandle> {
    const decoded = decodeGroupState(state, 0);
    if (!decoded) throw new Error("secure-chat: corrupt group state");
    const clientState: ClientState = { ...decoded[0], clientConfig: defaultClientConfig };
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
```
Add `fromHex` to the hex import at the top of the file:
```ts
import { toHex, fromHex } from "./hex.js";
```

- [ ] **Step 4: Run it; verify it passes**

Run: `pnpm test -- ts-mls/crypto`
Expected: PASS (all crypto tests).

- [ ] **Step 5: Commit**

```bash
git add packages/secure-chat/crypto/src/ts-mls/crypto.ts packages/secure-chat/crypto/src/ts-mls/crypto.test.ts
git commit -m "feat(crypto): ts-mls group + device state serialization"
```

---

## Task 6: Package the opt-in `./ts-mls` subpath (ESM-only) + build

Expose `createTsMlsSecureChatCrypto()` on `@agora-sdk/secure-chat-crypto/ts-mls`, ESM-only (ts-mls is ESM-only), keeping the bare entry + `./testing` dual and dependency-free.

**Files:**
- Create: `packages/secure-chat/crypto/src/ts-mls/index.ts`
- Modify: `packages/secure-chat/crypto/package.json`, `packages/secure-chat/crypto/tsconfig.cjs.json`

- [ ] **Step 1: Create the public entry**

Create `packages/secure-chat/crypto/src/ts-mls/index.ts`:
```ts
// @agora-sdk/secure-chat-crypto/ts-mls — the real RFC 9420 MLS core (ESM-only; pulls in ts-mls).
//
// Opt-in subpath so the heavy core is loaded ONLY by consumers that import it; the bare entry
// (interface) and ./testing (mock) stay dependency-free. ESM-only because ts-mls is ESM-only.
import { TsMlsSecureChatCrypto, type TsMlsSecureChatCryptoOptions } from "./crypto.js";
import type { SecureChatCrypto } from "../interface.js";

export { TsMlsSecureChatCrypto, type TsMlsSecureChatCryptoOptions } from "./crypto.js";

/**
 * Create the real ts-mls {@link SecureChatCrypto} for injection into `<SecureChatProvider crypto={…}>`.
 *
 * @param options - {@link TsMlsSecureChatCryptoOptions}; defaults to ciphersuite 1.
 * @returns A ready `SecureChatCrypto` backed by ts-mls.
 * @example
 * ```ts
 * import { createTsMlsSecureChatCrypto } from "@agora-sdk/secure-chat-crypto/ts-mls";
 * const crypto = createTsMlsSecureChatCrypto();
 * ```
 */
export function createTsMlsSecureChatCrypto(options?: TsMlsSecureChatCryptoOptions): SecureChatCrypto {
  return new TsMlsSecureChatCrypto(options);
}
```

- [ ] **Step 2: Exclude `ts-mls/` from the CJS build**

Edit `packages/secure-chat/crypto/tsconfig.cjs.json` to add an `exclude` (the CJS build must not emit `require("ts-mls")`, which would fail at runtime since ts-mls is ESM-only):
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist/cjs",
    "module": "commonjs",
    "moduleResolution": "node",
    "ignoreDeprecations": "5.0"
  },
  "exclude": ["recycle_bin", "dist", "**/*.test.ts", "**/*.test.tsx", "src/ts-mls/**"]
}
```

- [ ] **Step 3: Add the dep + the ESM-only export**

Edit `packages/secure-chat/crypto/package.json`: add `"ts-mls": "1.6.2"` to `dependencies` (Task 1 already did via `pnpm add`; confirm it's pinned without a caret), and add the subpath to `exports` (note: `import` + `types` only — no `require`):
```json
  "exports": {
    ".": {
      "types": "./dist/esm/index.d.ts",
      "import": "./dist/esm/index.js",
      "require": "./dist/cjs/index.js"
    },
    "./testing": {
      "types": "./dist/esm/testing.d.ts",
      "import": "./dist/esm/testing.js",
      "require": "./dist/cjs/testing.js"
    },
    "./ts-mls": {
      "types": "./dist/esm/ts-mls/index.d.ts",
      "import": "./dist/esm/ts-mls/index.js"
    }
  },
```

- [ ] **Step 4: Build the package and verify dist**

Run:
```bash
pnpm --filter @agora-sdk/secure-chat-crypto run build && pnpm run verify:dist
```
Expected: build succeeds; `dist/esm/ts-mls/index.js` exists; `dist/cjs/ts-mls/` does **not** exist; `verify:dist` passes (its ESM static lint scans `dist/esm/ts-mls/*.js` for extensionless relative imports — we use `.js` — and its runtime smoke-load of the crypto root still loads the interface-only entry, which never imports ts-mls).

- [ ] **Step 5: Typecheck + full unit suite**

Run: `pnpm run typecheck && pnpm test`
Expected: typecheck clean; all unit tests pass (existing 44 + characterization + ciphersuite + crypto tests).

- [ ] **Step 6: Commit**

```bash
git add packages/secure-chat/crypto/src/ts-mls/index.ts packages/secure-chat/crypto/package.json packages/secure-chat/crypto/tsconfig.cjs.json pnpm-lock.yaml
git commit -m "feat(crypto): publish opt-in ./ts-mls subpath (ESM-only real MLS core)"
```

---

## Task 7: Wire react-js + prove with the e2e (mock + real core)

Make `react-js`'s web crypto return the real core, and parametrize the existing e2e to run the full round-trip with **both** the mock and the real ts-mls core against a running agora-server.

**Files:**
- Modify: `packages/secure-chat/react-js/package.json`, `packages/secure-chat/react-js/src/crypto-web.ts`
- Create: `e2e/crypto-factory.ts`
- Modify: `e2e/secure-chat.e2e.ts`

- [ ] **Step 1: Depend on the crypto package from react-js**

Edit `packages/secure-chat/react-js/package.json` — add to `dependencies`:
```json
  "dependencies": {
    "@agora-sdk/secure-chat-core": "workspace:*",
    "@agora-sdk/secure-chat-crypto": "workspace:*"
  },
```
Run: `pnpm install`
Expected: workspace link added.

- [ ] **Step 2: Return the real core from crypto-web**

Replace the body of `packages/secure-chat/react-js/src/crypto-web.ts`:
```ts
// Web `SecureChatCrypto` — the real ts-mls MLS core (Phase 2).
//
// Wires the concrete RFC 9420 implementation from @agora-sdk/secure-chat-crypto/ts-mls. All MLS crypto
// runs client-side behind the seam; the server only ever relays opaque base64 blobs. For tests / early
// UI work, inject `MockSecureChatCrypto` from `@agora-sdk/secure-chat-crypto/testing` instead.
import type { SecureChatCrypto } from "@agora-sdk/secure-chat-core";
import { createTsMlsSecureChatCrypto } from "@agora-sdk/secure-chat-crypto/ts-mls";

/**
 * Create the web `SecureChatCrypto` (real ts-mls MLS core) for `<SecureChatProvider crypto={…}>`.
 *
 * @returns A ready ts-mls-backed `SecureChatCrypto`.
 * @example
 * ```tsx
 * <SecureChatProvider crypto={createWebSecureChatCrypto()} …>
 * ```
 */
export function createWebSecureChatCrypto(): SecureChatCrypto {
  return createTsMlsSecureChatCrypto();
}
```

- [ ] **Step 3: Extract a named crypto factory for the e2e**

Create `e2e/crypto-factory.ts`:
```ts
// The crypto implementations the e2e runs against. The same transport round-trip is proven twice:
// with the deterministic mock (fast smoke) and with the real ts-mls core (the real proof — genuine
// MLS blobs relayed by the blind server, recipient joining from the Welcome alone).
import type { SecureChatCrypto } from "../packages/secure-chat/core/src/index.js";
import { MockSecureChatCrypto } from "../packages/secure-chat/crypto/src/testing.js";
import { createTsMlsSecureChatCrypto } from "../packages/secure-chat/crypto/src/ts-mls/index.js";

/** A named crypto factory: a label for the test name + a constructor for a fresh per-device instance. */
export interface CryptoVariant {
  name: string;
  make: () => SecureChatCrypto;
}

export const CRYPTO_VARIANTS: CryptoVariant[] = [
  { name: "MockSecureChatCrypto", make: () => new MockSecureChatCrypto() },
  { name: "ts-mls", make: () => createTsMlsSecureChatCrypto() },
];
```

- [ ] **Step 4: Parametrize the e2e over the factory**

In `e2e/secure-chat.e2e.ts`: (a) add `import { CRYPTO_VARIANTS } from "./crypto-factory.js";`, (b) remove the two hard-coded `new MockSecureChatCrypto()` lines, (c) wrap the existing `describe.skipIf(!env)(...)` body in a loop so each variant runs the whole suite with its own crypto. Concretely, change the describe wrapper:
```ts
// before:  describe.skipIf(!env)("secure-chat foundation (real transport vs running agora-server)", () => {
// after:
for (const variant of CRYPTO_VARIANTS) {
  describe.skipIf(!env)(`secure-chat foundation [${variant.name}] (real transport vs running agora-server)`, () => {
    const aliceCrypto = variant.make();
    const bobCrypto = variant.make();
    // …the rest of the existing block is UNCHANGED…
  });
}
```
Delete the old `const aliceCrypto = new MockSecureChatCrypto();` / `const bobCrypto = new MockSecureChatCrypto();` declarations (now provided by `variant.make()`), and the now-unused `MockSecureChatCrypto` import.

- [ ] **Step 5: Build crypto, then run the e2e against the running server**

Run:
```bash
pnpm --filter @agora-sdk/secure-chat-crypto run build
export AGORA_E2E_DATABASE_URL="$(grep -E '^DATABASE_URL=' ../agora-server/.env | head -1 | cut -d= -f2- | tr -d '"')"
export AGORA_E2E_ACCESS_TOKEN_SECRET="$(grep -E '^ACCESS_TOKEN_SECRET=' ../agora-server/.env | head -1 | cut -d= -f2- | tr -d '"')"
pnpm test:e2e
```
Expected: PASS — the full suite runs **twice** (once `[MockSecureChatCrypto]`, once `[ts-mls]`): register → DM → send → receive → server-blindness → realtime fan-out → reload, all green, including the real-MLS run where bob joins from the Welcome alone. (Server must be up: in `../agora-server`, `pnpm dev:api`.)

- [ ] **Step 6: Confirm unit suite + typecheck still green**

Run: `pnpm test && pnpm run typecheck`
Expected: both green; `pnpm test` does not touch the server (e2e is a separate config).

- [ ] **Step 7: Commit**

```bash
git add packages/secure-chat/react-js/package.json packages/secure-chat/react-js/src/crypto-web.ts e2e/crypto-factory.ts e2e/secure-chat.e2e.ts pnpm-lock.yaml
git commit -m "feat(react-js): wire real ts-mls web crypto + prove via mock+ts-mls e2e"
```

---

## Task 8: Docs — CHANGELOG, ROADMAP, STATUS

**Files:** Modify `CHANGELOG.md`, `packages/secure-chat/ROADMAP.md`, `STATUS.md`

- [ ] **Step 1: CHANGELOG**

Under `## [Unreleased]` → `### Added` in `CHANGELOG.md`, add:
```markdown
- **Real MLS core (Phase 2 task 1).** `@agora-sdk/secure-chat-crypto/ts-mls` —
  `createTsMlsSecureChatCrypto()`, a real RFC 9420 implementation of `SecureChatCrypto` built on
  **ts-mls** (pure TS; ciphersuite 1), on an opt-in ESM-only subpath so the bare entry + `./testing`
  mock stay dependency-free. Recipients join from the Welcome alone (`ratchetTreeExtension`); group +
  device state persist via ts-mls's `encodeGroupState`/`decodeGroupState` into the existing IndexedDB
  layer (no persistence changes). `react-js`'s `createWebSecureChatCrypto()` now returns it. Proven by
  running the foundation e2e a second time with the real core (genuine MLS blobs through the blind
  server). Backup KDF (task 5), metadata padding (task 6), generation-counter enforcement, and
  `removeMember`/native (Phase 3) remain deferred.
```

- [ ] **Step 2: ROADMAP — check task 1**

In `packages/secure-chat/ROADMAP.md`, change the three task-1 checkboxes (decide core / implement behind interface / replay-gap) to reflect: ts-mls chosen + implemented (`[x]`), generation-counter enforcement still `[ ]` with a note "core surfaces it via `processMessage`; enforcement deferred". Update the file-map row for `react-js/src/crypto-web.ts` from "throwing stub" to "returns the real ts-mls core".

- [ ] **Step 3: STATUS — record the decision**

In `STATUS.md`, under the Phase 2 section, record: "MLS core = **ts-mls 1.6.2** (decision 2026-06-07); pure TS, ciphersuite 1, opt-in `./ts-mls` subpath; chosen over OpenMLS/mls-rs WASM for the same-JS web→native path."

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md packages/secure-chat/ROADMAP.md STATUS.md
git commit -m "docs: record the real ts-mls MLS core (Phase 2 task 1)"
```

---

## Self-review notes (coverage)

- **Spec §Decisions** (ts-mls, suite 1, opt-in subpath, persistence via existing layer, join-from-Welcome, e2e proof) → Tasks 1–8. ✅
- **Spec §Interface mapping** (every `SecureChatCrypto` method) → Tasks 3–5; `removeMember` + `export/importBackup` are the spec's named deferrals (explicit throws). ✅
- **Spec §Security** (no plaintext/keys on wire/logs, CSPRNG, fail closed, zeroize, blind/untrusted) → encoded in `crypto.ts` bodies + comments; `peerDeviceId` best-effort with server-attested fallback noted. ✅
- **Spec §Risks** — join-from-Welcome resolved by `ratchetTreeExtension: true` (pinned in Task 1); `ClientState` serialization resolved by `encode/decodeGroupState` + `defaultClientConfig` reattach (pinned in Task 1). ✅
- **Spec §Testing / DoD** — unit (Tasks 2–5), dual e2e (Task 7), `pnpm test`/`typecheck`/`verify:dist` gates (Task 6–7). ✅
- **Type consistency:** `TsMlsSecureChatCrypto`, `createTsMlsSecureChatCrypto`, `TsMlsSecureChatCryptoOptions`, `CryptoVariant`, `loadCiphersuite`/`ciphersuiteNameFromId`/`ciphersuiteIdFromName`/`DEFAULT_CIPHERSUITE_ID`, `toHex`/`fromHex` used consistently across tasks. ✅
- **Residual library-shape risks** (flagged inline, all fail-soft): `getGroupMembers` leaf property paths (`peerDeviceId` falls back to `""`); exact `LeafNode` credential field names. Task 1's characterization test + the installed `.d.ts` are the ground truth; adjust call sites to them, never the library.
