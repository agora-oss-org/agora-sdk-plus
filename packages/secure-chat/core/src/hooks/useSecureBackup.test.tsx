// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { MockSecureChatCrypto } from "@agora-sdk/secure-chat-crypto/testing";
import { SecureChatProvider } from "../context/secure-chat-context.js";
import { useSecureBackup } from "./useSecureBackup.js";
import { MemoryStore } from "../persistence/memory-store.js";
import { SecureChatRepository } from "../persistence/repository.js";
import { SecureChatRestClient } from "../transport/rest.js";
import { SecureChatSocketClient } from "../transport/socket.js";
import { toBase64 } from "../util/base64.js";
import type { SecureConversationModel, SecureDeviceModel, SecureKeyBackupModel } from "../contract/index.js";

const row = (id: string, deviceId: string): SecureDeviceModel => ({
  id, projectId: "p", userId: "u", deviceId, displayName: null,
  signaturePublicKey: "", credential: "", ciphersuite: 1,
  revokedAt: null, lastSeenAt: null, createdAt: "", updatedAt: "",
});

const conv = (id: string, mlsGroupId: Uint8Array): SecureConversationModel => ({
  id, projectId: "p", type: "dm", mlsGroupId: toBase64(mlsGroupId), spaceId: null,
  currentEpoch: "0", name: null, createdById: null, lastMessageAt: null,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
});

function wrap(crypto: MockSecureChatCrypto, store: MemoryStore) {
  return ({ children }: { children: React.ReactNode }) => (
    <SecureChatProvider crypto={crypto} projectId="p" baseUrl="http://localhost:4000/v7" store={store} accessToken="t">
      {children}
    </SecureChatProvider>
  );
}

// The mount-time eviction check calls getKeyBackup when there's no local device; default it to "no
// backup" so unrelated tests never hit the network. Eviction tests override it per-case.
let getKeyBackupSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.spyOn(SecureChatSocketClient.prototype, "on").mockReturnValue(() => {});
  getKeyBackupSpy = vi
    .spyOn(SecureChatRestClient.prototype, "getKeyBackup")
    .mockResolvedValue(null);
});
afterEach(() => vi.restoreAllMocks());

describe("useSecureBackup", () => {
  it("backup() exports + uploads a base64 argon2id envelope", async () => {
    const upload = vi
      .spyOn(SecureChatRestClient.prototype, "uploadKeyBackup")
      .mockResolvedValue({ updatedAt: "2026-06-08T00:00:00Z" });

    const crypto = new MockSecureChatCrypto();
    await crypto.generateDeviceIdentity({ deviceId: "dev-x" });
    const store = new MemoryStore();

    const { result } = renderHook(() => useSecureBackup(), { wrapper: wrap(crypto, store) });

    await act(async () => {
      await result.current.backup("correct horse battery staple");
    });

    expect(upload).toHaveBeenCalledOnce();
    const body = upload.mock.calls[0]![0];
    expect(body.kdf).toBe("argon2id");
    expect(body.cipher).toBe("xchacha20poly1305");
    expect(typeof body.blob).toBe("string"); // base64 on the wire
    expect(typeof body.nonce).toBe("string");
    expect(result.current.lastBackupAt).toBe("2026-06-08T00:00:00Z");
  });

  it("restore() rehydrates the device + each conversation's group state into the repo", async () => {
    // Seed a "browser A": device + a DM group, then back it up.
    const a = new MockSecureChatCrypto();
    const bob = new MockSecureChatCrypto();
    await a.generateDeviceIdentity({ deviceId: "alice-dev" });
    await bob.generateDeviceIdentity({ deviceId: "bob-dev" });
    const [bobKp] = await bob.generateKeyPackages(1);
    const { group } = await a.createGroup({ initialMembers: [{ deviceId: "bob-row", keyPackage: bobKp!.keyPackage }] });
    const backup = await a.exportBackup("pw");
    const model: SecureKeyBackupModel = {
      id: "bk", projectId: "p", userId: "u", deviceId: null,
      blob: toBase64(backup.blob), nonce: toBase64(backup.nonce),
      kdf: backup.kdf, kdfParams: backup.kdfParams, cipher: backup.cipher, version: backup.version,
      createdAt: "", updatedAt: "",
    };

    vi.spyOn(SecureChatRestClient.prototype, "getKeyBackup").mockResolvedValue(model);
    const reg = vi.spyOn(SecureChatRestClient.prototype, "registerDevice").mockResolvedValue(row("row-1", "alice-dev"));
    vi.spyOn(SecureChatRestClient.prototype, "listConversations").mockResolvedValue({
      conversations: [conv("conv-1", group.mlsGroupId)],
      hasMore: false,
    });

    // "Browser B": empty store, fresh crypto.
    const fresh = new MockSecureChatCrypto();
    const store = new MemoryStore();
    const { result } = renderHook(() => useSecureBackup(), { wrapper: wrap(fresh, store) });

    await act(async () => {
      await result.current.restore("pw");
    });

    expect(reg).toHaveBeenCalledOnce(); // idempotent re-assert of the restored identity
    const repo = new SecureChatRepository(store);
    const persistedDevice = await repo.loadDevice();
    expect(persistedDevice?.deviceId).toBe("alice-dev");
    expect(persistedDevice?.device?.id).toBe("row-1");
    expect(await repo.loadGroupState("conv-1")).not.toBeNull(); // group rebound by conversationId
  });

  it("restore() skips conversations whose group is absent from the backup", async () => {
    const a = new MockSecureChatCrypto();
    await a.generateDeviceIdentity({ deviceId: "alice-dev" });
    const backup = await a.exportBackup("pw"); // no groups in this backup
    const model: SecureKeyBackupModel = {
      id: "bk", projectId: "p", userId: "u", deviceId: null,
      blob: toBase64(backup.blob), nonce: toBase64(backup.nonce),
      kdf: backup.kdf, kdfParams: backup.kdfParams, cipher: backup.cipher, version: backup.version,
      createdAt: "", updatedAt: "",
    };
    vi.spyOn(SecureChatRestClient.prototype, "getKeyBackup").mockResolvedValue(model);
    vi.spyOn(SecureChatRestClient.prototype, "registerDevice").mockResolvedValue(row("row-1", "alice-dev"));
    vi.spyOn(SecureChatRestClient.prototype, "listConversations").mockResolvedValue({
      conversations: [conv("conv-orphan", new Uint8Array([1, 2, 3, 4]))],
      hasMore: false,
    });

    const fresh = new MockSecureChatCrypto();
    const store = new MemoryStore();
    const { result } = renderHook(() => useSecureBackup(), { wrapper: wrap(fresh, store) });

    await act(async () => {
      await result.current.restore("pw"); // must not throw on the orphan conversation
    });

    const repo = new SecureChatRepository(store);
    expect(await repo.loadGroupState("conv-orphan")).toBeNull();
    expect((await repo.loadDevice())?.deviceId).toBe("alice-dev"); // device still restored
  });

  it("restore() throws when the server has no backup", async () => {
    vi.spyOn(SecureChatRestClient.prototype, "getKeyBackup").mockResolvedValue(null);
    const fresh = new MockSecureChatCrypto();
    const { result } = renderHook(() => useSecureBackup(), { wrapper: wrap(fresh, new MemoryStore()) });

    await act(async () => {
      await expect(result.current.restore("pw")).rejects.toThrow(/no key backup/i);
    });
    await waitFor(() => expect(result.current.error).toBeTruthy());
  });

  it("surfaces a wrong-passphrase failure on restore", async () => {
    const a = new MockSecureChatCrypto();
    await a.generateDeviceIdentity({ deviceId: "alice-dev" });
    const backup = await a.exportBackup("right");
    const model: SecureKeyBackupModel = {
      id: "bk", projectId: "p", userId: "u", deviceId: null,
      blob: toBase64(backup.blob), nonce: toBase64(backup.nonce),
      kdf: backup.kdf, kdfParams: backup.kdfParams, cipher: backup.cipher, version: backup.version,
      createdAt: "", updatedAt: "",
    };
    vi.spyOn(SecureChatRestClient.prototype, "getKeyBackup").mockResolvedValue(model);

    const fresh = new MockSecureChatCrypto();
    const { result } = renderHook(() => useSecureBackup(), { wrapper: wrap(fresh, new MemoryStore()) });

    await act(async () => {
      await expect(result.current.restore("wrong")).rejects.toThrow();
    });
  });

  it("exposes the passphrase-strength estimator", () => {
    const crypto = new MockSecureChatCrypto();
    const { result } = renderHook(() => useSecureBackup(), { wrapper: wrap(crypto, new MemoryStore()) });
    expect(result.current.estimateStrength("password").score).toBeLessThanOrEqual(1);
  });
});

describe("useSecureBackup — eviction recovery (needsRestore)", () => {
  const dummyBackup = (): SecureKeyBackupModel => ({
    id: "bk", projectId: "p", userId: "u", deviceId: null,
    blob: "", nonce: "", kdf: "argon2id", kdfParams: {}, cipher: "xchacha20poly1305", version: 1,
    createdAt: "", updatedAt: "",
  });

  it("flags needsRestore when local state is gone but a server backup exists (evicted / fresh browser)", async () => {
    getKeyBackupSpy.mockResolvedValue(dummyBackup());
    const { result } = renderHook(() => useSecureBackup(), { wrapper: wrap(new MockSecureChatCrypto(), new MemoryStore()) });
    await waitFor(() => expect(result.current.needsRestore).toBe(true));
    expect(result.current.checkingRestore).toBe(false);
  });

  it("does NOT flag needsRestore — or even hit the server — when a local device is present", async () => {
    const crypto = new MockSecureChatCrypto();
    await crypto.generateDeviceIdentity({ deviceId: "me" });
    const store = new MemoryStore();
    await new SecureChatRepository(store).saveDevice({
      deviceId: "me", deviceState: await crypto.exportDeviceState(), device: row("row-1", "me"),
    });

    const { result } = renderHook(() => useSecureBackup(), { wrapper: wrap(crypto, store) });
    await waitFor(() => expect(result.current.checkingRestore).toBe(false));
    expect(result.current.needsRestore).toBe(false);
    expect(getKeyBackupSpy).not.toHaveBeenCalled(); // common path stays a single IndexedDB read
  });

  it("does NOT flag needsRestore on a true first run (no local state, no backup)", async () => {
    getKeyBackupSpy.mockResolvedValue(null);
    const { result } = renderHook(() => useSecureBackup(), { wrapper: wrap(new MockSecureChatCrypto(), new MemoryStore()) });
    await waitFor(() => expect(getKeyBackupSpy).toHaveBeenCalled());
    expect(result.current.needsRestore).toBe(false);
  });

  it("fails soft when the backup check errors (no crash, surfaces error, needsRestore stays false)", async () => {
    getKeyBackupSpy.mockRejectedValue(new Error("network down"));
    const { result } = renderHook(() => useSecureBackup(), { wrapper: wrap(new MockSecureChatCrypto(), new MemoryStore()) });
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.needsRestore).toBe(false);
  });

  it("recheckRestore() re-runs detection and returns the result", async () => {
    getKeyBackupSpy.mockResolvedValue(null);
    const { result } = renderHook(() => useSecureBackup(), { wrapper: wrap(new MockSecureChatCrypto(), new MemoryStore()) });
    await waitFor(() => expect(result.current.checkingRestore).toBe(false));
    expect(result.current.needsRestore).toBe(false);

    getKeyBackupSpy.mockResolvedValue(dummyBackup()); // a backup appears (e.g. after sign-in)
    let returned: boolean | undefined;
    await act(async () => {
      returned = await result.current.recheckRestore();
    });
    expect(returned).toBe(true);
    expect(result.current.needsRestore).toBe(true);
  });

  it("clears needsRestore after a successful restore", async () => {
    const a = new MockSecureChatCrypto();
    await a.generateDeviceIdentity({ deviceId: "alice-dev" });
    const b = await a.exportBackup("pw");
    const model: SecureKeyBackupModel = {
      id: "bk", projectId: "p", userId: "u", deviceId: null,
      blob: toBase64(b.blob), nonce: toBase64(b.nonce),
      kdf: b.kdf, kdfParams: b.kdfParams, cipher: b.cipher, version: b.version,
      createdAt: "", updatedAt: "",
    };
    getKeyBackupSpy.mockResolvedValue(model);
    vi.spyOn(SecureChatRestClient.prototype, "registerDevice").mockResolvedValue(row("row-1", "alice-dev"));
    vi.spyOn(SecureChatRestClient.prototype, "listConversations").mockResolvedValue({ conversations: [], hasMore: false });

    const { result } = renderHook(() => useSecureBackup(), { wrapper: wrap(new MockSecureChatCrypto(), new MemoryStore()) });
    await waitFor(() => expect(result.current.needsRestore).toBe(true));
    await act(async () => {
      await result.current.restore("pw");
    });
    expect(result.current.needsRestore).toBe(false);
  });
});
