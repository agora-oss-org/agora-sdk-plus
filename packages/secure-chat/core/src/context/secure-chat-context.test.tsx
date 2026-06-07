// @vitest-environment jsdom
import React from "react";
import { describe, it, expect } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
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

  it("throws when useSecureChat is used outside the provider", () => {
    expect(() => renderHook(() => useSecureChat())).toThrow(/within a <SecureChatProvider>/);
  });
});
