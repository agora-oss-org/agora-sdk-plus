import { describe, it, expect, vi, afterEach } from "vitest";
import { AxiosError, type AxiosInstance } from "axios";
import {
  SocialRestClient,
  SocialApiError,
  isSocialDegradation,
  transparencyToConfig,
  type SocialTransparencyWire,
} from "./rest.js";

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

/** The nested DTO the server's `/social/transparency` actually returns (lib/social-config.ts
 *  `transparencyView`) — garden/analytics/decay groups, NOT the flat ResolvedSocialConfig. */
const WIRE: SocialTransparencyWire = {
  privacyTier: "corporate",
  analytics: {
    influenceScores: true,
    siloDetection: true,
    engagementScores: true,
    frictionAnalytics: true,
    readReceiptsAllowed: true,
  },
  garden: { graph: true, weather: true, constellation: true, neighborhood: true, readAffinity: true },
  decay: { warmthHalfLifeDays: 30, frictionHalfLifeDays: 14 },
};

describe("transparencyToConfig — nested wire → flat ResolvedSocialConfig", () => {
  it("maps the garden group to the flat *Enabled gate keys the hooks read", () => {
    const cfg = transparencyToConfig(WIRE);
    expect(cfg.graphEnabled).toBe(true);
    expect(cfg.weatherEnabled).toBe(true);
    expect(cfg.constellationEnabled).toBe(true);
    expect(cfg.neighborhoodEnabled).toBe(true);
    expect(cfg.readAffinityEnabled).toBe(true);
  });

  it("maps the analytics group and decay group", () => {
    const cfg = transparencyToConfig(WIRE);
    expect(cfg.privacyTier).toBe("corporate");
    expect(cfg.influenceScoresEnabled).toBe(true);
    expect(cfg.siloDetectionEnabled).toBe(true);
    expect(cfg.engagementScoresEnabled).toBe(true);
    expect(cfg.frictionAnalyticsEnabled).toBe(true);
    expect(cfg.readReceiptsAllowed).toBe(true);
    expect(cfg.warmthHalfLifeDays).toBe(30);
    expect(cfg.frictionHalfLifeDays).toBe(14);
  });

  it("defaults the three fields transparency does not expose (fail-closed booleans)", () => {
    const cfg = transparencyToConfig(WIRE);
    // Not carried on the wire — must not surface as `undefined` (which would crash the typed hooks).
    expect(cfg.neighborhoodIncludeInteractions).toBe(false);
    expect(cfg.frictionVisibleToStewards).toBe(false);
    expect(typeof cfg.constellationKFloor).toBe("number");
  });

  it("fails closed: a disabled garden maps every gate to false", () => {
    const cfg = transparencyToConfig({
      ...WIRE,
      garden: { graph: false, weather: false, constellation: false, neighborhood: false, readAffinity: false },
    });
    expect(cfg.graphEnabled).toBe(false);
    expect(cfg.weatherEnabled).toBe(false);
    expect(cfg.constellationEnabled).toBe(false);
    expect(cfg.neighborhoodEnabled).toBe(false);
  });

  it("coerces non-boolean garbage to false (never leaves a gate truthy-but-not-true)", () => {
    const cfg = transparencyToConfig({
      ...WIRE,
      garden: { ...WIRE.garden, weather: "yes" as unknown as boolean },
    });
    expect(cfg.weatherEnabled).toBe(false);
  });
});

describe("SocialRestClient.getTransparency — maps the wire shape, not a raw cast", () => {
  it("returns a flat config whose weatherEnabled reflects garden.weather", async () => {
    const client = makeClient();
    vi.spyOn(httpOf(client), "get").mockResolvedValue({ data: WIRE });
    const cfg = await client.getTransparency();
    expect(cfg.weatherEnabled).toBe(true);
    expect(cfg.constellationEnabled).toBe(true);
    expect(cfg.neighborhoodEnabled).toBe(true);
  });
});

describe("isSocialDegradation", () => {
  it("is true for graph-unavailable and any feature-disabled code", () => {
    expect(isSocialDegradation(new SocialApiError("x", 503, "social/graph-unavailable"))).toBe(true);
    expect(isSocialDegradation(new SocialApiError("x", 400, "social/weather-disabled"))).toBe(true);
    expect(isSocialDegradation(new SocialApiError("x", 400, "social/constellation-disabled"))).toBe(true);
    expect(isSocialDegradation(new SocialApiError("x", 400, "social/neighborhood-disabled"))).toBe(true);
  });

  it("is false for real failures, unknown codes, and non-SocialApiError errors", () => {
    expect(isSocialDegradation(new SocialApiError("x", 500, null))).toBe(false);
    expect(isSocialDegradation(new SocialApiError("x", 401, "auth/unauthorized"))).toBe(false);
    expect(isSocialDegradation(new Error("boom"))).toBe(false);
    expect(isSocialDegradation(null)).toBe(false);
  });
});
