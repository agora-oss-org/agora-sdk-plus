// Client for the `/secure` socket.io namespace — realtime notification layer for secure chat.
//
// A SEPARATE namespace from the plaintext chat socket (defense-in-depth: ciphertext events never
// mix with plaintext handlers). Realtime is an OPTIMIZATION — the REST `fetchHandshakes(since)` +
// `listMessages` endpoints remain the durable source of truth for offline catch-up. All event
// payloads carry ciphertext only.

import { io, Socket } from "socket.io-client";
import { SecureHandshakeModel, SecureMessageModel } from "../contract/index.js";
import { createDebugLogger } from "../util/debug.js";

const log = createDebugLogger("socket");

/** Server → client events on the `/secure` namespace (§10). */
export interface SecureServerEvents {
  "secure:message": (message: SecureMessageModel) => void;
  "secure:handshake": (handshake: SecureHandshakeModel) => void; // broadcast Commit/Proposal
  "secure:welcome": (welcome: SecureHandshakeModel) => void; // targeted, to the device room
  "secure:member:joined": (signal: { conversationId: string; userId: string }) => void;
  "secure:member:left": (signal: { conversationId: string; userId: string }) => void;
  "secure:key-packages-low": (signal: { deviceId: string; available: number }) => void;
  "secure:typing:start": (signal: { conversationId: string; userId: string }) => void;
  "secure:typing:stop": (signal: { conversationId: string; userId: string }) => void;
}

/**
 * Client → server events.
 *
 * @remarks
 * Payloads are **objects**, not bare ids — the server destructures `{ conversationId }` /
 * `{ deviceId }` off the first argument (agora-server `realtime/secure-socket.ts`). Emitting a bare
 * string lands as `undefined` after destructuring (and, on a `null` payload, throws server-side), so
 * the join silently fails. Keep these shapes in lockstep with the server's `SecureClientToServerEvents`.
 */
export interface SecureClientEvents {
  "join:secure-conversation": (payload: { conversationId: string }) => void;
  "join:secure-device": (payload: { deviceId: string }) => void;
}

/** A socket.io `Socket` typed with the secure-chat event maps in both directions. */
export type SecureSocket = Socket<SecureServerEvents, SecureClientEvents>;

/**
 * Configuration for {@link SecureChatSocketClient}. The origin and token are read through resolvers
 * (not captured once) so a refreshed token is used on the next (re)connect.
 */
export interface SecureChatSocketConfig {
  /** Resolve the socket origin (e.g. `getSocketUrl()` from @agora-sdk/core). */
  getSocketUrl: () => string;
  /** Resolve the current access token (sent in the socket `auth` handshake). */
  getAccessToken: () => string | undefined;
  /** The Agora project id, sent as a connection query param. */
  projectId: string;
}

/**
 * Thin wrapper around the `/secure` namespace connection. Devices the user owns are auto-joined to
 * their `secure:device:{id}` rooms on connect (server-side), so targeted Welcomes arrive without an
 * explicit join; conversation rooms are membership-gated and joined on demand.
 */
export class SecureChatSocketClient {
  private socket: SecureSocket | null = null;

  constructor(private readonly config: SecureChatSocketConfig) {}

  /**
   * Lazily open (or reuse) the `/secure` namespace connection.
   *
   * @returns The live socket; idempotent while already connected.
   */
  connect(): SecureSocket {
    if (this.socket?.connected) return this.socket;
    const origin = this.config.getSocketUrl().replace(/\/$/, "");
    log.debug("connecting /secure namespace", { origin, projectId: this.config.projectId });
    this.socket = io(`${origin}/secure`, {
      auth: { token: this.config.getAccessToken() },
      query: { projectId: this.config.projectId },
      transports: ["websocket"],
      autoConnect: true,
    });
    // Lifecycle narration — the realtime layer is a notification optimization (REST cursors are the
    // source of truth), so a flapping socket shows up here while the durable path keeps working.
    this.socket.on("connect", () => log.debug("socket connected", { id: this.socket?.id }));
    this.socket.on("disconnect", (reason) => log.debug("socket disconnected", { reason }));
    this.socket.on("connect_error", (err) => log.debug("socket connect_error", { message: err.message }));
    return this.socket;
  }

  /** Tear down the connection and drop the cached socket (e.g. on provider unmount or sign-out). */
  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
  }

  /** The underlying socket if one exists, else `null` — escape hatch for advanced socket.io use. */
  get raw(): SecureSocket | null {
    return this.socket;
  }

  /** Join a conversation room (membership-gated server-side) to receive its broadcasts. */
  joinConversation(conversationId: string): void {
    // Object payload — the server destructures `{ conversationId }`; a bare string would arrive as
    // `undefined` and the join would silently no-op (see SecureClientEvents).
    log.trace("join conversation room", { conversationId });
    this.connect().emit("join:secure-conversation", { conversationId });
  }

  /** Explicitly join a device room (ownership-verified). Owned devices auto-join on connect. */
  joinDevice(deviceId: string): void {
    log.trace("join device room", { deviceId });
    this.connect().emit("join:secure-device", { deviceId });
  }

  /**
   * Subscribe to a server → client event, auto-connecting if needed.
   *
   * @param event - The `secure:*` event name to listen for.
   * @param handler - The typed handler for that event's payload.
   * @returns An unsubscribe function that removes this handler.
   */
  on<E extends keyof SecureServerEvents>(event: E, handler: SecureServerEvents[E]): () => void {
    const s = this.connect();
    // socket.io typings accept the event/handler pair; the cast keeps our strict map ergonomic.
    s.on(event as never, handler as never);
    return () => s.off(event as never, handler as never);
  }
}
