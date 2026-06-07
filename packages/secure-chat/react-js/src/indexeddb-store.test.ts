import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { createIndexedDBStore } from "./indexeddb-store.js";

const bytes = (...xs: number[]) => new Uint8Array(xs);

describe("createIndexedDBStore", () => {
  it("round-trips, lists by prefix, and deletes", async () => {
    const store = createIndexedDBStore({ dbName: "t1" });
    expect(await store.get("never-set")).toBeNull();
    await store.set("group:a", bytes(1, 2, 3));
    await store.set("group:b", bytes(4));
    await store.set("device", bytes(9));
    expect(await store.get("group:a")).toEqual(bytes(1, 2, 3));
    expect((await store.list("group:")).sort()).toEqual(["group:a", "group:b"]);
    await store.delete("group:a");
    expect(await store.get("group:a")).toBeNull();
  });

  it("persists across a fresh store handle on the same db (reload)", async () => {
    const s1 = createIndexedDBStore({ dbName: "t2" });
    await s1.set("device", bytes(7, 7));
    const s2 = createIndexedDBStore({ dbName: "t2" });
    expect(await s2.get("device")).toEqual(bytes(7, 7));
  });
});
