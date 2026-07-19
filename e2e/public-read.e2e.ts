// Opt-in e2e for the anonymous public-read surface, against a locally running agora-server.
//
// Covers exactly what the mocked unit suite cannot prove: real CORS headers, the ETag → 304
// revalidation round trip, `no-store` on the gate's 404, live PII redaction, and that the walled
// surface still rejects the same entity (the hole is the /public/ prefix, not the entity).
//
// Skipped unless AGORA_E2E_PUBLIC_PROJECT_ID is set, so `pnpm test` and CI stay server-free. Seed the
// fixture with `pnpm seed` from agora-server/apps/api — it publishes an anchor with
// foreignId "homepage-comments" through the real PATCH /entities/:id/visibility action.
//
// The anchor's uuid is generated per install, so this resolves it by foreignId rather than
// hardcoding one — which is also the addressing story the SDK exists to support.

import { describe, it, expect, beforeAll } from "vitest";
import { PublicReadRestClient } from "../packages/public-read/core/src/index.js";

const PROJECT_ID = process.env.AGORA_E2E_PUBLIC_PROJECT_ID;
const FOREIGN_ID = process.env.AGORA_E2E_PUBLIC_FOREIGN_ID ?? "homepage-comments";
const BASE_URL = process.env.AGORA_E2E_BASE_URL ?? "http://localhost:4000/v7";

const suite = PROJECT_ID ? describe : describe.skip;

suite("public-read e2e", () => {
  const rest = new PublicReadRestClient({
    projectId: PROJECT_ID!,
    getBaseUrl: () => BASE_URL,
  });
  const pub = `${BASE_URL}/${PROJECT_ID}/public`;
  let entityId: string;

  beforeAll(async () => {
    const entity = await rest.getEntityByForeignId(FOREIGN_ID);
    entityId = entity.id;
  });

  it("resolves the anchor by foreignId and reports it as internet-public", async () => {
    const entity = await rest.getEntityByForeignId(FOREIGN_ID, { include: ["user"] });
    expect(entity.id).toBe(entityId);
    expect(entity.public).toBe(true);
  });

  it("redacts PII on an included user", async () => {
    const list = await rest.getComments(entityId, { include: ["user"] });
    const withUser = list.data
      .map((c) => (c as unknown as { user?: Record<string, unknown> }).user)
      .find(Boolean);
    expect(withUser).toBeTruthy();
    expect(withUser!.birthdate ?? null).toBeNull();
    expect(withUser!.metadata ?? {}).toEqual({});
    // The internet still gets the presentational fields.
    expect(withUser!.username).toBeTruthy();
  });

  it("returns a well-formed pagination envelope with no viewer reactions", async () => {
    const res = await rest.getComments(entityId, { include: ["user"] });
    expect(Array.isArray(res.data)).toBe(true);
    expect(res.pagination).toMatchObject({
      page: expect.any(Number),
      pageSize: expect.any(Number),
      hasMore: expect.any(Boolean),
    });
    for (const c of res.data) expect(c.userReaction).toBeNull();
  });

  it("returns a server-nested thread — proof the nesting is not assembled client-side", async () => {
    const { data } = await rest.getThread(entityId, { include: ["user"] });
    expect(data.length).toBeGreaterThan(0);
    for (const n of data) expect(Array.isArray(n.replies)).toBe(true);
    // The seeded fixture includes a nested reply.
    expect(data.some((n) => n.replies.length > 0)).toBe(true);
  });

  it("serves wildcard CORS with no credentials and no Vary", async () => {
    // Raw fetch, not the SDK client: these assertions are about headers the client abstracts away.
    const res = await fetch(`${pub}/entities/${entityId}`, {
      headers: { Origin: "https://some-blog.example" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    // A credentialed response against a wildcard ACAO would fail preflight in a browser.
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    // No `Vary: Origin` on this prefix: the ACAO is unconditionally `*`, so varying by origin would
    // only fragment shared caches one entry per embedding site. (`Vary: Accept-Encoding` from
    // compression negotiation is expected and unrelated — assert on Origin specifically.)
    expect(res.headers.get("vary")?.toLowerCase() ?? "").not.toContain("origin");
  });

  it("revalidates via ETag → 304, keeping the CORS header on the 304", async () => {
    const first = await fetch(`${pub}/entities/${entityId}`);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    expect(first.headers.get("cache-control")).toContain("s-maxage=300");
    expect(first.headers.get("cache-control")).toContain("max-age=0");

    const second = await fetch(`${pub}/entities/${entityId}`, {
      headers: { "If-None-Match": etag! },
    });
    expect(second.status).toBe(304);
    expect(second.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("404s an unknown entity with no-store, so a publish is never cached away", async () => {
    const res = await fetch(`${pub}/entities/00000000-0000-4000-8000-000000000000`);
    expect(res.status).toBe(404);
    // A cached 404 would keep a freshly-published post invisible at the edge for the whole window.
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("classifies the gate's 404 as neutral notFound, but a wrong projectId as a real error", async () => {
    const { isNotFound, PublicReadApiError } = await import(
      "../packages/public-read/core/src/index.js"
    );

    await expect(rest.getEntity("00000000-0000-4000-8000-000000000000")).rejects.toSatisfy(
      (e: unknown) => isNotFound(e)
    );

    const wrongProject = new PublicReadRestClient({
      projectId: "99999999-9999-4999-8999-999999999999",
      getBaseUrl: () => BASE_URL,
    });
    await expect(wrongProject.getEntityByForeignId(FOREIGN_ID)).rejects.toSatisfy((e: unknown) => {
      const err = e as InstanceType<typeof PublicReadApiError>;
      // Host misconfiguration must stay loud rather than rendering as an empty thread.
      return !isNotFound(err) && err.code === "project/not-found";
    });
  });

  it("still 401s the same entity behind the wall — the hole is the prefix, not the entity", async () => {
    const res = await fetch(`${BASE_URL}/${PROJECT_ID}/entities/${entityId}`);
    expect(res.status).toBe(401);
  });
});
