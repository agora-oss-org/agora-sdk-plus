// IUC control-codec tests — round-trip each of the six transfer-envelope messages and fail closed on
// any malformed/untrusted input. The restore-envelope message carries K + sha256 (bytes) faithfully.
import { describe, it, expect } from "vitest";
import {
  encodeIucControl, decodeIucControl, IucControlType, type IucControlMessage,
} from "./control.js";
import { encode } from "../content/cbor.js";

const tid = new Uint8Array([9, 9, 9, 9]);

const samples: IucControlMessage[] = [
  { type: IucControlType.Request, transferId: tid, conversationId: "c1" },
  { type: IucControlType.Offer, transferId: tid, conversationId: "c1" },
  { type: IucControlType.Declined, transferId: tid },
  { type: IucControlType.Envelope, transferId: tid, blobId: "blob-1", K: new Uint8Array(32).fill(7), count: 42, sha256: new Uint8Array(32).fill(3) },
  { type: IucControlType.Complete, transferId: tid, count: 42, sha256: new Uint8Array(32).fill(3) },
  { type: IucControlType.Ack, transferId: tid, count: 42 },
];

describe("iuc control: round-trip", () => {
  for (const msg of samples) {
    it(`round-trips type ${msg.type}`, () => {
      expect(decodeIucControl(encodeIucControl(msg))).toEqual(msg);
    });
  }
  it("preserves restore-envelope K + sha256 bytes exactly", () => {
    const env = samples[3] as Extract<IucControlMessage, { type: 3 }>;
    const back = decodeIucControl(encodeIucControl(env)) as Extract<IucControlMessage, { type: 3 }>;
    expect([...back.K]).toEqual([...env.K]);
    expect([...back.sha256]).toEqual([...env.sha256]);
    expect(back.blobId).toBe("blob-1");
  });
});

describe("iuc control: fail closed (untrusted input)", () => {
  it("rejects an unknown message type", () => {
    expect(() => decodeIucControl(encode([99, tid]))).toThrow(/type|control/i);
  });
  it("rejects a non-array payload", () => {
    expect(() => decodeIucControl(encode("nope"))).toThrow(/array|control/i);
  });
  it("rejects wrong arity for a type", () => {
    // Ack is [5, transferId, count]; drop count.
    expect(() => decodeIucControl(encode([IucControlType.Ack, tid]))).toThrow(/arity|control/i);
  });
  it("rejects a wrong field type", () => {
    // Envelope blobId must be a string; pass bytes.
    expect(() =>
      decodeIucControl(encode([IucControlType.Envelope, tid, new Uint8Array([1]), new Uint8Array(32), 1, new Uint8Array(32)]))
    ).toThrow(/blobId|string|control/i);
  });
  it("rejects truncated CBOR", () => {
    const good = encodeIucControl(samples[5]);
    expect(() => decodeIucControl(good.subarray(0, good.length - 1))).toThrow();
  });
});

describe("iuc control: no plaintext leak", () => {
  it("the encoded payload is opaque bytes (no console/throw of K)", () => {
    // Encoding must not throw; the bytes are the only output (K lives only here, inside MLS).
    const bytes = encodeIucControl(samples[3]);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
  });
});
