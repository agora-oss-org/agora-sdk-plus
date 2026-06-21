// Differential oracle: our deterministic codec vs the mature `cbor2` library (test-only devDependency).
// A disagreement in either direction is a caught bug. We restrict generated values to OUR subset; the
// CDE option in cbor2 mirrors our deterministic rules so byte output must match.
//
// cbor2 API notes (confirmed against cbor2@2.3.0):
//   - encode/decode are named exports (no default or namespace export).
//   - cbor2 does NOT encode JS Map as CBOR map by default (only Array + Uint8Array are registered;
//     Map falls through to Object.entries(), yielding an empty map). So for test 2 (cbor2 encode),
//     we convert CborMap → plain object before handing off — our generator only ever uses string
//     map keys (prefixed "k"+i), so this conversion is lossless.
//   - cbor2 decodes CBOR maps to plain objects by default (when all keys are strings). We pass
//     preferMap:true so round-trips through cbor2 give back a Map, which normalize() can handle
//     uniformly.
//   - `encode(v, {cde: true})` enables CDE (CBOR Common Deterministic Encoding Profile,
//     draft-ietf-cbor-cde-05), which uses sortCoreDeterministic — sort by encoded-byte
//     representation, RFC 8949 §4.2.1 — identical to our map-key sort invariant.
import { describe, it, expect } from "vitest";
import { encode as cbor2Encode, decode as cbor2Decode } from "cbor2";
import { encode, decode, type CborValue, type CborMap } from "./cbor.js";

// A tiny seeded PRNG (no Math.random — deterministic, reproducible failures). NOT security-relevant.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);
}

function gen(r: () => number, depth: number): CborValue {
  const pick = r();
  if (depth <= 0 || pick < 0.45) {
    const k = r();
    if (k < 0.3) return Math.floor(r() * 1e9);
    if (k < 0.5) return -Math.floor(r() * 1e9);
    if (k < 0.7) return r() < 0.33 ? true : r() < 0.5 ? false : null;
    if (k < 0.85) return "s" + Math.floor(r() * 1e6).toString(36);
    return new Uint8Array(Array.from({ length: Math.floor(r() * 6) }, () => Math.floor(r() * 256)));
  }
  if (pick < 0.75) return Array.from({ length: Math.floor(r() * 4) }, () => gen(r, depth - 1));
  const m: CborMap = new Map();
  const n = Math.floor(r() * 4);
  for (let i = 0; i < n; i++) m.set("k" + i, gen(r, depth - 1));
  return m;
}

describe("cbor: differential oracle vs cbor2", () => {
  it("our encode bytes decode back to an equal value via cbor2 (1000 cases)", () => {
    const r = rng(0xc0ffee);
    for (let i = 0; i < 1000; i++) {
      const v = gen(r, 3);
      const ourBytes = encode(v);
      // cbor2 must accept our canonical output. preferMap:true makes cbor2 always return Map for
      // CBOR maps (instead of plain objects when all keys are strings), so normalize() handles
      // both paths uniformly via its Map branch.
      const viaLib = cbor2Decode(ourBytes, { preferMap: true });
      // Re-encode the library's view with our codec and compare bytes (value equality is awkward
      // across Map vs object); canonical encoding makes byte-equality the right invariant.
      expect([...encode(normalize(viaLib))]).toEqual([...ourBytes]);
    }
  });

  it("cbor2 CDE encode matches ours (1000 cases)", () => {
    const r = rng(0x1234);
    for (let i = 0; i < 1000; i++) {
      const v = gen(r, 3);
      const ours = encode(v);
      // cbor2 cannot encode JS Map as CBOR map (not registered; falls through to Object.entries
      // which yields nothing). Convert CborMap → plain object first — our generator uses only
      // string keys ("k"+i), so this is always lossless. cde:true uses sortCoreDeterministic,
      // matching our RFC 8949 §4.2 byte-order sort.
      const theirs = cbor2Encode(toPlain(v), { cde: true });
      // Compare via our strict decoder to avoid cross-lib representation drift.
      expect([...encode(decode(theirs))]).toEqual([...ours]);
    }
  });
});

// cbor2 (with preferMap:true) decodes maps to Map; without it, to plain objects. Normalize to the
// shape our encoder expects: Map for CBOR maps, Uint8Array for byte strings. The library also
// returns bigint for large integers; normalize those to number/bigint via the same threshold we use
// in our decoder (safe-int range stays number, larger stays bigint).
function normalize(v: unknown): CborValue {
  if (v === null || typeof v === "boolean" || typeof v === "string") return v;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return v;
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return v.map(normalize);
  if (v instanceof Map) {
    const m: CborMap = new Map();
    for (const [k, val] of v) m.set(normalize(k), normalize(val));
    return m;
  }
  if (typeof v === "object") {
    // cbor2 without preferMap decodes string-keyed CBOR maps to plain objects; treat them as maps.
    const m: CborMap = new Map();
    for (const [k, val] of Object.entries(v as object)) m.set(k, normalize(val));
    return m;
  }
  throw new Error("oracle: unexpected library value " + String(v));
}

// Convert CborValue to a form cbor2.encode can handle: CborMap → plain object (string keys only,
// which is what our generator produces). All other types are cbor2-encodable as-is.
function toPlain(v: CborValue): unknown {
  if (v === null || typeof v === "boolean" || typeof v === "string" || typeof v === "number" || typeof v === "bigint") return v;
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return v.map(toPlain);
  if (v instanceof Map) {
    const obj: Record<string, unknown> = {};
    for (const [k, val] of v as CborMap) obj[k as string] = toPlain(val);
    return obj;
  }
  throw new Error("oracle: unexpected value in toPlain: " + String(v));
}
