// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  accountsStorageKey,
  readAccountMap,
  hasPersistedRefreshToken,
  pruneAccount,
  type AccountMap,
} from "./accountStorage";

const PROJECT = "proj_123";
const KEY = `replyke-accounts:${PROJECT}`;

function seed(map: AccountMap) {
  localStorage.setItem(KEY, JSON.stringify(map));
}

describe("accountStorage", () => {
  beforeEach(() => localStorage.clear());

  it("derives the SDK storage key", () => {
    expect(accountsStorageKey(PROJECT)).toBe(KEY);
  });

  it("returns null when nothing is stored or JSON is corrupt", () => {
    expect(readAccountMap(PROJECT)).toBeNull();
    localStorage.setItem(KEY, "{not json");
    expect(readAccountMap(PROJECT)).toBeNull();
  });

  it("detects a persisted refresh token for a user", () => {
    seed({
      activeAccountId: "u1",
      accounts: {
        u1: { refreshToken: "rt1", tokenExpiresAt: 0, user: { id: "u1", name: null, email: null, avatar: null } },
      },
    });
    expect(hasPersistedRefreshToken(PROJECT, "u1")).toBe(true);
    expect(hasPersistedRefreshToken(PROJECT, "u2")).toBe(false);
  });

  it("prunes an account, rewrites storage, and dispatches a storage event", () => {
    seed({
      activeAccountId: "stale",
      accounts: {
        stale: { refreshToken: "dead", tokenExpiresAt: 0, user: { id: "stale", name: null, email: null, avatar: null } },
        good: { refreshToken: "rt", tokenExpiresAt: 0, user: { id: "good", name: null, email: null, avatar: null } },
      },
    });
    const events: StorageEvent[] = [];
    const handler = (e: StorageEvent) => events.push(e);
    window.addEventListener("storage", handler);

    const next = pruneAccount(PROJECT, "stale");
    window.removeEventListener("storage", handler);

    expect(next?.accounts.stale).toBeUndefined();
    expect(next?.accounts.good).toBeDefined();
    expect(readAccountMap(PROJECT)?.accounts.stale).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0].key).toBe(KEY);
    expect(events[0].newValue).toContain("good");
  });

  it("pruning a missing user is a no-op returning null", () => {
    seed({ activeAccountId: null, accounts: {} });
    expect(pruneAccount(PROJECT, "nobody")).toBeNull();
  });
});
