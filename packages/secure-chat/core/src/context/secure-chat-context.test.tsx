// @vitest-environment jsdom
import React from "react";
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { MockSecureChatCrypto } from "@agora-sdk/secure-chat-crypto/testing";
import { SecureChatProvider, useSecureChat } from "./secure-chat-context.js";
import { MemoryStore } from "../persistence/memory-store.js";

describe("SecureChatProvider persistence wiring", () => {
  it("resolveGroup loads + imports persisted group state; rememberGroup persists it", async () => {
    const crypto = new MockSecureChatCrypto();
    await crypto.generateDeviceIdentity({ deviceId: "dev" });
    const { group } = await crypto.createGroup({ initialMembers: [] });
    const store = new MemoryStore();

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <SecureChatProvider crypto={crypto} projectId="p" store={store} accessToken="t">
        {children}
      </SecureChatProvider>
    );
    const { result } = renderHook(() => useSecureChat(), { wrapper });

    expect(await result.current.resolveGroup("c1")).toBeNull();

    await result.current.rememberGroup("c1", group);
    const resolved = await result.current.resolveGroup("c1");
    expect(resolved).not.toBeNull();
    expect(await store.get("group:c1")).not.toBeNull();
  });

  it("resolveGroup imports persisted state on a fresh provider mount (reload)", async () => {
    const crypto = new MockSecureChatCrypto();
    await crypto.generateDeviceIdentity({ deviceId: "dev" });
    const { group } = await crypto.createGroup({ initialMembers: [] });
    const store = new MemoryStore();

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <SecureChatProvider crypto={crypto} projectId="p" store={store} accessToken="t">
        {children}
      </SecureChatProvider>
    );

    // First mount persists the group, then unmounts (dropping its in-memory cache).
    const first = renderHook(() => useSecureChat(), { wrapper });
    await first.result.current.rememberGroup("c1", group);
    first.unmount();

    // Second mount shares the SAME store but has a fresh cache → forces loadGroupState + importGroupState.
    const second = renderHook(() => useSecureChat(), { wrapper });
    const resolved = await second.result.current.resolveGroup("c1");
    expect(resolved).not.toBeNull();
    expect(resolved?.mlsGroupId).toEqual(group.mlsGroupId);
  });

  it("throws when useSecureChat is used outside the provider", () => {
    expect(() => renderHook(() => useSecureChat())).toThrow(/within a <SecureChatProvider>/);
  });
});
