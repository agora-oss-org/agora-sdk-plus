// Tests for the base64 ⇄ Uint8Array wire-boundary helpers.
//
// These are the only place binary crosses to/from the server contract, so the round-trip and the
// padding/whitespace/error edges are load-bearing for every ciphertext, KeyPackage, and Welcome.

import { describe, it, expect } from "vitest";
import { toBase64, fromBase64, utf8ToBytes, bytesToUtf8 } from "./base64";

const bytes = (...xs: number[]) => new Uint8Array(xs);

describe("toBase64 / fromBase64", () => {
  it("round-trips bytes of every length-mod-3 remainder", () => {
    for (let len = 0; len < 32; len++) {
      const input = new Uint8Array(len);
      for (let i = 0; i < len; i++) input[i] = (i * 31 + 7) & 0xff;
      expect(fromBase64(toBase64(input))).toEqual(input);
    }
  });

  it("emits standard padding for 1- and 2-byte tails", () => {
    expect(toBase64(bytes(0x66))).toBe("Zg==");           // 1 byte → two '='
    expect(toBase64(bytes(0x66, 0x6f))).toBe("Zm8=");      // 2 bytes → one '='
    expect(toBase64(bytes(0x66, 0x6f, 0x6f))).toBe("Zm9v"); // 3 bytes → no padding
  });

  it("encodes the empty array as the empty string", () => {
    expect(toBase64(bytes())).toBe("");
    expect(fromBase64("")).toEqual(bytes());
  });

  it("decodes ignoring ASCII whitespace (line-wrapped base64)", () => {
    expect(fromBase64("Zm9v\nYm Fy\t")).toEqual(utf8ToBytes("foobar"));
  });

  it("throws on an invalid base64 character", () => {
    expect(() => fromBase64("not valid!*")).toThrow(/invalid base64 character/);
  });

  it("handles the full byte range 0x00–0xff", () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    expect(fromBase64(toBase64(all))).toEqual(all);
  });
});

describe("utf8ToBytes / bytesToUtf8", () => {
  it("round-trips unicode text (incl. multibyte + emoji)", () => {
    const text = "secure 💜 chat — MLS café";
    expect(bytesToUtf8(utf8ToBytes(text))).toBe(text);
  });

  it("survives a base64 hop, as a message would on the wire", () => {
    const text = "hello 🌷";
    expect(bytesToUtf8(fromBase64(toBase64(utf8ToBytes(text))))).toBe(text);
  });
});
