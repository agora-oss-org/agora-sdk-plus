import { describe, it, expect } from "vitest";
import { padPlaintext, unpadPlaintext, nextBucket, type PaddingPolicy } from "./padding.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const HEADER = 5;

describe("nextBucket", () => {
  it("maps framed lengths to the fixed ladder rungs", () => {
    expect(nextBucket(0)).toBe(32);
    expect(nextBucket(32)).toBe(32);
    expect(nextBucket(33)).toBe(64);
    expect(nextBucket(200)).toBe(256);
    expect(nextBucket(8192)).toBe(8192);
  });

  it("rounds up to 8 KiB multiples above the ladder", () => {
    expect(nextBucket(8193)).toBe(16384);
    expect(nextBucket(16384)).toBe(16384);
    expect(nextBucket(16385)).toBe(24576);
  });
});

describe("padPlaintext / unpadPlaintext", () => {
  it("round-trips arbitrary content under the ladder policy", () => {
    for (const text of ["", "hi", "hello 💜", "x".repeat(300), "y".repeat(9000)]) {
      const framed = padPlaintext(enc.encode(text));
      expect(dec.decode(unpadPlaintext(framed))).toBe(text);
    }
  });

  it("pads the frame up to exactly the expected bucket", () => {
    // content len + 5-byte header → nextBucket.
    expect(padPlaintext(enc.encode("")).length).toBe(32); // 0 + 5 → 32
    expect(padPlaintext(new Uint8Array(27)).length).toBe(32); // 27 + 5 = 32 → 32
    expect(padPlaintext(new Uint8Array(28)).length).toBe(64); // 28 + 5 = 33 → 64
    expect(padPlaintext(new Uint8Array(200)).length).toBe(256); // 205 → 256
    expect(padPlaintext(new Uint8Array(9000)).length).toBe(16384); // 9005 → 16384
  });

  it("hides the true content length (padding is zero bytes after the content)", () => {
    const framed = padPlaintext(enc.encode("hi")); // 2 bytes content, 32-byte frame
    expect(framed.length).toBe(32);
    // bytes past the header+content are zero padding.
    for (let i = HEADER + 2; i < framed.length; i++) expect(framed[i]).toBe(0);
  });

  it('"none" policy frames without adding any padding', () => {
    const policy: PaddingPolicy = "none";
    const framed = padPlaintext(enc.encode("abc"), policy);
    expect(framed.length).toBe(HEADER + 3);
    expect(dec.decode(unpadPlaintext(framed))).toBe("abc");
  });

  it("fails closed on a frame that is too short", () => {
    expect(() => unpadPlaintext(new Uint8Array(3))).toThrow();
  });

  it("fails closed on an unknown frame version", () => {
    const framed = padPlaintext(enc.encode("abc"));
    framed[0] = 2;
    expect(() => unpadPlaintext(framed)).toThrow(/version/);
  });

  it("fails closed when the declared length overruns the buffer", () => {
    const framed = padPlaintext(enc.encode("abc"));
    framed[4] = 0xff; // declare a huge content length
    expect(() => unpadPlaintext(framed)).toThrow(/range/);
  });
});
