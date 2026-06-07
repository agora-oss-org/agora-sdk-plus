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

  it("round-trips the handshake cursor", async () => {
    const repo = new SecureChatRepository(new MemoryStore());
    expect(await repo.loadHandshakeCursor()).toBeNull();
    await repo.saveHandshakeCursor("42");
    expect(await repo.loadHandshakeCursor()).toBe("42");
  });

  it("clearAll wipes every key", async () => {
    const store = new MemoryStore();
    const repo = new SecureChatRepository(store);
    await repo.saveDevice({ deviceId: "d", deviceState: bytes(1), device: null });
    await repo.saveGroupState("c1", bytes(2));
    await repo.saveHandshakeCursor("3");
    await repo.clearAll();
    expect(await store.list("")).toEqual([]);
  });
});
