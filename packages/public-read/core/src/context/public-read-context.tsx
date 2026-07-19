// PublicReadProvider — constructs and shares the tokenless public-read REST client.
//
// Deliberately simpler than SocialProvider: there is no token prop and NO mount-time fetch, because
// the anonymous surface has no transparency/feature-gate endpoint to resolve. There is nothing to
// load, so there is no `loading` gate and no all-disabled sentinel — this provider memoizes a client
// and stops.
//
// Two hard requirements it satisfies structurally (see docs/PUBLIC-READ.md §6):
//   • Works with NO <ReplykeProvider> in the tree — a third-party blog has no Agora SDK installed.
//   • Works INSIDE one without inheriting its token, boot latch, or interceptors — there is no code
//     path here that could read them.

import React, { createContext, useContext, useMemo } from "react";

import { PublicReadRestClient } from "../transport/rest.js";

/** The value exposed by {@link usePublicRead}. */
export interface PublicReadContextValue {
  /** REST client for the four anonymous public endpoints. */
  rest: PublicReadRestClient;
  /** The Agora project id this client is scoped to. */
  projectId: string;
}

const PublicReadContext = createContext<PublicReadContextValue | null>(null);

/** Props for {@link PublicReadProvider}. */
export interface PublicReadProviderProps {
  /** Agora project id (path-scoped on every endpoint). */
  projectId: string;
  /**
   * API base URL including the version prefix (e.g. `https://api.example.com/v7`). Required — this
   * is a standalone transport and resolves no URL from any ambient SDK runtime. Read lazily per
   * request, so re-passing a changed value takes effect on the next call.
   */
  baseUrl: string;
  children: React.ReactNode;
}

/**
 * Provides the tokenless public-read REST client to the `usePublic*` hooks and components.
 *
 * Takes no access token and issues no request on mount.
 *
 * @param props - {@link PublicReadProviderProps}.
 * @returns A context provider wrapping `children`.
 *
 * @example
 * ```tsx
 * <PublicReadProvider projectId={projectId} baseUrl="https://api.example.com/v7">
 *   <PublicComments foreignId="homepage-comments" />
 * </PublicReadProvider>
 * ```
 */
export function PublicReadProvider({ projectId, baseUrl, children }: PublicReadProviderProps) {
  const rest = useMemo(
    () => new PublicReadRestClient({ projectId, getBaseUrl: () => baseUrl }),
    [projectId, baseUrl]
  );

  const value = useMemo<PublicReadContextValue>(() => ({ rest, projectId }), [rest, projectId]);

  return <PublicReadContext.Provider value={value}>{children}</PublicReadContext.Provider>;
}

/**
 * Access the nearest {@link PublicReadContextValue}.
 *
 * @returns The shared REST client and project id.
 * @throws {Error} When called outside a `<PublicReadProvider>`.
 */
export function usePublicRead(): PublicReadContextValue {
  const ctx = useContext(PublicReadContext);
  if (!ctx) {
    throw new Error("usePublicRead must be used within a <PublicReadProvider>.");
  }
  return ctx;
}
