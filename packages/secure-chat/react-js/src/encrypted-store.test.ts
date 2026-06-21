// @vitest-environment jsdom
//
// At-rest encryption tests for the EncryptedStore decorator. Runs against `fake-indexeddb` (the real
// IndexedDB base store) + the real jsdom WebCrypto, so these exercise actual AES-GCM / argon2id, not a
// mock. Every test proves a security property from the plan: round-trip, fail-closed on wrong password
// and tamper, lock semantics, cross-instance persistence, password change, meta-key hiding, repository
// obliviousness, and a no-plaintext-leak scan.
//
// NOTE (cross-realm gotcha): `value instanceof Uint8Array` / `expect.any(Uint8Array)` are unreliable
// across the Node↔jsdom realm boundary, so assertions check length / byte content instead.

import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { createEncryptedStore, EncryptedStore, StoreLockedError } from "./encrypted-store.js";
import { createIndexedDBStore } from "./indexeddb-store.js";
import { SecureChatRepository } from "../../core/src/persistence/repository.js";
import type { SecureChatStore } from "../../core/src/persistence/store.js";

const PW = "correct horse battery staple";
const bytes = (...xs: number[]) => new Uint8Array(xs);

// Each test gets a unique base db name so fake-indexeddb state never bleeds between cases.
let dbCounter = 0;
const freshBase = (): { store: SecureChatStore; dbName: string } => {
  const dbName = `enc-test-${++dbCounter}-${Date.now()}`;
  return { store: createIndexedDBStore({ dbName }), dbName };
};
const baseFor = (dbName: string): SecureChatStore => createIndexedDBStore({ dbName });

describe("EncryptedStore", () => {
  let base: SecureChatStore;
  let dbName: string;
  let enc: EncryptedStore;

  beforeEach(async () => {
    ({ store: base, dbName } = freshBase());
    enc = createEncryptedStore(base);
    await enc.unlock(PW);
  });

  it("round-trips a value, and the stored blob is sealed (not plaintext)", async () => {
    const plain = bytes(1, 2, 3, 250, 99);
    await enc.set("group:c1", plain);

    const got = await enc.get("group:c1");
    expect(got).not.toBeNull();
    expect(Array.from(got as Uint8Array)).toEqual([1, 2, 3, 250, 99]);

    // The raw on-disk value differs from the input and begins with the version byte.
    const raw = await base.get("group:c1");
    expect(raw).not.toBeNull();
    expect((raw as Uint8Array)[0]).toBe(1); // version byte
    expect((raw as Uint8Array).length).toBeGreaterThan(plain.length); // version + nonce + tag overhead
    expect(Array.from(raw as Uint8Array)).not.toEqual(Array.from(plain));
  });

  it("get returns null on a miss", async () => {
    expect(await enc.get("nope")).toBeNull();
  });

  it("wrong password fails closed (throws, yields no plaintext)", async () => {
    await enc.set("device", bytes(42, 43, 44));

    const wrongInstance = createEncryptedStore(baseFor(dbName));
    await expect(wrongInstance.unlock("definitely wrong")).rejects.toThrow();
    expect(wrongInstance.isLocked()).toBe(true);
    // Locked ⇒ no data can be read out.
    await expect(wrongInstance.get("device")).rejects.toBeInstanceOf(StoreLockedError);
  });

  it("tamper fails closed (a flipped byte ⇒ get throws, never raw bytes)", async () => {
    await enc.set("msg:c1:m1", bytes(7, 7, 7, 7));

    // Flip a byte in the ciphertext body (past the version+nonce header) and write it back.
    const raw = (await base.get("msg:c1:m1")) as Uint8Array;
    const tampered = new Uint8Array(raw);
    tampered[tampered.length - 1] ^= 0x01;
    await base.set("msg:c1:m1", tampered);

    const reopened = createEncryptedStore(baseFor(dbName));
    await reopened.unlock(PW);
    await expect(reopened.get("msg:c1:m1")).rejects.toThrow();
  });

  it("a malformed header fails closed", async () => {
    await base.set("group:bad", bytes(9, 9, 9)); // wrong version byte, too short
    const reopened = createEncryptedStore(baseFor(dbName));
    await reopened.unlock(PW);
    await expect(reopened.get("group:bad")).rejects.toThrow();
  });

  it("locks: get/set/delete/list throw StoreLockedError; unlock restores access", async () => {
    await enc.set("group:c1", bytes(1));
    enc.lock();
    expect(enc.isLocked()).toBe(true);

    await expect(enc.get("group:c1")).rejects.toBeInstanceOf(StoreLockedError);
    await expect(enc.set("group:c1", bytes(2))).rejects.toBeInstanceOf(StoreLockedError);
    await expect(enc.delete("group:c1")).rejects.toBeInstanceOf(StoreLockedError);
    await expect(enc.list("")).rejects.toBeInstanceOf(StoreLockedError);

    await enc.unlock(PW);
    expect(enc.isLocked()).toBe(false);
    expect(Array.from((await enc.get("group:c1")) as Uint8Array)).toEqual([1]);
  });

  it("persists across instances over the same base db + password (wrapped DEK round-trips)", async () => {
    await enc.set("group:c1", bytes(11, 22, 33));

    const fresh = createEncryptedStore(baseFor(dbName));
    await fresh.unlock(PW);
    expect(Array.from((await fresh.get("group:c1")) as Uint8Array)).toEqual([11, 22, 33]);
  });

  // argon2id at the RFC-9106 high-memory profile is intentionally slow; changePassword derives the KEK
  // several times (verify old + derive new + a fresh unlock), so these get a generous timeout.
  it("changePassword: old password fails, new opens the same values (no data loss)", { timeout: 30000 }, async () => {
    await enc.set("group:c1", bytes(5, 6, 7));
    const NEW = "a brand new much longer passphrase";
    await enc.changePassword(PW, NEW);

    // Old password no longer unwraps the (re-wrapped) DEK.
    const withOld = createEncryptedStore(baseFor(dbName));
    await expect(withOld.unlock(PW)).rejects.toThrow();

    // New password opens the SAME pre-existing value (same DEK, just re-wrapped).
    const withNew = createEncryptedStore(baseFor(dbName));
    await withNew.unlock(NEW);
    expect(Array.from((await withNew.get("group:c1")) as Uint8Array)).toEqual([5, 6, 7]);
  });

  it("changePassword rejects a wrong old password and leaves the store intact", { timeout: 30000 }, async () => {
    await enc.set("group:c1", bytes(1, 2));
    await expect(enc.changePassword("wrong old", "whatever new")).rejects.toThrow();
    // Original password still works afterwards.
    const reopened = createEncryptedStore(baseFor(dbName));
    await reopened.unlock(PW);
    expect(Array.from((await reopened.get("group:c1")) as Uint8Array)).toEqual([1, 2]);
  });

  it("changePassword throws StoreLockedError when locked", async () => {
    enc.lock();
    await expect(enc.changePassword(PW, "new")).rejects.toBeInstanceOf(StoreLockedError);
  });

  it("hides the __enc__ meta key from list()", async () => {
    await enc.set("group:c1", bytes(1));
    await enc.set("device", bytes(2));
    const keys = await enc.list("");
    expect(keys).not.toContain("__enc__");
    expect(keys.sort()).toEqual(["device", "group:c1"]);
    // The meta record DOES exist in the base store (it just never surfaces).
    expect(await base.list("")).toContain("__enc__");
  });

  it("repository round-trips device/group/message-content over the encrypted store (obliviousness)", async () => {
    const repo = new SecureChatRepository(enc);

    await repo.saveDevice({ deviceId: "dev-1", deviceState: bytes(1, 2, 250), device: null });
    const loadedDevice = await repo.loadDevice();
    expect(loadedDevice?.deviceId).toBe("dev-1");
    expect(Array.from(loadedDevice?.deviceState as Uint8Array)).toEqual([1, 2, 250]);

    await repo.saveGroupState("c1", bytes(7, 8, 9));
    expect(Array.from((await repo.loadGroupState("c1")) as Uint8Array)).toEqual([7, 8, 9]);
    expect(await repo.listGroupConversationIds()).toEqual(["c1"]);

    // Message content is now stored as raw content-frame bytes (not text); round-trip a Uint8Array.
    const contentBytes = new TextEncoder().encode("hi my bad bitch! 💜");
    await repo.saveMessageContent("c1", "m1", contentBytes);
    expect(Array.from((await repo.loadMessageContent("c1", "m1")) as Uint8Array)).toEqual(Array.from(contentBytes));
  });

  it("no-leak scan: a stored msg: value never contains the message's UTF-8 bytes", async () => {
    const repo = new SecureChatRepository(enc);
    const secret = "the nuclear codes are 0000";
    const secretBytes = new TextEncoder().encode(secret);
    await repo.saveMessageContent("c1", "m1", secretBytes);

    // Scan EVERY raw base-store value for the plaintext byte sequence.
    const rawKeys = await base.list("");
    for (const k of rawKeys) {
      const raw = (await base.get(k)) as Uint8Array;
      expect(containsSubsequence(raw, secretBytes)).toBe(false);
    }
  });
});

/** True if `needle` appears as a contiguous byte subsequence of `haystack`. */
function containsSubsequence(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) return true;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}
