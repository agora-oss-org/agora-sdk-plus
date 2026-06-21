import { describe, it, expect } from "vitest";
import { frameContent, unframe, ContentKind } from "./frame.js";

describe("content frame: [kind][payload]", () => {
  it("prefixes the kind byte and round-trips", () => {
    const payload = new Uint8Array([1, 2, 3]);
    const framed = frameContent(ContentKind.Mimi, payload);
    expect(framed[0]).toBe(0);
    expect(framed.length).toBe(4);
    const { kind, payload: out } = unframe(framed);
    expect(kind).toBe(ContentKind.Mimi);
    expect([...out]).toEqual([1, 2, 3]);
  });
  it("routes a reserved IUC-control kind transparently (payload preserved)", () => {
    const { kind, payload } = unframe(frameContent(ContentKind.IucControl, new Uint8Array([7])));
    expect(kind).toBe(1);
    expect([...payload]).toEqual([7]);
  });
  it("handles an empty payload", () => {
    const { kind, payload } = unframe(frameContent(ContentKind.Mimi, new Uint8Array()));
    expect(kind).toBe(0);
    expect(payload.length).toBe(0);
  });
  it("rejects an empty frame (no kind byte)", () => {
    expect(() => unframe(new Uint8Array())).toThrow(/empty|too short/i);
  });
  it("rejects a kind byte out of 0..255 on encode", () => {
    expect(() => frameContent(256, new Uint8Array())).toThrow(/kind/i);
    expect(() => frameContent(-1, new Uint8Array())).toThrow(/kind/i);
  });
});
