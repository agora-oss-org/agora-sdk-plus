// @agora-sdk/secure-chat-react-js — web bindings for Agora secure chat.
//
// Re-exports the platform-agnostic core and adds the web-specific pieces (Phase 2): the concrete
// MLS crypto + IndexedDB group-state persistence. Use this package (not core directly) in browser
// apps so the right crypto/persistence ships.

export * from "@agora-sdk/secure-chat-core";

export { createWebSecureChatCrypto } from "./crypto-web.js";
