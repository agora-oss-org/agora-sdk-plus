import { describe, it, expect } from "vitest";
import { sealBackup, openBackup, ARGON2_PARAMS } from "./backup.js";
import { fromHex } from "./hex.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

// argon2id at the high-memory profile is deliberately slow; give these a generous timeout.
const SLOW = 20_000;

describe("backup envelope codec (argon2id + xchacha20poly1305)", () => {
  it("round-trips: open(seal(x)) === x with the right passphrase", async () => {
    const plain = enc.encode("the quick brown fox jumps over the lazy dog");
    const sealed = await sealBackup(plain, "correct horse battery staple");
    const opened = await openBackup(sealed, "correct horse battery staple");
    expect(dec.decode(opened)).toBe("the quick brown fox jumps over the lazy dog");
  }, SLOW);

  it("emits a real argon2id + xchacha20poly1305 envelope (not the mock's fake KDF)", async () => {
    const sealed = await sealBackup(enc.encode("x"), "pw");
    expect(sealed.kdf).toBe("argon2id");
    expect(sealed.cipher).toBe("xchacha20poly1305");
    expect(sealed.version).toBe(1);
    expect(sealed.nonce).toHaveLength(24); // xchacha extended nonce
    const salt = fromHex((sealed.kdfParams as { salt: string }).salt);
    expect(salt).toHaveLength(16);
    expect(sealed.kdfParams).toMatchObject({ m: ARGON2_PARAMS.m, t: ARGON2_PARAMS.t, p: ARGON2_PARAMS.p });
    // The blob must not be the plaintext.
    expect(dec.decode(sealed.blob)).not.toContain("x");
  }, SLOW);

  it("uses a fresh random salt + nonce each call (same input → different ciphertext)", async () => {
    const a = await sealBackup(enc.encode("same"), "pw");
    const b = await sealBackup(enc.encode("same"), "pw");
    expect(a.nonce).not.toEqual(b.nonce);
    expect((a.kdfParams as { salt: string }).salt).not.toBe((b.kdfParams as { salt: string }).salt);
    expect(a.blob).not.toEqual(b.blob);
  }, SLOW);

  it("fails closed on the wrong passphrase (AEAD auth failure)", async () => {
    const sealed = await sealBackup(enc.encode("secret"), "right");
    await expect(openBackup(sealed, "wrong")).rejects.toThrow();
  }, SLOW);

  it("fails closed when the ciphertext blob is tampered", async () => {
    const sealed = await sealBackup(enc.encode("secret"), "pw");
    sealed.blob[0] ^= 0xff;
    await expect(openBackup(sealed, "pw")).rejects.toThrow();
  }, SLOW);

  it("fails closed when the nonce is tampered", async () => {
    const sealed = await sealBackup(enc.encode("secret"), "pw");
    sealed.nonce[0] ^= 0xff;
    await expect(openBackup(sealed, "pw")).rejects.toThrow();
  }, SLOW);

  it("fails closed when bound metadata (kdfParams, as AAD) is tampered", async () => {
    const sealed = await sealBackup(enc.encode("secret"), "pw");
    (sealed.kdfParams as { t: number }).t += 1; // changes the AAD → AEAD rejects
    await expect(openBackup(sealed, "pw")).rejects.toThrow();
  }, SLOW);

  it("fails closed on an unknown kdf or cipher (defense in depth)", async () => {
    const sealed = await sealBackup(enc.encode("secret"), "pw");
    await expect(openBackup({ ...sealed, kdf: "pbkdf2" }, "pw")).rejects.toThrow(/kdf/i);
    await expect(openBackup({ ...sealed, cipher: "aes-256-gcm" }, "pw")).rejects.toThrow(/cipher/i);
    await expect(openBackup({ ...sealed, version: 2 }, "pw")).rejects.toThrow(/version/i);
  }, SLOW);
});
