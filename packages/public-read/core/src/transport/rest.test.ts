import { describe, it, expect, vi, afterEach } from "vitest";
import { AxiosError, type AxiosInstance, type InternalAxiosRequestConfig } from "axios";
import { PublicReadRestClient, PublicReadApiError, isNotFound } from "./rest.js";

/** Reach the client's private axios instance to stub `.get` at the boundary (no real network). */
function httpOf(client: PublicReadRestClient): AxiosInstance {
  return (client as unknown as { http: AxiosInstance }).http;
}

/**
 * Run the client's request interceptor over a minimal config, so we can assert what it does to an
 * outgoing request (baseURL, credentials, stripped headers) without issuing one.
 */
function runInterceptor(
  client: PublicReadRestClient,
  seed: Partial<InternalAxiosRequestConfig> & { headers?: unknown } = {}
): { baseURL?: string; withCredentials?: boolean; deleted: string[] } {
  const deleted: string[] = [];
  const cfg = {
    ...seed,
    headers: seed.headers ?? { delete: (name: string) => deleted.push(name) },
  } as unknown as InternalAxiosRequestConfig;

  const handlers = (
    httpOf(client).interceptors.request as unknown as {
      handlers: { fulfilled: (c: InternalAxiosRequestConfig) => InternalAxiosRequestConfig }[];
    }
  ).handlers;
  const out = handlers[0]!.fulfilled(cfg);
  return { baseURL: out.baseURL, withCredentials: out.withCredentials, deleted };
}

/** Build a real AxiosError (so `axios.isAxiosError` recognizes it) carrying a status + body. */
function axiosErr(status: number, data: unknown): AxiosError {
  return new AxiosError("request failed", "ERR_BAD_RESPONSE", undefined, undefined, {
    status,
    data,
    statusText: "",
    headers: {},
    config: {} as never,
  });
}

const client = () =>
  new PublicReadRestClient({ projectId: "p1", getBaseUrl: () => "http://host/v7" });

afterEach(() => vi.restoreAllMocks());

describe("PublicReadRestClient", () => {
  it("scopes every request to {baseUrl}/{projectId}/public and strips a trailing slash", () => {
    const c = new PublicReadRestClient({ projectId: "p1", getBaseUrl: () => "http://host/v7/" });
    expect(runInterceptor(c).baseURL).toBe("http://host/v7/p1/public");
  });

  it("never attaches an Authorization header and never sends credentials", () => {
    const { deleted, withCredentials } = runInterceptor(client());
    expect(deleted).toContain("Authorization");
    expect(withCredentials).toBe(false);
  });

  it("sends no params at all when none are provided (server defaults win)", async () => {
    const c = client();
    const get = vi.spyOn(httpOf(c), "get").mockResolvedValue({ data: { data: [], pagination: {} } });
    await c.getComments("e1");
    expect(get).toHaveBeenCalledWith("/entities/e1/comments", undefined);
  });

  it("comma-joins include arrays and omits undefined params", async () => {
    const c = client();
    const get = vi.spyOn(httpOf(c), "get").mockResolvedValue({ data: { data: [], pagination: {} } });
    await c.getComments("e1", { include: ["user"], limit: 5, sortBy: undefined });
    expect(get).toHaveBeenCalledWith("/entities/e1/comments", {
      params: { include: "user", limit: 5 },
    });
  });

  it("resolves by foreignId on the dedicated route, as a query param", async () => {
    const c = client();
    const get = vi.spyOn(httpOf(c), "get").mockResolvedValue({ data: { id: "e1" } });
    await c.getEntityByForeignId("homepage-comments", { include: ["user"] });
    expect(get).toHaveBeenCalledWith("/entities/by-foreign-id", {
      params: { foreignId: "homepage-comments", include: "user" },
    });
  });

  it("never sends createIfNotFound on the public by-foreign-id route", async () => {
    // The walled route's flag lazily INSERTS an authorless anchor. Honouring it anonymously would be
    // a row-creation primitive, so the server omits it — and we must never send it.
    const c = client();
    const get = vi.spyOn(httpOf(c), "get").mockResolvedValue({ data: { id: "e1" } });
    await c.getEntityByForeignId("homepage-comments");
    expect(JSON.stringify(get.mock.calls[0])).not.toMatch(/createIfNotFound/i);
  });

  it("passes rootId through untouched (a malformed one is the server's business, not ours)", async () => {
    const c = client();
    const get = vi.spyOn(httpOf(c), "get").mockResolvedValue({ data: { data: [] } });
    await c.getThread("e1", { rootId: "not-a-uuid" });
    expect(get).toHaveBeenCalledWith("/entities/e1/comments/thread", {
      params: { rootId: "not-a-uuid" },
    });
  });

  it("normalizes an axios failure into PublicReadApiError with status + code", async () => {
    const c = client();
    vi.spyOn(httpOf(c), "get").mockRejectedValue(
      axiosErr(404, { error: "Not found", code: "entities/not-found" })
    );
    await expect(c.getEntity("e1")).rejects.toMatchObject({
      name: "PublicReadApiError",
      status: 404,
      code: "entities/not-found",
    });
  });

  it("reports status 0 for a network-level failure", async () => {
    const c = client();
    vi.spyOn(httpOf(c), "get").mockRejectedValue(new AxiosError("network down", "ERR_NETWORK"));
    await expect(c.getThread("e1")).rejects.toMatchObject({ status: 0, code: null });
  });
});

describe("isNotFound", () => {
  it("is true for the gate's 404 — the neutral, deliberately ambiguous case", () => {
    expect(isNotFound(new PublicReadApiError("x", 404, "entities/not-found"))).toBe(true);
  });

  it("is true for a bare 404 with no code", () => {
    expect(isNotFound(new PublicReadApiError("x", 404, null))).toBe(true);
  });

  it("is FALSE for project/not-found — a wrong projectId is host misconfiguration, not an empty thread", () => {
    expect(isNotFound(new PublicReadApiError("x", 404, "project/not-found"))).toBe(false);
  });

  it("is false for other statuses and for non-PublicReadApiError values", () => {
    expect(isNotFound(new PublicReadApiError("x", 500, null))).toBe(false);
    expect(isNotFound(new Error("boom"))).toBe(false);
    expect(isNotFound(null)).toBe(false);
  });
});
