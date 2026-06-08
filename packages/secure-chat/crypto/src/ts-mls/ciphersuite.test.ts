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
