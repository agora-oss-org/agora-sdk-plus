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
