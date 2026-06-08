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

});

describe("TsMlsSecureChatCrypto: passphrase backup/restore", () => {
  // argon2id at the high-memory profile is slow; allow extra time for these.
  const SLOW = 30_000;

  it("restores device identity + group state into a fresh instance, which keeps decrypting", async () => {
    const { alice, bob, aliceGroup, bobGroup } = await twoPartyDM();
    const m1 = await alice.encryptMessage(aliceGroup, new TextEncoder().encode("before backup"));
    expect(fromUtf8((await bob.decryptMessage(bobGroup, m1.ciphertext)).plaintext)).toBe("before backup");

    // bob backs up everything under a passphrase, then is rebuilt from the blob alone.
    const backup = await bob.exportBackup("correct horse battery staple");
    const bob2 = new TsMlsSecureChatCrypto();
    const identity = await bob2.importBackup("correct horse battery staple", backup);
    expect(identity.deviceId).toBe("bob-web"); // returns the restored identity (seam change)

    // alice sends again; the restored bob decrypts using the same group handle.
    const m2 = await alice.encryptMessage(aliceGroup, new TextEncoder().encode("after restore"));
    expect(fromUtf8((await bob2.decryptMessage(bobGroup, m2.ciphertext)).plaintext)).toBe("after restore");
  }, SLOW);

  it("fails closed on the wrong passphrase (no partial restore)", async () => {
    const c = new TsMlsSecureChatCrypto();
    await c.generateDeviceIdentity({ deviceId: "alice-web" });
    const backup = await c.exportBackup("right");
    const fresh = new TsMlsSecureChatCrypto();
    await expect(fresh.importBackup("wrong", backup)).rejects.toThrow();
  }, SLOW);
});
