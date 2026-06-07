// Tests for MockSecureChatCrypto — the deterministic test double behind the SecureChatCrypto seam.
//
// Imports the public `./testing` entry (same path consumers use as
// `@agora-sdk/secure-chat-crypto/testing`). These assert the two properties the rest of the suite
// leans on: encryption HIDES the plaintext (server-blindness is meaningful), and a SECOND instance
// can join via the Welcome and decrypt the first's messages (two-party delivery).

import { describe, it, expect } from "vitest";
import { MockSecureChatCrypto } from "./testing";

const utf8 = (s: string) => new TextEncoder().encode(s);
const fromUtf8 = (b: Uint8Array) => new TextDecoder().decode(b);

/** True if `needle` appears as a contiguous byte subsequence of `haystack`. */
function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) return true;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/** Stand up two devices and a shared DM group; returns each side's group handle. */
async function twoPartyGroup() {
  const alice = new MockSecureChatCrypto();
  const bob = new MockSecureChatCrypto();
  await alice.generateDeviceIdentity({ deviceId: "alice-dev" });
  await bob.generateDeviceIdentity({ deviceId: "bob-dev" });

  const [bobKp] = await bob.generateKeyPackages(1);
  const { group: aliceGroup, welcomes } = await alice.createGroup({
    initialMembers: [{ deviceId: "bob-dev", keyPackage: bobKp.keyPackage }],
  });
  const welcome = welcomes.find((w) => w.targetDeviceId === "bob-dev")!;
  const bobGroup = await bob.processWelcome(welcome.payload);

  return { alice, bob, aliceGroup, bobGroup };
}

describe("MockSecureChatCrypto identity + key packages", () => {
  it("generates the requested number of uniquely-referenced KeyPackages", async () => {
    const c = new MockSecureChatCrypto();
    await c.generateDeviceIdentity({ deviceId: "dev-1" });
    const kps = await c.generateKeyPackages(3);
    expect(kps).toHaveLength(3);
    expect(new Set(kps.map((k) => k.keyPackageRef)).size).toBe(3);
  });
});

describe("MockSecureChatCrypto group messaging", () => {
  it("delivers a message from one instance to another via the Welcome", async () => {
    const { alice, bob, aliceGroup, bobGroup } = await twoPartyGroup();

    const { ciphertext, epoch } = await alice.encryptMessage(aliceGroup, utf8("hi bob 💜"));
    const decrypted = await bob.decryptMessage(bobGroup, ciphertext);

    expect(fromUtf8(decrypted.plaintext)).toBe("hi bob 💜");
    expect(decrypted.senderDeviceId).toBe("alice-dev");
    expect(decrypted.epoch).toBe(epoch);
  });

  it("hides the plaintext in the ciphertext (server stays blind)", async () => {
    const { alice, aliceGroup } = await twoPartyGroup();
    const plaintext = utf8("the eagle lands at midnight");
    const { ciphertext } = await alice.encryptMessage(aliceGroup, plaintext);
    expect(contains(ciphertext, plaintext)).toBe(false);
  });

  it("throws when encrypting against an unknown group", async () => {
    const c = new MockSecureChatCrypto();
    await c.generateDeviceIdentity({ deviceId: "lonely" });
    await expect(
      c.encryptMessage({ mlsGroupId: new Uint8Array([1, 2, 3]), epoch: 0n }, utf8("x"))
    ).rejects.toThrow(/unknown group/);
  });
});

describe("MockSecureChatCrypto passphrase backup", () => {
  it("restores group state into a fresh instance with the right passphrase", async () => {
    const { alice, aliceGroup } = await twoPartyGroup();
    const { ciphertext } = await alice.encryptMessage(aliceGroup, utf8("remembered"));

    const backup = await alice.exportBackup("correct horse");
    const restored = new MockSecureChatCrypto();
    await restored.importBackup("correct horse", backup);

    const out = await restored.decryptMessage(aliceGroup, ciphertext);
    expect(fromUtf8(out.plaintext)).toBe("remembered");
  });

  it("rejects a backup opened with the wrong passphrase", async () => {
    const alice = new MockSecureChatCrypto();
    await alice.generateDeviceIdentity({ deviceId: "alice-dev" });
    const backup = await alice.exportBackup("correct horse");

    const restored = new MockSecureChatCrypto();
    await expect(restored.importBackup("battery staple", backup)).rejects.toThrow(
      /wrong passphrase/
    );
  });
});

describe("MockSecureChatCrypto device-state persistence", () => {
  it("re-hydrates identity into a fresh instance and decrypts a rejoined group", async () => {
    const { alice, aliceGroup } = await twoPartyGroup();
    const { ciphertext } = await alice.encryptMessage(aliceGroup, utf8("after reload"));
    const deviceState = await alice.exportDeviceState();
    const groupState = await alice.exportGroupState(aliceGroup);

    const restored = new MockSecureChatCrypto();
    const identity = await restored.importDeviceState(deviceState);
    expect(identity.deviceId).toBe("alice-dev");

    const handle = await restored.importGroupState(groupState);
    const out = await restored.decryptMessage(handle, ciphertext);
    expect(fromUtf8(out.plaintext)).toBe("after reload");
  });

  it("throws when exporting with no identity generated", async () => {
    const c = new MockSecureChatCrypto();
    await expect(c.exportDeviceState()).rejects.toThrow(/no device identity/);
  });
});
