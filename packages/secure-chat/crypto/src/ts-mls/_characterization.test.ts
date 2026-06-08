// Characterization test: pins the exact ts-mls 1.6.2 API the wrapper depends on. Not a wrapper test —
// it exercises the raw library so a future ts-mls upgrade that changes a signature fails HERE, loudly,
// with a minimal repro. Proves: two-party DM, recipient joins from the Welcome ALONE, state round-trips.
import { describe, it, expect } from "vitest";
import {
  ciphersuites, getCiphersuiteFromName, getCiphersuiteImpl,
  generateKeyPackageWithKey, defaultCapabilities, defaultLifetime,
  createGroup, createCommit, joinGroup, createApplicationMessage, processMessage,
  encodeMlsMessage, decodeMlsMessage, encodeGroupState, decodeGroupState,
  acceptAll, emptyPskIndex, type Credential, type CiphersuiteName,
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
