// usePublicEntity — resolve one internet-public entity anonymously, by uuid OR by the host app's key.
//
// This hook is the RESOLVER for the whole feature. The entity's uuid is generated per install, so an
// embed addresses the anchor by `foreignId` ("homepage-comments", a post slug). But the comment
// routes are uuid-only — `by-foreign-id` resolves the entity and nothing else — so this hook returns
// the resolved `entityId` alongside the entity, and callers chain it:
//
//     foreignId → usePublicEntity → entityId → usePublicCommentThread → nodes
//
// The comment hooks no-op on a null id, which is what makes that chain safe while this leg is still
// in flight. Mirroring the server's addressing exactly (uuid-only comments) keeps the SDK from
// inventing a mode the API doesn't have.
//
// `notFound` is a first-class boolean, SEPARATE from `error`, and that separation is the point. The
// gate collapses unpublished / missing / draft / moderation-removed / space-went-private into one
// indistinguishable 404 (PUBLIC-API.md §4). Any message a renderer wrote for it would be a guess, and
// shipping that guess hands an anonymous prober the existence oracle the 404-never-403 posture exists
// to deny. So: 404 → notFound, no error, no message. A 400 missing-foreign-id is NOT that — it is a
// caller bug and stays a real error.

import { useCallback, useEffect, useState } from "react";

import { usePublicRead } from "../context/public-read-context.js";
import { isNotFound, type PublicEntityQuery } from "../transport/rest.js";
import type { Entity, PublicEntityInclude } from "../contract/index.js";

/**
 * How to address an entity: a bare uuid string, an explicit `{ entityId }`, or `{ foreignId }` —
 * the host app's own stable key. `null`/`undefined` skips fetching entirely.
 */
export type PublicEntityTarget =
  | string
  | { entityId: string }
  | { foreignId: string }
  | null
  | undefined;

/** The value returned by {@link usePublicEntity}. */
export interface UsePublicEntityValues {
  /** The entity, or `null` while loading, when absent, or on failure. */
  entity: Entity | null;
  /**
   * The resolved entity uuid, or `null` until it is known.
   *
   * Chain this into `usePublicCommentThread` / `usePublicComments`, which are uuid-only.
   */
  entityId: string | null;
  /** True while a fetch is in flight. */
  loading: boolean;
  /**
   * True when the server's gate returned its neutral `404`.
   *
   * Render one neutral empty state. Do **not** render a reason — see the module header.
   */
  notFound: boolean;
  /**
   * A real failure: network, `5xx`, `project/not-found`, or `400 entities/missing-foreign-id`.
   * Never set for the gate's `404`.
   */
  error: unknown;
  /** Re-run the fetch. */
  refresh: () => Promise<void>;
}

/**
 * Normalize a {@link PublicEntityTarget} into a `[kind, key]` pair, or `null` when there is nothing
 * to fetch.
 *
 * An empty *bare string* counts as absent — that shape is almost always "the id hasn't arrived yet".
 * An explicit `{ foreignId: "" }` does **not**: the caller clearly meant to address something, so it
 * dispatches and lets the server's `400 entities/missing-foreign-id` surface the bug rather than
 * silently rendering an empty thread.
 */
function resolveTarget(target: PublicEntityTarget): ["uuid" | "foreign", string] | null {
  if (target === null || target === undefined) return null;
  if (typeof target === "string") return target ? ["uuid", target] : null;
  if ("foreignId" in target) return ["foreign", target.foreignId];
  return target.entityId ? ["uuid", target.entityId] : null;
}

/**
 * Resolve a single internet-public entity, by uuid or by the host app's `foreignId`.
 *
 * @param target - {@link PublicEntityTarget}. A bare string is treated as a uuid.
 * @param opts - Optional relations to inline (`user`, `files`).
 * @returns {@link UsePublicEntityValues}, including the resolved `entityId` for chaining.
 *
 * @example
 * ```tsx
 * // Address the anchor by the key your app already uses — the uuid differs per install.
 * const { entity, entityId, notFound } = usePublicEntity({ foreignId: "homepage-comments" });
 * const { nodes } = usePublicCommentThread(entityId);   // no-ops until entityId resolves
 * if (notFound) return <p>No comments to show.</p>;
 * return <h1>{entity?.title}</h1>;
 * ```
 */
export function usePublicEntity(
  target: PublicEntityTarget,
  opts?: PublicEntityQuery
): UsePublicEntityValues {
  const { rest } = usePublicRead();
  const include = opts?.include?.join(",");
  const resolved = resolveTarget(target);
  // Destructured into primitives so the callback identity depends on values, not on a fresh object
  // literal produced by `resolveTarget` on every render.
  const kind = resolved?.[0] ?? null;
  const key = resolved?.[1] ?? null;

  const [entity, setEntity] = useState<Entity | null>(null);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const refresh = useCallback(async () => {
    // `key` may legitimately be "" (an explicit empty foreignId) — guard on `kind`, not on truthiness,
    // so that caller bug reaches the server and surfaces as an error instead of silently no-op'ing.
    if (kind === null || key === null) return;
    setLoading(true);
    setNotFound(false);
    setError(null);
    const query = include ? { include: include.split(",") as PublicEntityInclude[] } : undefined;
    try {
      setEntity(
        kind === "foreign"
          ? await rest.getEntityByForeignId(key, query)
          : await rest.getEntity(key, query)
      );
    } catch (err) {
      setEntity(null);
      if (isNotFound(err)) setNotFound(true);
      else setError(err);
    } finally {
      setLoading(false);
    }
    // `include` is a joined string so a fresh array literal per render does not re-trigger the fetch.
  }, [kind, key, include, rest]);

  useEffect(() => {
    if (kind === null || key === null) {
      setEntity(null);
      setNotFound(false);
      setError(null);
      return;
    }
    void refresh();
  }, [kind, key, refresh]);

  return { entity, entityId: entity?.id ?? null, loading, notFound, error, refresh };
}
