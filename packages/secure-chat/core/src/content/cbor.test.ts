// Deterministic CBOR codec tests — round-trip, canonical byte-exactness (RFC 8949 §3.4 / Appendix A
// vectors), and strict rejection of anything outside the constrained subset.
import { describe, it, expect } from "vitest";
import { encode, decode, CborTag, type CborMap } from "./cbor.js";

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const bytes = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));

describe("cbor: canonical encode (RFC 8949 Appendix A vectors)", () => {
  const vectors: [unknown, string][] = [
    [0, "00"], [1, "01"], [10, "0a"], [23, "17"], [24, "1818"], [25, "1819"],
    [100, "1864"], [1000, "1903e8"], [1000000, "1a000f4240"],
    [1000000000000, "1b000000e8d4a51000"], [-1, "20"], [-10, "29"], [-100, "3863"],
    [-1000, "3903e7"], [false, "f4"], [true, "f5"], [null, "f6"],
    ["", "60"], ["a", "6161"], ["IETF", "6449455446"],
  ];
  for (const [v, h] of vectors) {
    it(`encodes ${JSON.stringify(v)} → ${h}`, () => expect(hex(encode(v as never))).toBe(h));
    it(`round-trips ${h}`, () => expect(decode(bytes(h))).toEqual(v));
  }

  it("encodes byte strings with shortest length", () => {
    expect(hex(encode(new Uint8Array([1, 2, 3, 4])))).toBe("4401020304");
  });
  it("encodes arrays definite-length", () => {
    expect(hex(encode([1, 2, 3]))).toBe("83010203");
  });
  it("sorts map keys by encoded bytes (deterministic)", () => {
    const m: CborMap = new Map<unknown, unknown>([[10, "b"], [1, "a"]]) as CborMap;
    // 01 < 0a, so key 1 sorts first regardless of insertion order:
    // a2 (map,2) | 01 6162? no — key 1 → "a"(6161): 01 6161 | key 10 → "b"(6162): 0a 6162
    expect(hex(encode(m))).toBe("a20161610a6162");
  });
});

describe("cbor: map determinism (explicit bytes)", () => {
  it("orders {1:'a', 10:'b'} as a2 01 6161 0a 6162", () => {
    const m = new Map<unknown, unknown>([[10, "b"], [1, "a"]]) as CborMap;
    expect(hex(encode(m))).toBe("a20161610a6162");
  });
});

describe("cbor: tags", () => {
  it("round-trips a tagged value", () => {
    const t = new CborTag(0, "x");
    const enc = encode(t);
    // tag 0 → c0, then "x" → 6178
    expect(hex(enc)).toBe("c06178");
    const dec = decode(enc) as CborTag;
    expect(dec).toBeInstanceOf(CborTag);
    expect(dec.tag).toBe(0);
    expect(dec.value).toBe("x");
  });
});

describe("cbor: strict decode rejects out-of-subset / non-canonical", () => {
  it("rejects non-shortest integer encoding (1818 ok, but 190017 is non-canonical)", () => {
    expect(() => decode(bytes("190017"))).toThrow(/canonical|shortest/i); // 23 must be 17
  });
  it("rejects indefinite-length array (9f..ff)", () => {
    expect(() => decode(bytes("9f01ff"))).toThrow(/indefinite|subset/i);
  });
  it("rejects a float (major 7, ai 25/26/27)", () => {
    expect(() => decode(bytes("f93c00"))).toThrow(/float|subset/i);
  });
  it("rejects trailing bytes", () => {
    expect(() => decode(bytes("0001"))).toThrow(/trailing/i);
  });
  it("rejects unsorted map keys", () => {
    // a2 | 0a 6162 (key 10 first) | 01 6161 (key 1 second) — out of canonical order
    expect(() => decode(bytes("a20a6162016161"))).toThrow(/sorted|canonical/i);
  });
  it("rejects duplicate map keys", () => {
    // a2 | 01 6161 | 01 6162 — key 01 appears twice
    expect(() => decode(bytes("a2016161016162"))).toThrow(/duplicate/i);
  });
  it("enforces maxBytes", () => {
    expect(() => decode(encode(new Uint8Array(100)), { maxBytes: 10 })).toThrow(/too large|bounds/i);
  });
  it("enforces maxDepth", () => {
    expect(() => decode(encode([[[[1]]]]), { maxDepth: 2 })).toThrow(/depth/i);
  });
  it("enforces maxItems", () => {
    expect(() => decode(encode([1, 2, 3]), { maxItems: 2 })).toThrow(/items|bounds/i);
  });
});

describe("cbor: round-trips nested structures", () => {
  it("round-trips a map of mixed values", () => {
    const m = new Map<unknown, unknown>([[1, new Uint8Array([9])], ["k", [true, null]]]) as CborMap;
    const out = decode(encode(m)) as CborMap;
    expect(out.get(1)).toEqual(new Uint8Array([9]));
    expect(out.get("k")).toEqual([true, null]);
  });
});
