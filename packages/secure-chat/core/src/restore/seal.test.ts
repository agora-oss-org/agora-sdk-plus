// Blob AEAD tests — the E2EE core of the ENVELOPE path. seal/open round-trip, and every tamper/replay
// vector (wrong key, flipped byte, mismatched AAD descriptor, short input) MUST fail closed.
import { describe, it, expect } from "vitest";
import {
  generateRestoreKey, restoreAad, sealRestoreBlob, openRestoreBlob,
  SecureRestoreSealError, type RestoreDescriptor,
} from "./seal.js";

const utf8 = (s: string) => new TextEncoder().encode(s);

function descriptor(over: Partial<RestoreDescriptor> = {}): RestoreDescriptor {
  return {
    transferId: new Uint8Array([1, 2, 3, 4]),
    conversationId: "conv-1",
    fromDeviceId: "dev-A",
    targetDeviceId: "dev-B",
    chunkIndex: 0,
    chunkCount: 1,
    ...over,
  };
}

/** True if `needle` appears as a contiguous byte subsequence of `haystack`. */
function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) return true;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

describe("restore seal: key", () => {
  it("generates a 32-byte key; two keys differ", () => {
    const a = generateRestoreKey();
    expect(a.length).toBe(32);
    expect([...a]).not.toEqual([...generateRestoreKey()]);
  });
});

describe("restore seal: round-trip + blindness", () => {
  it("seal→open returns the original plaintext under the same K + AAD", () => {
    const K = generateRestoreKey();
    const aad = restoreAad(descriptor());
    const pt = utf8("the eagle lands at midnight 💜");
    const blob = sealRestoreBlob(K, pt, aad);
    expect([...openRestoreBlob(K, blob, aad)]).toEqual([...pt]);
  });
  it("the sealed blob never contains the plaintext bytes (server-blind)", () => {
    const K = generateRestoreKey();
    const pt = utf8("the nuclear codes are 0000");
    const blob = sealRestoreBlob(K, pt, restoreAad(descriptor()));
    expect(contains(blob, pt)).toBe(false);
  });
  it("prepends a fresh 24-byte nonce → same plaintext seals to different blobs", () => {
    const K = generateRestoreKey();
    const aad = restoreAad(descriptor());
    const pt = utf8("x");
    expect([...sealRestoreBlob(K, pt, aad)]).not.toEqual([...sealRestoreBlob(K, pt, aad)]);
  });
});

describe("restore seal: fail closed", () => {
  it("wrong K → throws SecureRestoreSealError", () => {
    const aad = restoreAad(descriptor());
    const blob = sealRestoreBlob(generateRestoreKey(), utf8("hi"), aad);
    expect(() => openRestoreBlob(generateRestoreKey(), blob, aad)).toThrow(SecureRestoreSealError);
  });
  it("a single flipped ciphertext byte → throws", () => {
    const K = generateRestoreKey();
    const aad = restoreAad(descriptor());
    const blob = sealRestoreBlob(K, utf8("hi"), aad);
    blob[blob.length - 1] ^= 0x01;
    expect(() => openRestoreBlob(K, blob, aad)).toThrow(SecureRestoreSealError);
  });
  it("a mismatched AAD descriptor → throws (replay-into-another-slot defense)", () => {
    const K = generateRestoreKey();
    const blob = sealRestoreBlob(K, utf8("hi"), restoreAad(descriptor({ chunkIndex: 0 })));
    // Same transfer, different slot → AAD differs → open fails closed.
    expect(() => openRestoreBlob(K, blob, restoreAad(descriptor({ chunkIndex: 1 }))))
      .toThrow(SecureRestoreSealError);
  });
  it("a blob shorter than the nonce → throws", () => {
    expect(() => openRestoreBlob(generateRestoreKey(), new Uint8Array(8), restoreAad(descriptor())))
      .toThrow(SecureRestoreSealError);
  });
});

describe("restore seal: AAD determinism", () => {
  it("restoreAad is byte-stable for equal descriptors and differs on any field", () => {
    expect([...restoreAad(descriptor())]).toEqual([...restoreAad(descriptor())]);
    expect([...restoreAad(descriptor())]).not.toEqual([...restoreAad(descriptor({ fromDeviceId: "dev-C" }))]);
  });
});
