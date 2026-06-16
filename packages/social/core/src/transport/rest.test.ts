import { describe, it, expect, vi, afterEach } from "vitest";
import { AxiosError, type AxiosInstance } from "axios";
import { SocialRestClient, SocialApiError } from "./rest.js";

/** Reach the client's private axios instance to stub `.get` at the boundary (no real network). */
function httpOf(client: SocialRestClient): AxiosInstance {
  return (client as unknown as { http: AxiosInstance }).http;
}

function makeClient() {
  return new SocialRestClient({
    projectId: "p",
    getBaseUrl: () => "http://host/v7",
    getAccessToken: () => "token",
  });
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

afterEach(() => vi.restoreAllMocks());

describe("SocialRestClient", () => {
  it("returns the response body on success", async () => {
    const client = makeClient();
    vi.spyOn(httpOf(client), "get").mockResolvedValue({
      data: { value: 0.5, band: "fine", trend: null, asOf: "2026-06-16T00:00:00Z" },
    });
    await expect(client.getWeather()).resolves.toMatchObject({ band: "fine" });
  });

  it("normalizes a 503 graph-unavailable into a SocialApiError with status + code", async () => {
    const client = makeClient();
    vi.spyOn(httpOf(client), "get").mockRejectedValue(
      axiosErr(503, { error: { code: "social/graph-unavailable" } })
    );
    await expect(client.getConstellation()).rejects.toBeInstanceOf(SocialApiError);
    await expect(client.getConstellation()).rejects.toMatchObject({
      status: 503,
      code: "social/graph-unavailable",
    });
  });

  it("extracts a flat { code } error body too", async () => {
    const client = makeClient();
    vi.spyOn(httpOf(client), "get").mockRejectedValue(
      axiosErr(400, { code: "social/weather-disabled" })
    );
    await expect(client.getWeather()).rejects.toMatchObject({
      status: 400,
      code: "social/weather-disabled",
    });
  });

  it("passes includeInteractions only when explicitly provided", async () => {
    const client = makeClient();
    const get = vi
      .spyOn(httpOf(client), "get")
      .mockResolvedValue({ data: { ties: [], includesInteractions: false, asOf: "x" } });

    await client.getNeighborhood({ includeInteractions: true });
    expect(get).toHaveBeenCalledWith("/neighborhood", { params: { includeInteractions: true } });

    await client.getNeighborhood();
    expect(get).toHaveBeenLastCalledWith("/neighborhood", undefined);
  });
});
