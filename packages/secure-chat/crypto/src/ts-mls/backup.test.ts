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
    const plaintext = enc.encode("plaintext to encrypt");
    const sealed = await sealBackup(plaintext, "pw");
    expect(sealed.kdf).toBe("argon2id");
    expect(sealed.cipher).toBe("xchacha20poly1305");
    expect(sealed.version).toBe(1);
    expect(sealed.nonce).toHaveLength(24); // xchacha extended nonce
    const salt = fromHex((sealed.kdfParams as { salt: string }).salt);
    expect(salt).toHaveLength(16);
    expect(sealed.kdfParams).toMatchObject({ m: ARGON2_PARAMS.m, t: ARGON2_PARAMS.t, p: ARGON2_PARAMS.p });
    // The blob is ciphertext, not the plaintext: the bytes differ, and it's longer than the plaintext
    // by the AEAD tag (16 bytes). Assert on BYTES, not a decoded-string `.toContain` — random
    // ciphertext bytes legitimately decode to any character, so a char check is non-deterministic.
    expect(Array.from(sealed.blob)).not.toEqual(Array.from(plaintext));
    expect(sealed.blob.length).toBe(plaintext.length + 16); // poly1305 tag appended
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

  it("fails closed when the KDF salt is tampered (wrong derived key)", async () => {
    const sealed = await sealBackup(enc.encode("secret"), "pw");
    const params = sealed.kdfParams as { salt: string };
    // Flip the first hex nibble → a different salt → a different argon2id key → AEAD auth fails.
    params.salt = (params.salt[0] === "0" ? "1" : "0") + params.salt.slice(1);
    await expect(openBackup(sealed, "pw")).rejects.toThrow();
  }, SLOW);

  it("survives a kdfParams key-order change (Postgres jsonb does not preserve order)", async () => {
    const sealed = await sealBackup(enc.encode("secret"), "pw");
    // Simulate the jsonb round-trip reordering object keys; the open must still succeed.
    const p = sealed.kdfParams as Record<string, unknown>;
    sealed.kdfParams = { m: p.m, p: p.p, t: p.t, salt: p.salt };
    const opened = await openBackup(sealed, "pw");
    expect(new TextDecoder().decode(opened)).toBe("secret");
  }, SLOW);

  it("fails closed on an unknown kdf or cipher (defense in depth)", async () => {
    const sealed = await sealBackup(enc.encode("secret"), "pw");
    await expect(openBackup({ ...sealed, kdf: "pbkdf2" }, "pw")).rejects.toThrow(/kdf/i);
    await expect(openBackup({ ...sealed, cipher: "aes-256-gcm" }, "pw")).rejects.toThrow(/cipher/i);
    await expect(openBackup({ ...sealed, version: 2 }, "pw")).rejects.toThrow(/version/i);
  }, SLOW);
});
