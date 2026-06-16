// Characterization test: pins the exact ts-mls 1.6.2 API the wrapper depends on. Not a wrapper test —
// it exercises the raw library so a future ts-mls upgrade that changes a signature fails HERE, loudly,
// with a minimal repro. Proves: two-party DM, recipient joins from the Welcome ALONE, state round-trips.
import { describe, it, expect } from "vitest";
import {
  ciphersuites, getCiphersuiteFromName, getCiphersuiteImpl,
  generateKeyPackageWithKey, defaultCapabilities, defaultLifetime,
  createGroup, createCommit, joinGroup, createApplicationMessage, processMessage,
  encodeMlsMessage, decodeMlsMessage, encodeGroupState, decodeGroupState,
  acceptAll, emptyPskIndex, defaultKeyRetentionConfig,
  type Credential, type CiphersuiteName,
} from "ts-mls";
// makeKeyPackageRef + defaultClientConfig aren't re-exported from the package root; ts-mls exposes
// every module via its "./*.js" export, so deep-import them.
import { makeKeyPackageRef } from "ts-mls/keyPackage.js";
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
    const bobState = await joinGroup(commit.welcome!, bob.kp.publicPackage, bob.kp.privatePackage, emptyPskIndex, cs);
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

// Pins ts-mls's secret-tree ratchet behavior — the replay/gap enforcement our SDK relies on (and must
// not re-implement). If a future ts-mls upgrade silently weakens any of these, it fails HERE.
describe("ts-mls 1.6.2 generation-counter enforcement (characterization)", () => {
  // alice creates a DM and adds bob; bob joins with the given clientConfig (default unless overridden).
  async function setupDM(
    cs: Awaited<ReturnType<typeof getCiphersuiteImpl>>,
    bobConfig?: typeof defaultClientConfig
  ) {
    const alice = await device("alice", cs);
    const bob = await device("bob", cs);
    const groupId = crypto.getRandomValues(new Uint8Array(32));
    let aliceState = await createGroup(groupId, alice.kp.publicPackage, alice.kp.privatePackage, [], cs);
    const commit = await createCommit(
      { state: aliceState, cipherSuite: cs },
      { extraProposals: [{ proposalType: "add", add: { keyPackage: bob.kp.publicPackage } }], ratchetTreeExtension: true }
    );
    aliceState = commit.newState;
    const bobState = await joinGroup(
      commit.welcome!, bob.kp.publicPackage, bob.kp.privatePackage, emptyPskIndex, cs, undefined, undefined, bobConfig
    );
    return { aliceState, bobState };
  }

  const mkApp = async (
    cs: Awaited<ReturnType<typeof getCiphersuiteImpl>>,
    state: Awaited<ReturnType<typeof createGroup>>,
    text: string
  ) => {
    const app = await createApplicationMessage(state, utf8(text), cs);
    return {
      newState: app.newState,
      wire: encodeMlsMessage({ version: "mls10", wireformat: "mls_private_message", privateMessage: app.privateMessage }),
    };
  };
  const proc = (
    cs: Awaited<ReturnType<typeof getCiphersuiteImpl>>,
    wire: Uint8Array,
    state: Awaited<ReturnType<typeof joinGroup>>
  ) => processMessage(decodeMlsMessage(wire, 0)![0] as never, state, emptyPskIndex, acceptAll, cs);

  it("REJECTS a replayed application message (consumed generation)", async () => {
    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(NAME));
    let { aliceState, bobState } = await setupDM(cs);

    const m0 = await mkApp(cs, aliceState, "once");
    aliceState = m0.newState;

    const r0 = await proc(cs, m0.wire, bobState);
    expect(r0.kind).toBe("applicationMessage");
    bobState = r0.newState;

    // Replaying the exact same ciphertext fails closed: gen 0 is already consumed and not retained.
    await expect(proc(cs, m0.wire, bobState)).rejects.toThrow(/in the past/i);
  });

  it("ACCEPTS out-of-order delivery within the retention window", async () => {
    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(NAME));
    let { aliceState, bobState } = await setupDM(cs);

    const m0 = await mkApp(cs, aliceState, "first"); aliceState = m0.newState;
    const m1 = await mkApp(cs, aliceState, "second"); aliceState = m1.newState;

    // Deliver gen1 before gen0 — ts-mls skips forward and caches gen0's key.
    const r1 = await proc(cs, m1.wire, bobState);
    expect(r1.kind).toBe("applicationMessage");
    if (r1.kind === "applicationMessage") expect(fromUtf8(r1.message)).toBe("second");
    bobState = r1.newState;

    const r0 = await proc(cs, m0.wire, bobState); // the retained gen0 key decrypts the late arrival
    expect(r0.kind).toBe("applicationMessage");
    if (r0.kind === "applicationMessage") expect(fromUtf8(r0.message)).toBe("first");
  });

  it("REJECTS a forward gap larger than the configured window", async () => {
    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(NAME));
    // Tighten the window so the test is cheap: skip-forward limit of 3.
    const tight = {
      ...defaultClientConfig,
      keyRetentionConfig: { ...defaultKeyRetentionConfig, maximumForwardRatchetSteps: 3 },
    };
    let { aliceState, bobState } = await setupDM(cs, tight);

    // alice emits gens 0..4 without bob seeing 0..3; jumping straight to gen 4 skips 4 > 3.
    const wires: Uint8Array[] = [];
    for (let i = 0; i < 5; i++) {
      const m = await mkApp(cs, aliceState, `m${i}`);
      aliceState = m.newState;
      wires.push(m.wire);
    }
    await expect(proc(cs, wires[4]!, bobState)).rejects.toThrow(/too far in the future/i);
  });
});
