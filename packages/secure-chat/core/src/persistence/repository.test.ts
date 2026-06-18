import { describe, it, expect } from "vitest";
import { MemoryStore } from "./memory-store.js";
import { SecureChatRepository } from "./repository.js";
import type { SecureDeviceModel } from "../contract/index.js";

const bytes = (...xs: number[]) => new Uint8Array(xs);

const deviceRow: SecureDeviceModel = {
  id: "row-1",
  projectId: "p",
  userId: "u",
  deviceId: "dev-1",
  displayName: null,
  signaturePublicKey: "",
  credential: "",
  ciphersuite: 1,
  revokedAt: null,
  lastSeenAt: null,
  createdAt: "",
  updatedAt: "",
};

describe("SecureChatRepository", () => {
  it("round-trips the device record (incl. binary deviceState)", async () => {
    const repo = new SecureChatRepository(new MemoryStore());
    expect(await repo.loadDevice()).toBeNull();
    await repo.saveDevice({ deviceId: "dev-1", deviceState: bytes(1, 2, 250), device: deviceRow });
    const loaded = await repo.loadDevice();
    expect(loaded?.deviceId).toBe("dev-1");
    expect(loaded?.deviceState).toEqual(bytes(1, 2, 250));
    expect(loaded?.device?.id).toBe("row-1");
  });

  it("round-trips group state and lists conversation ids", async () => {
    const repo = new SecureChatRepository(new MemoryStore());
    await repo.saveGroupState("c1", bytes(7, 8));
    await repo.saveGroupState("c2", bytes(9));
    expect(await repo.loadGroupState("c1")).toEqual(bytes(7, 8));
    expect((await repo.listGroupConversationIds()).sort()).toEqual(["c1", "c2"]);
    await repo.deleteGroupState("c1");
    expect(await repo.loadGroupState("c1")).toBeNull();
  });

  it("round-trips the handshake cursor (scoped to a device row id)", async () => {
    const repo = new SecureChatRepository(new MemoryStore());
    expect(await repo.loadHandshakeCursor("row-1")).toBeNull();
    await repo.saveHandshakeCursor("row-1", "42");
    expect(await repo.loadHandshakeCursor("row-1")).toBe("42");
  });

  it("does not leak a cursor across device row ids (the re-register / wipe regression)", async () => {
    // A pre-wipe device left cursor=15 in the store; a freshly-registered device gets a new row id
    // and MUST start from null — else the global `seq` sequence (which survives a server DELETE) can
    // collide with the stale cursor and mask the new device's own Welcome.
    const repo = new SecureChatRepository(new MemoryStore());
    await repo.saveHandshakeCursor("old-row", "15");
    expect(await repo.loadHandshakeCursor("new-row")).toBeNull();
    expect(await repo.loadHandshakeCursor("old-row")).toBe("15"); // the old row is unaffected
  });

  it("round-trips decrypted message plaintext, isolated per conversation", async () => {
    const repo = new SecureChatRepository(new MemoryStore());
    expect(await repo.loadMessagePlaintext("c1", "m1")).toBeNull(); // miss → null
    await repo.saveMessagePlaintext("c1", "m1", "hi my bad bitch! 💜");
    expect(await repo.loadMessagePlaintext("c1", "m1")).toBe("hi my bad bitch! 💜");
    // Same message id under a DIFFERENT conversation must not collide.
    await repo.saveMessagePlaintext("c2", "m1", "other convo");
    expect(await repo.loadMessagePlaintext("c1", "m1")).toBe("hi my bad bitch! 💜");
    expect(await repo.loadMessagePlaintext("c2", "m1")).toBe("other convo");
  });

  it("clearAll wipes every key", async () => {
    const store = new MemoryStore();
    const repo = new SecureChatRepository(store);
    await repo.saveDevice({ deviceId: "d", deviceState: bytes(1), device: null });
    await repo.saveGroupState("c1", bytes(2));
    await repo.saveHandshakeCursor("row-1", "3");
    await repo.clearAll();
    expect(await store.list("")).toEqual([]);
  });
});
