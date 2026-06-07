import { describe, it, expect } from "vitest";
import { MemoryStore } from "./memory-store.js";

const bytes = (...xs: number[]) => new Uint8Array(xs);

describe("MemoryStore", () => {
  it("round-trips get/set and returns null for missing keys", async () => {
    const s = new MemoryStore();
    expect(await s.get("missing")).toBeNull();
    await s.set("k", bytes(1, 2, 3));
    expect(await s.get("k")).toEqual(bytes(1, 2, 3));
  });

  it("deletes keys", async () => {
    const s = new MemoryStore();
    await s.set("k", bytes(9));
    await s.delete("k");
    expect(await s.get("k")).toBeNull();
  });

  it("lists keys by prefix", async () => {
    const s = new MemoryStore();
    await s.set("group:a", bytes(1));
    await s.set("group:b", bytes(2));
    await s.set("device", bytes(3));
    expect((await s.list("group:")).sort()).toEqual(["group:a", "group:b"]);
    expect((await s.list("")).sort()).toEqual(["device", "group:a", "group:b"]);
  });
});
