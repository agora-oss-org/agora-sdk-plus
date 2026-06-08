// Regression tests for SecureChatSocketClient's client→server emit shapes.
//
// The /secure namespace server destructures `{ conversationId }` / `{ deviceId }` off the FIRST emit
// argument (agora-server realtime/secure-socket.ts). An earlier version emitted bare strings, so the
// room join silently no-op'd (and crashed the server on a null payload). A transport-level e2e caught
// it; these unit tests lock the corrected object shapes so it can't regress without a live server.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture the fake socket the mocked `io()` hands back, so tests can inspect what was emitted.
const emit = vi.fn();
const fakeSocket = {
  connected: false,
  emit,
  on: vi.fn(),
  off: vi.fn(),
  disconnect: vi.fn(),
};
vi.mock("socket.io-client", () => ({
  io: vi.fn(() => fakeSocket),
}));

import { SecureChatSocketClient } from "./socket.js";

function makeClient(): SecureChatSocketClient {
  return new SecureChatSocketClient({
    projectId: "proj_1",
    getSocketUrl: () => "http://localhost:4000",
    getAccessToken: () => "tok",
  });
}

describe("SecureChatSocketClient client→server payloads", () => {
  beforeEach(() => {
    emit.mockClear();
    fakeSocket.connected = false;
  });

  it("joinConversation emits an OBJECT { conversationId }, not a bare string", () => {
    makeClient().joinConversation("conv_42");
    expect(emit).toHaveBeenCalledWith("join:secure-conversation", { conversationId: "conv_42" });
    // Guard the exact regression: never a bare string (server destructures the payload).
    expect(emit).not.toHaveBeenCalledWith("join:secure-conversation", "conv_42");
  });

  it("joinDevice emits an OBJECT { deviceId }, not a bare string", () => {
    makeClient().joinDevice("dev_7");
    expect(emit).toHaveBeenCalledWith("join:secure-device", { deviceId: "dev_7" });
    expect(emit).not.toHaveBeenCalledWith("join:secure-device", "dev_7");
  });
});
