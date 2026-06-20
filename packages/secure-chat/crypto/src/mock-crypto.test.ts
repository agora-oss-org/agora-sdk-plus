// Tests for MockSecureChatCrypto — the deterministic test double behind the SecureChatCrypto seam.
//
// Imports the public `./testing` entry (same path consumers use as
// `@agora-sdk/secure-chat-crypto/testing`). These assert the two properties the rest of the suite
// leans on: encryption HIDES the plaintext (server-blindness is meaningful), and a SECOND instance
// can join via the Welcome and decrypt the first's messages (two-party delivery).

import { describe, it, expect } from "vitest";
import { MockSecureChatCrypto } from "./testing";
import { SecureChatDecryptError } from "./interface.js";

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

  it("returns the restored device identity (symmetric with importDeviceState)", async () => {
    const alice = new MockSecureChatCrypto();
    const { identity } = await alice.generateDeviceIdentity({ deviceId: "alice-dev", ciphersuite: 1 });
    const backup = await alice.exportBackup("correct horse");

    const restored = new MockSecureChatCrypto();
    const got = await restored.importBackup("correct horse", backup);
    expect(got.deviceId).toBe("alice-dev");
    expect(got.ciphersuite).toBe(1);
    expect(Array.from(got.signaturePublicKey)).toEqual(Array.from(identity.signaturePublicKey));
  });
});

describe("MockSecureChatCrypto decrypt failures", () => {
  it("surfaces decrypt failures as a typed SecureChatDecryptError (consistent with the real core)", async () => {
    const c = new MockSecureChatCrypto();
    const err = await c
      .decryptMessage({ mlsGroupId: new Uint8Array([9, 9, 9]), epoch: 0n }, new Uint8Array([1]))
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(SecureChatDecryptError);
    expect((err as SecureChatDecryptError).reason).toBe("unknown");
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

describe("MockSecureChatCrypto exportSecret (seam contract)", () => {
  // Compare bytes via Array.from(...) — the two crypto instances live in the same realm here, but the
  // habit keeps these assertions cross-realm safe and matches the ts-mls tests.
  const eq = (a: Uint8Array, b: Uint8Array) => expect(Array.from(a)).toEqual(Array.from(b));
  const ne = (a: Uint8Array, b: Uint8Array) => expect(Array.from(a)).not.toEqual(Array.from(b));

  it("is deterministic: same (group,label,context,length) → identical bytes", async () => {
    const { alice, aliceGroup } = await twoPartyGroup();
    const a = await alice.exportSecret(aliceGroup, "iuc-sas-v1", utf8("ctx"), 32);
    const b = await alice.exportSecret(aliceGroup, "iuc-sas-v1", utf8("ctx"), 32);
    eq(a, b);
  });

  it("is domain-separated: a different label or context changes the output", async () => {
    const { alice, aliceGroup } = await twoPartyGroup();
    const base = await alice.exportSecret(aliceGroup, "iuc-sas-v1", utf8("ctx"), 32);
    const otherLabel = await alice.exportSecret(aliceGroup, "iuc-sas-v2", utf8("ctx"), 32);
    const otherContext = await alice.exportSecret(aliceGroup, "iuc-sas-v1", utf8("ctx2"), 32);
    ne(base, otherLabel);
    ne(base, otherContext);
  });

  it("is group-bound: both members derive identical bytes; a non-member throws", async () => {
    const { alice, bob, aliceGroup, bobGroup } = await twoPartyGroup();
    // alice and bob joined the same group (the secret rode the Welcome) → same exporter output.
    const a = await alice.exportSecret(aliceGroup, "iuc-sas-v1", new Uint8Array(), 32);
    const b = await bob.exportSecret(bobGroup, "iuc-sas-v1", new Uint8Array(), 32);
    eq(a, b);
    // a fresh instance that never joined any group fails closed.
    const stranger = new MockSecureChatCrypto();
    await expect(stranger.exportSecret(aliceGroup, "iuc-sas-v1", new Uint8Array(), 32)).rejects.toThrow(
      /unknown group/
    );
  });

  it("honors the requested length", async () => {
    const { alice, aliceGroup } = await twoPartyGroup();
    for (const len of [16, 32, 64]) {
      const out = await alice.exportSecret(aliceGroup, "iuc-sas-v1", new Uint8Array(), len);
      expect(out.length).toBe(len);
    }
  });

  it("fails closed on length <= 0", async () => {
    const { alice, aliceGroup } = await twoPartyGroup();
    await expect(alice.exportSecret(aliceGroup, "iuc-sas-v1", new Uint8Array(), 0)).rejects.toThrow(
      /length must be > 0/
    );
  });
});
