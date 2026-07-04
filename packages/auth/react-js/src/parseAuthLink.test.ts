// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { parseAuthLink, stripTokenFromUrl } from "./parseAuthLink";

describe("parseAuthLink", () => {
  it("returns the token when projectId matches", () => {
    expect(parseAuthLink("p1", "?projectId=p1&token=abc")).toEqual({ ok: true, token: "abc" });
  });
  it("trims the token", () => {
    expect(parseAuthLink("p1", "?token=%20abc%20")).toEqual({ ok: true, token: "abc" });
  });
  it("proceeds when the link omits projectId (provider is authoritative)", () => {
    expect(parseAuthLink("p1", "?token=abc")).toEqual({ ok: true, token: "abc" });
  });
  it("fails closed when the link projectId differs from the provider's", () => {
    expect(parseAuthLink("p1", "?projectId=p2&token=abc")).toEqual({ ok: false, reason: "project-mismatch" });
  });
  it("reports a missing token", () => {
    expect(parseAuthLink("p1", "?projectId=p1")).toEqual({ ok: false, reason: "missing-token" });
  });
});

describe("stripTokenFromUrl", () => {
  afterEach(() => window.history.replaceState(null, "", "/"));
  it("removes only the token param, keeping other query + path", () => {
    window.history.replaceState(null, "", "/auth/verify-email?projectId=p1&token=secret&x=1");
    stripTokenFromUrl();
    expect(window.location.search).toBe("?projectId=p1&x=1");
    expect(window.location.pathname).toBe("/auth/verify-email");
  });
  it("is a no-op when there is no token", () => {
    window.history.replaceState(null, "", "/auth/verify-email?projectId=p1");
    expect(() => stripTokenFromUrl()).not.toThrow();
    expect(window.location.search).toBe("?projectId=p1");
  });
});
