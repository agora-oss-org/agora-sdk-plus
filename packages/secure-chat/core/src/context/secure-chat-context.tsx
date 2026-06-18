// SecureChatProvider — wires transport + crypto + persistence for the secure-chat hooks.
//
// Standalone transport: the caller supplies the API base URL (and optional socket origin) directly —
// this package has NO dependency on @agora-sdk/core. (It used to fall back to core's getApiBaseUrl /
// getSocketUrl runtime singletons; that coupling existed only to auto-inherit a Replyke app's config,
// and core's actual surface here was just two URL accessors. Requiring `baseUrl` makes secure chat a
// self-contained E2EE transport usable in any app.) Crypto AND the persistence store are injected too,
// keeping this layer platform- and library-agnostic. The provider builds a typed SecureChatRepository
// over the store plus a cached resolveGroup/rememberGroup so the hooks become self-sufficient (no need
// to thread a GroupHandle in by hand).

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef } from "react";
import { SecureChatCrypto, GroupHandle } from "@agora-sdk/secure-chat-crypto";

import { SecureChatRestClient } from "../transport/rest.js";
import { SecureChatSocketClient } from "../transport/socket.js";
import { SecureChatStore } from "../persistence/store.js";
import { MemoryStore } from "../persistence/memory-store.js";
import { SecureChatRepository } from "../persistence/repository.js";
import { PaddingPolicy } from "../util/padding.js";
import { createDebugLogger } from "../util/debug.js";

const log = createDebugLogger("provider");

/**
 * The value exposed by {@link useSecureChat}: shared transport clients, the injected crypto, the
 * persistence repository, the group-handle resolver, and the active project id.
 */
export interface SecureChatContextValue {
  /** REST client for the blind Delivery Service endpoints. */
  rest: SecureChatRestClient;
  /** Realtime client for the `/secure` socket.io namespace. */
  socket: SecureChatSocketClient;
  /** The injected MLS crypto implementation. */
  crypto: SecureChatCrypto;
  /** Typed persistence over the injected store. */
  repo: SecureChatRepository;
  /** Resolve a conversation's MLS group handle (cache → store → importGroupState), or `null`. */
  resolveGroup: (conversationId: string) => Promise<GroupHandle | null>;
  /** Cache + persist a conversation's group handle (after createGroup / processWelcome). */
  rememberGroup: (conversationId: string, handle: GroupHandle) => Promise<void>;
  /**
   * Persist a conversation's CURRENT group state after an intra-epoch ratchet advance — i.e. an
   * application message we just sent or received. Unlike {@link rememberGroup} it does NOT bump the
   * version or notify listeners: an application message moves the (single-use, forward-secret) MLS
   * ratchet but NOT the epoch, so consumers must not re-resolve the handle. Skipping this persist is
   * the resend-replay bug — on reload the send ratchet rewinds to a consumed generation and the peer
   * rejects the next message as a replay.
   */
  persistGroupState: (conversationId: string, handle: GroupHandle) => Promise<void>;
  /**
   * Current change-version for a conversation's group handle. Bumps every time the handle advances
   * (a join or a processed Commit), so consumers can detect "the group moved" without diffing handles.
   */
  getGroupVersion: (conversationId: string) => number;
  /**
   * Subscribe to group-handle changes across all conversations (fired by {@link rememberGroup}).
   * @returns An unsubscribe function.
   */
  subscribeGroupChange: (listener: () => void) => () => void;
  /**
   * Outbound message size-bucket padding policy. `useSecureMessages` pads plaintext to this before
   * encryption so ciphertext size leaks less; defaults to `"ladder"`.
   */
  padding: PaddingPolicy;
  /** The Agora project id these clients are scoped to. */
  projectId: string;
}

const SecureChatContext = createContext<SecureChatContextValue | null>(null);

/** Props for {@link SecureChatProvider}. */
export interface SecureChatProviderProps {
  /** The MLS crypto implementation (mock for tests; ts-mls/OpenMLS-WASM in platform packages). */
  crypto: SecureChatCrypto;
  /** Agora project id (path-scoped on every endpoint). */
  projectId: string;
  /** Persistence store. Defaults to a non-persistent in-memory store when omitted. */
  store?: SecureChatStore;
  /** Current access token. Re-pass on refresh; read lazily per request. */
  accessToken?: string;
  /** Override token resolution (takes precedence over `accessToken`). */
  getAccessToken?: () => string | undefined;
  /**
   * API base URL including the version prefix (e.g. `https://api.example.com/v7`). Required — secure
   * chat is a standalone transport and does not resolve a URL from any ambient SDK runtime. Read
   * lazily per request, so re-passing a changed value takes effect on the next call.
   */
  baseUrl: string;
  /**
   * Socket.io origin for the `/secure` realtime namespace. Defaults to {@link baseUrl} (the client
   * strips any path to the origin), so pass it only when the socket lives on a different host.
   */
  socketUrl?: string;
  /**
   * Outbound message size-bucket padding policy (metadata hardening). `"ladder"` (default) pads each
   * message up to a fixed size bucket so ciphertext length leaks less; `"none"` frames without padding.
   */
  padding?: PaddingPolicy;
  children: React.ReactNode;
}

/**
 * Provides secure-chat transport, crypto, and persistence to the `useSecure*` hooks. Render inside a
 * `ReplykeProvider`; disconnects the socket on unmount.
 *
 * @param props - {@link SecureChatProviderProps}.
 * @returns A context provider wrapping `children`.
 *
 * @example
 * ```tsx
 * <SecureChatProvider crypto={crypto} projectId={projectId} store={createIndexedDBStore()} accessToken={token}>
 *   <Chat />
 * </SecureChatProvider>
 * ```
 */
export function SecureChatProvider({
  crypto,
  projectId,
  store,
  accessToken,
  getAccessToken,
  baseUrl,
  socketUrl,
  padding = "ladder",
  children,
}: SecureChatProviderProps) {
  const tokenRef = useRef<string | undefined>(accessToken);
  tokenRef.current = accessToken;

  const resolveToken = useMemo(
    () => getAccessToken ?? (() => tokenRef.current),
    [getAccessToken]
  );

  const rest = useMemo(
    () =>
      new SecureChatRestClient({
        projectId,
        getAccessToken: resolveToken,
        getBaseUrl: () => baseUrl,
      }),
    [projectId, resolveToken, baseUrl]
  );

  const socket = useMemo(
    () =>
      new SecureChatSocketClient({
        projectId,
        getAccessToken: resolveToken,
        // Socket origin defaults to the REST base URL (the client strips the path to an origin).
        getSocketUrl: () => socketUrl ?? baseUrl,
      }),
    [projectId, resolveToken, socketUrl, baseUrl]
  );

  const resolvedStore = useMemo(() => store ?? new MemoryStore(), [store]);
  const repo = useMemo(() => new SecureChatRepository(resolvedStore), [resolvedStore]);

  // In-memory GroupHandle cache, keyed by conversationId. Survives re-renders via the ref.
  // NOTE: not cleared on a `store` prop swap — a store change in practice means a new provider
  // instance (fresh cache), not a live prop change on the same mounted provider.
  const groupCache = useRef(new Map<string, GroupHandle>());

  // Per-conversation change counter, bumped whenever a group handle advances (a join or a processed
  // Commit). Lets useSecureMessages re-resolve and flush buffered (undecrypted) rows without a
  // re-fetch. Held in a ref + listener set so a bump notifies consumers WITHOUT re-rendering the
  // provider (and thus rebuilding rest/socket/repo).
  const groupVersion = useRef(new Map<string, number>());
  const groupListeners = useRef(new Set<() => void>());

  const resolveGroup = useCallback(
    async (conversationId: string): Promise<GroupHandle | null> => {
      const cached = groupCache.current.get(conversationId);
      if (cached) return cached;
      const bytes = await repo.loadGroupState(conversationId);
      if (!bytes) {
        // No persisted group for this conversation: the recipient never joined (no Welcome processed),
        // or local state was wiped. Renders as "waiting for key update" until a Welcome arrives.
        log.debug("resolveGroup: no persisted group state", { conversationId });
        return null;
      }
      try {
        const handle = await crypto.importGroupState(bytes);
        groupCache.current.set(conversationId, handle);
        log.debug("resolveGroup: imported group from store", {
          conversationId,
          epoch: handle.epoch.toString(),
          bytes: bytes.length,
        });
        return handle;
      } catch (err) {
        // A persisted group that can't be re-imported is a black hole — it silently degrades to "no
        // group" (a permanent "waiting for key update"). Surface it loudly so a reload-persistence or
        // crypto-version-skew problem is visible instead of looking like an un-joined conversation.
        log.debug("resolveGroup: importGroupState FAILED — group present but unreadable", {
          conversationId,
          bytes: bytes.length,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
    [repo, crypto]
  );

  const rememberGroup = useCallback(
    async (conversationId: string, handle: GroupHandle): Promise<void> => {
      groupCache.current.set(conversationId, handle);
      const bytes = await crypto.exportGroupState(handle);
      await repo.saveGroupState(conversationId, bytes);
      // Signal that this conversation's group advanced, so message hooks re-resolve + flush.
      groupVersion.current.set(conversationId, (groupVersion.current.get(conversationId) ?? 0) + 1);
      groupListeners.current.forEach((l) => l());
    },
    [repo, crypto]
  );

  const persistGroupState = useCallback(
    async (conversationId: string, handle: GroupHandle): Promise<void> => {
      // Re-export the now-advanced ratchet for THIS group and overwrite the persisted blob. The
      // ratchet state lives in the crypto's internal per-group map (keyed by mlsGroupId), so exporting
      // the same handle after a send/receive captures the advanced generation. Deliberately NO version
      // bump and NO listener notify (cf. rememberGroup): an application message is intra-epoch, so a
      // re-resolve would be wasted work and could churn buffered-row retries. The cache holds the same
      // handle object the hook already uses, so re-setting it is idempotent.
      groupCache.current.set(conversationId, handle);
      const bytes = await crypto.exportGroupState(handle);
      await repo.saveGroupState(conversationId, bytes);
    },
    [repo, crypto]
  );

  const getGroupVersion = useCallback(
    (conversationId: string): number => groupVersion.current.get(conversationId) ?? 0,
    []
  );

  const subscribeGroupChange = useCallback((listener: () => void): (() => void) => {
    groupListeners.current.add(listener);
    return () => {
      groupListeners.current.delete(listener);
    };
  }, []);

  useEffect(() => {
    return () => socket.disconnect();
  }, [socket]);

  const value = useMemo<SecureChatContextValue>(
    () => ({
      rest,
      socket,
      crypto,
      repo,
      resolveGroup,
      rememberGroup,
      persistGroupState,
      getGroupVersion,
      subscribeGroupChange,
      padding,
      projectId,
    }),
    [
      rest,
      socket,
      crypto,
      repo,
      resolveGroup,
      rememberGroup,
      persistGroupState,
      getGroupVersion,
      subscribeGroupChange,
      padding,
      projectId,
    ]
  );

  return <SecureChatContext.Provider value={value}>{children}</SecureChatContext.Provider>;
}

/**
 * Access the nearest {@link SecureChatContextValue}.
 *
 * @returns The shared rest/socket/crypto/repo/resolveGroup/projectId for this provider subtree.
 * @throws {Error} When called outside a `<SecureChatProvider>`.
 */
export function useSecureChat(): SecureChatContextValue {
  const ctx = useContext(SecureChatContext);
  if (!ctx) {
    throw new Error("useSecureChat must be used within a <SecureChatProvider>.");
  }
  return ctx;
}
