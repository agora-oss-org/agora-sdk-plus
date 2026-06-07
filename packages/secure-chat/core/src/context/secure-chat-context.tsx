// SecureChatProvider — wires the transport + crypto for the secure-chat hooks.
//
// Sits INSIDE a ReplykeProvider: by default it resolves the API base URL and socket origin from
// @agora-sdk/core's runtime singletons (getApiBaseUrl / getSocketUrl), so whatever `baseUrl` the
// app set on ReplykeProvider is honored here too. Crypto is injected (a `SecureChatCrypto`), keeping
// core platform- and library-agnostic — the web/native packages supply the concrete MLS impl.

import React, { createContext, useContext, useEffect, useMemo, useRef } from "react";
import { getApiBaseUrl, getSocketUrl } from "@agora-sdk/core";

import { SecureChatCrypto } from "@agora-sdk/secure-chat-crypto";
import { SecureChatRestClient } from "../transport/rest.js";
import { SecureChatSocketClient } from "../transport/socket.js";

/**
 * The value exposed by {@link useSecureChat}: the shared transport clients, the injected crypto,
 * and the active project id. The hooks build everything else on top of these.
 */
export interface SecureChatContextValue {
  /** REST client for the blind Delivery Service endpoints. */
  rest: SecureChatRestClient;
  /** Realtime client for the `/secure` socket.io namespace. */
  socket: SecureChatSocketClient;
  /** The injected MLS crypto implementation (mock, or platform ts-mls/native). */
  crypto: SecureChatCrypto;
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
 * Provides the secure-chat transport + crypto to the `useSecure*` hooks. Render it inside a
 * `ReplykeProvider`: by default it inherits the API base URL and socket origin from
 * `@agora-sdk/core`'s runtime, and disconnects the socket on unmount.
 *
 * @param props - {@link SecureChatProviderProps} — the injected crypto, project id, token, and
 *   optional base/socket URL overrides.
 * @returns A context provider wrapping `children`.
 *
 * @example
 * ```tsx
 * <ReplykeProvider projectId={projectId} baseUrl={baseUrl}>
 *   <SecureChatProvider crypto={crypto} projectId={projectId} accessToken={token}>
 *     <Chat />
 *   </SecureChatProvider>
 * </ReplykeProvider>
 * ```
 */
export function SecureChatProvider({
  crypto,
  projectId,
  accessToken,
  getAccessToken,
  baseUrl,
  socketUrl,
  children,
}: SecureChatProviderProps) {
  // Keep the latest token in a ref so the per-request resolver always returns the current value
  // without rebuilding the transport clients on every token change.
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

  useEffect(() => {
    return () => socket.disconnect();
  }, [socket]);

  const value = useMemo<SecureChatContextValue>(
    () => ({ rest, socket, crypto, projectId }),
    [rest, socket, crypto, projectId]
  );

  return <SecureChatContext.Provider value={value}>{children}</SecureChatContext.Provider>;
}

/**
 * Access the nearest {@link SecureChatContextValue}.
 *
 * @returns The shared rest/socket/crypto/projectId for this provider subtree.
 * @throws {Error} When called outside a `<SecureChatProvider>`.
 */
export function useSecureChat(): SecureChatContextValue {
  const ctx = useContext(SecureChatContext);
  if (!ctx) {
    throw new Error("useSecureChat must be used within a <SecureChatProvider>.");
  }
  return ctx;
}
