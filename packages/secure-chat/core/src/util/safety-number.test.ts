import { describe, it, expect } from "vitest";
import { computeSafetyNumber } from "./safety-number.js";
import type { GroupMemberIdentity } from "@agora-sdk/secure-chat-crypto";

const id = (deviceId: string, seed: number): GroupMemberIdentity => ({
  deviceId,
  signaturePublicKey: new Uint8Array(32).fill(seed),
});

const alice = id("alice", 1);
const bob = id("bob", 2);

describe("computeSafetyNumber", () => {
  it("produces 60 digits as 12 groups of 5", async () => {
    const sn = await computeSafetyNumber(alice, bob);
    expect(sn.digits).toHaveLength(60);
    expect(sn.digits).toMatch(/^[0-9]{60}$/);
    expect(sn.groups).toHaveLength(12);
    for (const g of sn.groups) expect(g).toMatch(/^[0-9]{5}$/);
    expect(sn.groups.join("")).toBe(sn.digits);
  });

  it("is symmetric: compute(a,b) === compute(b,a)", async () => {
    const ab = await computeSafetyNumber(alice, bob);
    const ba = await computeSafetyNumber(bob, alice);
    expect(ab.digits).toBe(ba.digits);
    expect(Array.from(ab.fingerprint)).toEqual(Array.from(ba.fingerprint));
  });

  it("is deterministic for the same inputs", async () => {
    const a = await computeSafetyNumber(alice, bob);
    const b = await computeSafetyNumber(alice, bob);
    expect(a.digits).toBe(b.digits);
  });

  it("changes when a signature key changes (MITM detection)", async () => {
    const base = await computeSafetyNumber(alice, bob);
    const swapped = await computeSafetyNumber(alice, id("bob", 3)); // attacker key for bob
    expect(swapped.digits).not.toBe(base.digits);
  });

  it("changes when a device id changes", async () => {
    const base = await computeSafetyNumber(alice, bob);
    const renamed = await computeSafetyNumber(alice, id("mallory", 2)); // same key, different id
    expect(renamed.digits).not.toBe(base.digits);
  });
});
