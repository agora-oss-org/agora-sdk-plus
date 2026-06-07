// SecureChatProvider — wires transport + crypto + persistence for the secure-chat hooks.
//
// Sits INSIDE a ReplykeProvider: by default it resolves the API base URL and socket origin from
// @agora-sdk/core's runtime singletons (getApiBaseUrl / getSocketUrl). Crypto AND the persistence
// store are injected, keeping core platform- and library-agnostic. The provider builds a typed
// SecureChatRepository over the store plus a cached resolveGroup/rememberGroup so the hooks become
// self-sufficient (no need to thread a GroupHandle in by hand).

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef } from "react";
import { getApiBaseUrl, getSocketUrl } from "@agora-sdk/core";
import { SecureChatCrypto, GroupHandle } from "@agora-sdk/secure-chat-crypto";

import { SecureChatRestClient } from "../transport/rest.js";
import { SecureChatSocketClient } from "../transport/socket.js";
import { SecureChatStore } from "../persistence/store.js";
import { MemoryStore } from "../persistence/memory-store.js";
import { SecureChatRepository } from "../persistence/repository.js";

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
  /** Override the API base URL. Defaults to @agora-sdk/core `getApiBaseUrl()`. */
  baseUrl?: string;
  /** Override the socket origin. Defaults to @agora-sdk/core `getSocketUrl()`. */
  socketUrl?: string;
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
        getBaseUrl: () => baseUrl ?? getApiBaseUrl(),
      }),
    [projectId, resolveToken, baseUrl]
  );

  const socket = useMemo(
    () =>
      new SecureChatSocketClient({
        projectId,
        getAccessToken: resolveToken,
        getSocketUrl: () => socketUrl ?? getSocketUrl(),
      }),
    [projectId, resolveToken, socketUrl]
  );

  const resolvedStore = useMemo(() => store ?? new MemoryStore(), [store]);
  const repo = useMemo(() => new SecureChatRepository(resolvedStore), [resolvedStore]);

  // In-memory GroupHandle cache, keyed by conversationId. Survives re-renders via the ref.
  // NOTE: not cleared on a `store` prop swap — a store change in practice means a new provider
  // instance (fresh cache), not a live prop change on the same mounted provider.
  const groupCache = useRef(new Map<string, GroupHandle>());

  const resolveGroup = useCallback(
    async (conversationId: string): Promise<GroupHandle | null> => {
      const cached = groupCache.current.get(conversationId);
      if (cached) return cached;
      const bytes = await repo.loadGroupState(conversationId);
      if (!bytes) return null;
      const handle = await crypto.importGroupState(bytes);
      groupCache.current.set(conversationId, handle);
      return handle;
    },
    [repo, crypto]
  );

  const rememberGroup = useCallback(
    async (conversationId: string, handle: GroupHandle): Promise<void> => {
      groupCache.current.set(conversationId, handle);
      const bytes = await crypto.exportGroupState(handle);
      await repo.saveGroupState(conversationId, bytes);
    },
    [repo, crypto]
  );

  useEffect(() => {
    return () => socket.disconnect();
  }, [socket]);

  const value = useMemo<SecureChatContextValue>(
    () => ({ rest, socket, crypto, repo, resolveGroup, rememberGroup, projectId }),
    [rest, socket, crypto, repo, resolveGroup, rememberGroup, projectId]
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
