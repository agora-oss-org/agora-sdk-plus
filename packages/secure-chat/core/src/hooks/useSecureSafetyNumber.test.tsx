// @vitest-environment jsdom
import React from "react";
import { describe, it, expect } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { MockSecureChatCrypto } from "@agora-sdk/secure-chat-crypto/testing";
import { SecureChatProvider } from "../context/secure-chat-context.js";
import { useSecureSafetyNumber } from "./useSecureSafetyNumber.js";
import { MemoryStore } from "../persistence/memory-store.js";
import { SecureChatRepository } from "../persistence/repository.js";
import type { SecureDeviceModel } from "../contract/index.js";

const row = (deviceId: string): SecureDeviceModel => ({
  id: `row-${deviceId}`, projectId: "p", userId: "u", deviceId, displayName: null,
  signaturePublicKey: "", credential: "", ciphersuite: 1,
  revokedAt: null, lastSeenAt: null, createdAt: "", updatedAt: "",
});

function wrap(crypto: MockSecureChatCrypto, store: MemoryStore) {
  return ({ children }: { children: React.ReactNode }) => (
    <SecureChatProvider crypto={crypto} projectId="p" baseUrl="http://localhost:4000/v7" store={store} accessToken="t">
      {children}
    </SecureChatProvider>
  );
}

/** Persist a device + the conversation's group state into a store, returning a wrapper for that side. */
async function side(crypto: MockSecureChatCrypto, deviceId: string, group: { mlsGroupId: Uint8Array; epoch: bigint }) {
  const store = new MemoryStore();
  const repo = new SecureChatRepository(store);
  await repo.saveDevice({ deviceId, deviceState: await crypto.exportDeviceState(), device: row(deviceId) });
  await repo.saveGroupState("conv-1", await crypto.exportGroupState(group));
  return store;
}

describe("useSecureSafetyNumber", () => {
  it("derives the same safety number on both sides of a DM", async () => {
    const alice = new MockSecureChatCrypto();
    await alice.generateDeviceIdentity({ deviceId: "alice" });
    const bob = new MockSecureChatCrypto();
    await bob.generateDeviceIdentity({ deviceId: "bob" });
    const [bobKp] = await bob.generateKeyPackages(1);

    const { group: aGroup, welcomes } = await alice.createGroup({
      initialMembers: [{ deviceId: "bob", keyPackage: bobKp.keyPackage }],
    });
    const bGroup = await bob.processWelcome(welcomes[0].payload);

    const aStore = await side(alice, "alice", aGroup);
    const bStore = await side(bob, "bob", bGroup);

    const { result: aRes } = renderHook(() => useSecureSafetyNumber("conv-1"), { wrapper: wrap(alice, aStore) });
    const { result: bRes } = renderHook(() => useSecureSafetyNumber("conv-1"), { wrapper: wrap(bob, bStore) });

    await waitFor(() => expect(aRes.current.safetyNumber).not.toBeNull());
    await waitFor(() => expect(bRes.current.safetyNumber).not.toBeNull());

    expect(aRes.current.safetyNumber!.groups).toHaveLength(12);
    // The whole point: both users see the identical number to compare out-of-band.
    expect(aRes.current.safetyNumber!.digits).toBe(bRes.current.safetyNumber!.digits);
  });

  it("returns null when the conversation has no resolvable group", async () => {
    const alice = new MockSecureChatCrypto();
    await alice.generateDeviceIdentity({ deviceId: "alice" });
    const store = new MemoryStore();
    await new SecureChatRepository(store).saveDevice({
      deviceId: "alice", deviceState: await alice.exportDeviceState(), device: row("alice"),
    });

    const { result } = renderHook(() => useSecureSafetyNumber("conv-unknown"), { wrapper: wrap(alice, store) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.safetyNumber).toBeNull();
  });
});
