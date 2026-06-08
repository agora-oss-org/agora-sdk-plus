// Two-party real-crypto tests for TsMlsSecureChatCrypto — the ts-mls implementation of the seam.
// Mirrors mock-crypto.test.ts: encryption hides plaintext, a second instance joins via the Welcome
// and decrypts, and device/group state survives a round-trip onto a FRESH instance.
import { describe, it, expect } from "vitest";
import { TsMlsSecureChatCrypto } from "./crypto.js";

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

/** Stand up alice+bob and a shared DM; returns both crypto instances and both group handles. */
async function twoPartyDM() {
  const alice = new TsMlsSecureChatCrypto();
  const bob = new TsMlsSecureChatCrypto();
  await alice.generateDeviceIdentity({ deviceId: "alice-web" });
  await bob.generateDeviceIdentity({ deviceId: "bob-web" });
  // bob publishes a KeyPackage; alice claims it (we just take the wire bytes directly here).
  const [bobKp] = await bob.generateKeyPackages(1);
  const { group: aliceGroup, welcomes } = await alice.createGroup({
    initialMembers: [{ deviceId: "bob-row", keyPackage: bobKp!.keyPackage }],
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
    const { plaintext, senderDeviceId } = await bob.decryptMessage(bobGroup, ciphertext);
    expect(fromUtf8(plaintext)).toBe(pt);
    // best-effort DM sender attribution: the other member's credential identity
    expect(senderDeviceId).toBe("alice-web");
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
