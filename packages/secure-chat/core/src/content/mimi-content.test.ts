// MimiContent codec tests — round-trip Tier-2 (text / reply / edit / delete) and representative Tier-3
// (multipart + external attachment / expiry) shapes against the draft-ietf-mimi-content-08 wire layout,
// contentHash = 32-byte MessageId (leading 0x01) stability/salt-sensitivity, and schema-validation
// rejections (fail closed).
import { describe, it, expect } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { encode } from "./cbor.js";
import {
  encodeMimiContent, decodeMimiContent, contentHash,
  Cardinality, Disposition, HashAlg, PartSemantics, type MimiContent,
} from "./mimi-content.js";

const utf8 = (s: string) => new TextEncoder().encode(s);

/** A plain text post (single render part) — the Tier-2 baseline. */
function textPost(body: string): MimiContent {
  return {
    salt: new Uint8Array(16),
    replaces: null,
    topicId: new Uint8Array(),
    expires: null,
    inReplyTo: null,
    extensions: new Map(),
    nestedPart: {
      cardinality: Cardinality.Single,
      disposition: Disposition.Render,
      language: "",
      contentType: "text/markdown",
      content: utf8(body),
    },
  };
}

describe("mimi-content: round-trip", () => {
  it("round-trips a text post (bytes are stable)", () => {
    const c = textPost("hello 💜");
    const bytes = encodeMimiContent(c);
    const back = decodeMimiContent(bytes);
    expect(back).toEqual(c);
    expect([...encodeMimiContent(back)]).toEqual([...bytes]); // canonical & stable
  });

  it("round-trips a reply (inReplyTo = a 32-byte MessageId)", () => {
    const c = textPost("re: hi");
    c.inReplyTo = new Uint8Array(32).fill(3);
    expect(decodeMimiContent(encodeMimiContent(c))).toEqual(c);
  });

  it("round-trips a reaction (disposition = Reaction)", () => {
    const c = textPost("👍");
    (c.nestedPart as { disposition: number }).disposition = Disposition.Reaction;
    c.inReplyTo = new Uint8Array(32).fill(7); // a reaction targets a message
    const back = decodeMimiContent(encodeMimiContent(c));
    expect(back).toEqual(c);
    expect(back.nestedPart.cardinality).toBe(Cardinality.Single);
    expect((back.nestedPart as { disposition: number }).disposition).toBe(Disposition.Reaction);
  });

  it("round-trips an edit (replaces set)", () => {
    const c = textPost("fixed typo");
    c.replaces = new Uint8Array(32).fill(9);
    expect(decodeMimiContent(encodeMimiContent(c))).toEqual(c);
  });

  it("round-trips a delete (NullPart + replaces)", () => {
    const c = textPost("");
    c.replaces = new Uint8Array(32).fill(1);
    c.nestedPart = { cardinality: Cardinality.Null, disposition: Disposition.Render, language: "" };
    expect(decodeMimiContent(encodeMimiContent(c))).toEqual(c);
  });

  it("round-trips an Expiration directive", () => {
    const c = textPost("self-destructs");
    c.expires = { relative: true, time: 3600 };
    expect(decodeMimiContent(encodeMimiContent(c))).toEqual(c);
  });

  it("round-trips a Tier-3 multipart with an external attachment (encoded, even if unsurfaced)", () => {
    const c = textPost("see file");
    c.nestedPart = {
      cardinality: Cardinality.Multi,
      disposition: Disposition.Render,
      language: "",
      partSemantics: PartSemantics.ProcessAll,
      parts: [
        { cardinality: Cardinality.Single, disposition: Disposition.Render, language: "", contentType: "text/markdown", content: utf8("see file") },
        { cardinality: Cardinality.External, disposition: Disposition.Attachment, language: "", contentType: "image/png", url: "https://x/y", expires: 0, size: 1024, encAlgorithm: 1, key: new Uint8Array(32), nonce: new Uint8Array(12), aad: new Uint8Array(), hashAlgorithm: HashAlg.Sha256, contentHash: new Uint8Array(32), description: "", filename: "y.png" },
      ],
    };
    expect(decodeMimiContent(encodeMimiContent(c))).toEqual(c);
  });
});

describe("mimi-content: contentHash", () => {
  it("is a 32-byte MessageId (leading 0x01 SHA-256 tag) and stable for equal content", () => {
    const a = contentHash(textPost("x"));
    const b = contentHash(textPost("x"));
    expect(a.length).toBe(32);
    expect(a[0]).toBe(0x01); // MessageId hashAlg prefix = SHA-256
    expect([...a]).toEqual([...b]);
  });
  it("its tail equals the first 31 bytes of sha256(canonical CBOR)", () => {
    const c = textPost("x");
    const digest = sha256(encodeMimiContent(c));
    const id = contentHash(c);
    expect([...id.subarray(1)]).toEqual([...digest.subarray(0, 31)]);
  });
  it("changes when the body changes", () => {
    expect([...contentHash(textPost("x"))]).not.toEqual([...contentHash(textPost("y"))]);
  });
  it("changes when salt changes (unlinkability)", () => {
    const a = textPost("x");
    const b = textPost("x");
    b.salt = new Uint8Array(16).fill(7);
    expect([...contentHash(a)]).not.toEqual([...contentHash(b)]);
  });
});

describe("mimi-content: schema validation (fail closed)", () => {
  it("rejects an unknown cardinality tag", () => {
    // Hand-craft a structurally-valid NestedPart wrapper [disposition, language, cardinality, …] whose
    // cardinality is out of range (9). The cbor layer accepts it (well-formed array of ints/strings/
    // bytes); the MimiContent decoder must reject it on the unknown-cardinality check.
    const badNestedPart = [Disposition.Render, "", 9, "text/markdown", utf8("x")];
    const bad = encode([
      new Uint8Array(16), // salt
      null,               // replaces
      new Uint8Array(),   // topicId
      null,               // expires
      null,               // inReplyTo
      new Map(),          // extensions
      badNestedPart,      // nestedPart with cardinality 9
    ] as never);
    expect(() => decodeMimiContent(bad)).toThrow(/cardinality/i);
  });

  it("rejects a non-array nestedPart", () => {
    const bad = encode([
      new Uint8Array(16), null, new Uint8Array(), null, null, new Map(),
      "not-a-part", // nestedPart is a string, not an array
    ] as never);
    expect(() => decodeMimiContent(bad)).toThrow(/array|part/i);
  });

  it("rejects the wrong top-level arity", () => {
    // An 8-element array (the pre-draft modeled shape) must be rejected — draft-08 has exactly 7.
    const bad = encode([
      new Uint8Array(16), null, new Uint8Array(), null, null, [], new Map(),
      [Disposition.Render, "", Cardinality.Null],
    ] as never);
    expect(() => decodeMimiContent(bad)).toThrow(/arity|MimiContent/i);
  });

  it("rejects an over-long part array (trailing junk not silently dropped)", () => {
    // A SinglePart's wire array is exactly 5: [disposition, language, cardinality, contentType, content].
    // Append a spurious 6th element; decodePart must reject the wrong arity rather than ignore it.
    const overLongPart = [Disposition.Render, "", Cardinality.Single, "text/markdown", utf8("x"), 999];
    const bad = encode([
      new Uint8Array(16), null, new Uint8Array(), null, null, new Map(), overLongPart,
    ] as never);
    expect(() => decodeMimiContent(bad)).toThrow(/wrong arity for cardinality/i);
  });

  it("rejects a non-array top-level", () => {
    expect(() => decodeMimiContent(encode("not-mimi"))).toThrow(/MimiContent|schema|array/i);
  });

  it("rejects a non-array byte string at top level", () => {
    expect(() => decodeMimiContent(new Uint8Array([0x00]))).toThrow(); // int 0 → not an array → rejected
  });

  it("rejects a degenerate multipart with fewer than 2 parts", () => {
    const oneChild = [
      Disposition.Render, "", Cardinality.Multi, PartSemantics.ProcessAll,
      [[Disposition.Render, "", Cardinality.Single, "text/markdown", utf8("only")]],
    ];
    const bad = encode([
      new Uint8Array(16), null, new Uint8Array(), null, null, new Map(), oneChild,
    ] as never);
    expect(() => decodeMimiContent(bad)).toThrow(/2\+ parts|multipart/i);
  });

  it("enforces the maxParts bound", () => {
    const c = textPost("x");
    const child = (): MimiContent["nestedPart"] => ({
      cardinality: Cardinality.Single, disposition: Disposition.Render, language: "", contentType: "text/plain", content: utf8("p"),
    });
    c.nestedPart = {
      cardinality: Cardinality.Multi,
      disposition: Disposition.Render,
      language: "",
      partSemantics: PartSemantics.ProcessAll,
      parts: Array.from({ length: 65 }, child), // maxParts = 64
    };
    expect(() => decodeMimiContent(encodeMimiContent(c))).toThrow(/bounds|too many parts/i);
  });
});
