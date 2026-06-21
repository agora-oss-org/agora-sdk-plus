# IUC ENVELOPE Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the client-side ENVELOPE foundation primitives — blob AEAD (seal/open + descriptor-AAD), the `kind:1` IUC control-message CBOR codec, and the three `restore-blobs` REST methods + contract re-exports — so the later IUC transfer state machine can drive them.

**Architecture:** A new dependency-free-of-the-seam `core/src/restore/` module (`seal.ts` + `control.ts`) added beside `content/` + `transport/`, reusing the shipped `content/cbor.ts` (canonical CBOR) and `content/frame.ts`. Transport gains three methods on `SecureChatRestClient`; `contract/` gains three type-only re-exports from the now-published `@agora-server/contract@0.13.0`. Pure primitives — no state machine, no persistence, no hook.

**Tech Stack:** TypeScript (dual ESM/CJS), `@noble/ciphers` (XChaCha20-Poly1305), `@noble/hashes`, the in-repo CBOR codec, axios, vitest.

**Spec:** `docs/superpowers/specs/2026-06-20-iuc-envelope-foundation-design.md` (authoritative).

## Global Constraints

- **Server-blind / E2EE (CLAUDE.md §1):** only opaque ciphertext + routing ids (`conversationId`, `fromDeviceId`, `targetDeviceId`) cross the REST wire. **`K`, plaintext, the nonce, `sha256`, and the descriptor are NEVER logged, thrown-in-message, or placed in any REST field.** `K` travels only inside the MLS `restore-envelope` control message.
- **CSPRNG only:** `K` and nonces come from `crypto.getRandomValues` — never `Math.random`, never a KDF/passphrase (explicitly not the argon2id backup path).
- **Fail closed:** `openRestoreBlob` throws on any AEAD/AAD/tamper/short-input failure (never partial plaintext); `decodeIucControl` rejects unknown type / wrong arity / wrong field types / oversize (untrusted peer input); `getRestoreBlob` maps 404 → `null` (closed existence oracle — never branch on 404).
- **Canonical CBOR** (reuse `content/cbor.ts`) for the AAD descriptor and the control messages — cross-runtime byte-stable.
- **No hardcoded caps/quotas:** `413 secure-chat/restore-blob-too-large` / `429 common/rate-limited` surface as a typed `SecureRestoreError` carrying the server `code`; never assume a size/quota value.
- **Contract floor:** `@agora-server/contract` `^0.9.3 → ^0.13.0`. Type-only re-exports (erased from the dual ESM/CJS build).
- **`@noble/ciphers` pinned `^2.1.1`** added to `core` deps (matches the version already resolved via `crypto`).
- **TSDoc on every exported symbol;** `pnpm run typecheck` + `pnpm test` green per task. Co-locate `*.test.ts`. NO `Authored-By:`/`Co-Authored-By:` trailer on commits. Ignore any untracked `.claude/` dir.

## File Structure

| File | Responsibility |
|---|---|
| `packages/secure-chat/core/src/restore/seal.ts` | **New.** `generateRestoreKey` · `restoreAad` · `sealRestoreBlob` · `openRestoreBlob` + `SecureRestoreSealError`. |
| `packages/secure-chat/core/src/restore/seal.test.ts` | **New.** Round-trip, wrong-K, tamper, AAD-mismatch, blindness, fail-closed. |
| `packages/secure-chat/core/src/restore/control.ts` | **New.** `IucControlType` + message types + `encodeIucControl`/`decodeIucControl`. |
| `packages/secure-chat/core/src/restore/control.test.ts` | **New.** Round-trip each message, fail-closed decode, no-plaintext-leak. |
| `packages/secure-chat/core/src/transport/rest.ts` | **Modify.** + `uploadRestoreBlob`/`getRestoreBlob`/`deleteRestoreBlob` + `SecureRestoreError`. |
| `packages/secure-chat/core/src/transport/rest.test.ts` | **New/Modify.** Mocked-axios method tests (body shape, 404→null, typed errors). |
| `packages/secure-chat/core/src/contract/index.ts` | **Modify.** + type-only re-export `RestoreBlobModel`, `UploadRestoreBlobResponse`, `UploadRestoreBlobBody`. |
| `packages/secure-chat/core/package.json` | **Modify.** `@noble/ciphers ^2.1.1` dep; `@agora-server/contract ^0.9.3 → ^0.13.0`. |
| `packages/secure-chat/core/src/index.ts` | **Modify.** Export the restore surface. |
| `CHANGELOG.md` | **Modify.** `Added` bullets. |

**Dependency DAG:** T1 (seal) and T2 (control) are independent (both depend only on the shipped `content/`); T3 (transport+contract) is independent; T4 (exports + gate) depends on T1–T3.

---

## Task 1 — Blob AEAD (`restore/seal.ts`)

**Files:**
- Modify: `packages/secure-chat/core/package.json` (add `@noble/ciphers`)
- Create: `packages/secure-chat/core/src/restore/seal.ts`
- Test: `packages/secure-chat/core/src/restore/seal.test.ts`

**Interfaces:**
- Consumes: `encode` from `../content/cbor.js`.
- Produces: `interface RestoreDescriptor { transferId: Uint8Array; conversationId: string; fromDeviceId: string; targetDeviceId: string; chunkIndex: number; chunkCount: number }`; `class SecureRestoreSealError extends Error`; `generateRestoreKey(): Uint8Array`; `restoreAad(d: RestoreDescriptor): Uint8Array`; `sealRestoreBlob(K: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array`; `openRestoreBlob(K: Uint8Array, blob: Uint8Array, aad: Uint8Array): Uint8Array`.

- [ ] **Step 1: Add the dependency.** Edit `packages/secure-chat/core/package.json` `dependencies`, after `@noble/hashes`:

```jsonc
"@noble/ciphers": "^2.1.1",
```

Run: `pnpm install` → resolves from the workspace (already present via `crypto`).

- [ ] **Step 2: Write the failing test** — `restore/seal.test.ts`:

```ts
// Blob AEAD tests — the E2EE core of the ENVELOPE path. seal/open round-trip, and every tamper/replay
// vector (wrong key, flipped byte, mismatched AAD descriptor, short input) MUST fail closed.
import { describe, it, expect } from "vitest";
import {
  generateRestoreKey, restoreAad, sealRestoreBlob, openRestoreBlob,
  SecureRestoreSealError, type RestoreDescriptor,
} from "./seal.js";

const utf8 = (s: string) => new TextEncoder().encode(s);

function descriptor(over: Partial<RestoreDescriptor> = {}): RestoreDescriptor {
  return {
    transferId: new Uint8Array([1, 2, 3, 4]),
    conversationId: "conv-1",
    fromDeviceId: "dev-A",
    targetDeviceId: "dev-B",
    chunkIndex: 0,
    chunkCount: 1,
    ...over,
  };
}

/** True if `needle` appears as a contiguous byte subsequence of `haystack`. */
function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) return true;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

describe("restore seal: key", () => {
  it("generates a 32-byte key; two keys differ", () => {
    const a = generateRestoreKey();
    expect(a.length).toBe(32);
    expect([...a]).not.toEqual([...generateRestoreKey()]);
  });
});

describe("restore seal: round-trip + blindness", () => {
  it("seal→open returns the original plaintext under the same K + AAD", () => {
    const K = generateRestoreKey();
    const aad = restoreAad(descriptor());
    const pt = utf8("the eagle lands at midnight 💜");
    const blob = sealRestoreBlob(K, pt, aad);
    expect([...openRestoreBlob(K, blob, aad)]).toEqual([...pt]);
  });
  it("the sealed blob never contains the plaintext bytes (server-blind)", () => {
    const K = generateRestoreKey();
    const pt = utf8("the nuclear codes are 0000");
    const blob = sealRestoreBlob(K, pt, restoreAad(descriptor()));
    expect(contains(blob, pt)).toBe(false);
  });
  it("prepends a fresh 24-byte nonce → same plaintext seals to different blobs", () => {
    const K = generateRestoreKey();
    const aad = restoreAad(descriptor());
    const pt = utf8("x");
    expect([...sealRestoreBlob(K, pt, aad)]).not.toEqual([...sealRestoreBlob(K, pt, aad)]);
  });
});

describe("restore seal: fail closed", () => {
  it("wrong K → throws SecureRestoreSealError", () => {
    const aad = restoreAad(descriptor());
    const blob = sealRestoreBlob(generateRestoreKey(), utf8("hi"), aad);
    expect(() => openRestoreBlob(generateRestoreKey(), blob, aad)).toThrow(SecureRestoreSealError);
  });
  it("a single flipped ciphertext byte → throws", () => {
    const K = generateRestoreKey();
    const aad = restoreAad(descriptor());
    const blob = sealRestoreBlob(K, utf8("hi"), aad);
    blob[blob.length - 1] ^= 0x01;
    expect(() => openRestoreBlob(K, blob, aad)).toThrow(SecureRestoreSealError);
  });
  it("a mismatched AAD descriptor → throws (replay-into-another-slot defense)", () => {
    const K = generateRestoreKey();
    const blob = sealRestoreBlob(K, utf8("hi"), restoreAad(descriptor({ chunkIndex: 0 })));
    // Same transfer, different slot → AAD differs → open fails closed.
    expect(() => openRestoreBlob(K, blob, restoreAad(descriptor({ chunkIndex: 1 }))))
      .toThrow(SecureRestoreSealError);
  });
  it("a blob shorter than the nonce → throws", () => {
    expect(() => openRestoreBlob(generateRestoreKey(), new Uint8Array(8), restoreAad(descriptor())))
      .toThrow(SecureRestoreSealError);
  });
});

describe("restore seal: AAD determinism", () => {
  it("restoreAad is byte-stable for equal descriptors and differs on any field", () => {
    expect([...restoreAad(descriptor())]).toEqual([...restoreAad(descriptor())]);
    expect([...restoreAad(descriptor())]).not.toEqual([...restoreAad(descriptor({ fromDeviceId: "dev-C" }))]);
  });
});
```

- [ ] **Step 3: Run — verify it fails** (`Cannot find module './seal.js'`).

Run: `pnpm vitest run packages/secure-chat/core/src/restore/seal.test.ts`

- [ ] **Step 4: Implement `restore/seal.ts`:**

```ts
// Blob AEAD for the IUC ENVELOPE path — seal/open a history blob with XChaCha20-Poly1305.
//
// Where it sits: ABOVE the SecureChatCrypto seam (the seam is MLS group crypto; this is a generic
// byte-AEAD with an EPHEMERAL key `K` that rides MLS and is never stored). The server is a blind relay
// that cannot validate the blob, so the ONLY thing binding a blob to its intended transfer/slot is the
// AEAD AAD — we bind the full transfer descriptor (canonical CBOR) so a blob can't be replayed into a
// different transfer or chunk slot. `K`/plaintext/nonce never leave the client and are never logged.

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { encode, type CborMap } from "../content/cbor.js";

/** XChaCha20-Poly1305 extended nonce — 24 bytes, safe with random nonces. */
const NONCE_BYTES = 24;
/** XChaCha20-Poly1305 key length. */
const KEY_BYTES = 32;
/** Poly1305 tag length — the floor for a non-empty AEAD output. */
const TAG_BYTES = 16;

/** The transfer/slot a blob is cryptographically bound to (the AEAD AAD). */
export interface RestoreDescriptor {
  /** Fresh CSPRNG id binding every frame of one transfer. */
  transferId: Uint8Array;
  /** The conversation whose history is being restored. */
  conversationId: string;
  /** A's own device row id (the uploader). */
  fromDeviceId: string;
  /** B's current device row id (the recipient). */
  targetDeviceId: string;
  /** 0-based index of this chunk within the transfer. */
  chunkIndex: number;
  /** Total number of chunks in the transfer. */
  chunkCount: number;
}

/** Thrown when a blob fails to open — fail closed; the caller drops the blob. Carries no key/plaintext. */
export class SecureRestoreSealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecureRestoreSealError";
  }
}

/**
 * A full-entropy 256-bit restore key from the platform CSPRNG. Never a KDF/passphrase.
 * @returns 32 random bytes.
 */
export function generateRestoreKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

/**
 * Canonical-CBOR encoding of a {@link RestoreDescriptor} for use as the AEAD AAD. Deterministic
 * (CBOR map keyed by stable small ints, sorted by the codec), so the binding is byte-stable
 * cross-runtime and any field change yields different AAD.
 * @param d - The transfer descriptor.
 * @returns Canonical CBOR bytes.
 */
export function restoreAad(d: RestoreDescriptor): Uint8Array {
  const m: CborMap = new Map<number, unknown>([
    [0, d.transferId],
    [1, d.conversationId],
    [2, d.fromDeviceId],
    [3, d.targetDeviceId],
    [4, d.chunkIndex],
    [5, d.chunkCount],
  ]) as CborMap;
  return encode(m);
}

/**
 * Seal `plaintext` with XChaCha20-Poly1305 under `K`, binding `aad`. A fresh 24-byte CSPRNG nonce is
 * prepended to the ciphertext+tag: output = `nonce(24) || ct||tag`.
 * @param K - The 32-byte restore key (from {@link generateRestoreKey}).
 * @param plaintext - The bytes to seal (format-agnostic).
 * @param aad - The bound associated data (from {@link restoreAad}).
 * @returns The sealed blob.
 */
export function sealRestoreBlob(K: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ct = xchacha20poly1305(K, nonce, aad).encrypt(plaintext);
  const out = new Uint8Array(NONCE_BYTES + ct.length);
  out.set(nonce, 0);
  out.set(ct, NONCE_BYTES);
  return out;
}

/**
 * Open a {@link sealRestoreBlob} output. Fail closed on any auth/AAD/tamper/short-input failure.
 * @param K - The 32-byte restore key.
 * @param blob - `nonce(24) || ct||tag`.
 * @param aad - The same AAD bound at seal time (from {@link restoreAad}).
 * @returns The recovered plaintext.
 * @throws {SecureRestoreSealError} On a short blob or any AEAD verification failure.
 */
export function openRestoreBlob(K: Uint8Array, blob: Uint8Array, aad: Uint8Array): Uint8Array {
  if (blob.length < NONCE_BYTES + TAG_BYTES) {
    throw new SecureRestoreSealError("restore: blob too short");
  }
  const nonce = blob.subarray(0, NONCE_BYTES);
  const ct = blob.subarray(NONCE_BYTES);
  try {
    return xchacha20poly1305(K, nonce, aad).decrypt(ct);
  } catch {
    // Never surface the underlying error (could hint at key/plaintext); fail closed uniformly.
    throw new SecureRestoreSealError("restore: blob failed to open (fail closed)");
  }
}
```

- [ ] **Step 5: Run — verify it passes; typecheck.**

Run: `pnpm vitest run packages/secure-chat/core/src/restore/seal.test.ts` (green) and `pnpm run typecheck` (clean).

- [ ] **Step 6: Commit.**

CHANGELOG `### Added`: `IUC ENVELOPE blob AEAD (\`secure-chat-core/restore/seal\`) — XChaCha20-Poly1305 seal/open with a full-entropy CSPRNG key and the transfer descriptor bound as canonical-CBOR AAD; fail-closed.`

```bash
git add packages/secure-chat/core/package.json pnpm-lock.yaml packages/secure-chat/core/src/restore/seal.ts packages/secure-chat/core/src/restore/seal.test.ts CHANGELOG.md
git commit -m "✨ feat(secure-chat): add IUC ENVELOPE blob AEAD (seal/open)"
```

---

## Task 2 — `kind:1` IUC control codec (`restore/control.ts`)

The six transfer-envelope control messages, encoded as deterministic-CBOR tagged arrays. This codec is **payload-level**: the `[kind:1][payload]` frame wrapping is the caller's job (slice #2) via the existing `frameContent(ContentKind.IucControl, …)` / `unframe`.

**Files:**
- Create: `packages/secure-chat/core/src/restore/control.ts`
- Test: `packages/secure-chat/core/src/restore/control.test.ts`

**Interfaces:**
- Consumes: `encode`, `decode`, `type CborValue` from `../content/cbor.js`.
- Produces: `const IucControlType = { Request: 0, Offer: 1, Declined: 2, Envelope: 3, Complete: 4, Ack: 5 } as const`; a discriminated union `IucControlMessage`; `encodeIucControl(msg: IucControlMessage): Uint8Array`; `decodeIucControl(payload: Uint8Array): IucControlMessage`.

- [ ] **Step 1: Write the failing test** — `restore/control.test.ts`:

```ts
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
```

- [ ] **Step 2: Run — verify it fails.**

- [ ] **Step 3: Implement `restore/control.ts`:**

```ts
// kind:1 IUC control-message codec — the transfer-envelope messages that ride INSIDE the MIMI routing
// frame ([kind:1][payload]). This module is PAYLOAD-level: the frame wrapping (frameContent /
// ContentKind.IucControl) is the state machine's job (slice #2). Each message is a deterministic-CBOR
// tagged array `[type, …fields]`, decoded strictly + fail-closed (untrusted peer input — a peer is
// trusted to be honest, not well-formed). `K` (in restore-envelope) lives ONLY here, inside MLS; it is
// never logged or placed on the REST wire.

import { encode, decode, type CborValue } from "../content/cbor.js";

/** IUC transfer-envelope control message types (chunk/INLINE reserved for slice #2). */
export const IucControlType = {
  Request: 0,
  Offer: 1,
  Declined: 2,
  Envelope: 3,
  Complete: 4,
  Ack: 5,
} as const;
export type IucControlType = (typeof IucControlType)[keyof typeof IucControlType];

/** B asks A to send the conversation's history. */
export interface RestoreRequest { type: typeof IucControlType.Request; transferId: Uint8Array; conversationId: string }
/** A offers to send B the conversation's history. */
export interface RestoreOffer { type: typeof IucControlType.Offer; transferId: Uint8Array; conversationId: string }
/** A declines (or the user said no). */
export interface RestoreDeclined { type: typeof IucControlType.Declined; transferId: Uint8Array }
/** A points B at a sealed blob; `K` and `sha256` cross ONLY here (inside MLS). */
export interface RestoreEnvelope {
  type: typeof IucControlType.Envelope;
  transferId: Uint8Array;
  blobId: string;
  K: Uint8Array;
  count: number;
  sha256: Uint8Array;
}
/** A marks the transfer complete (integrity over the whole). */
export interface RestoreComplete { type: typeof IucControlType.Complete; transferId: Uint8Array; count: number; sha256: Uint8Array }
/** B acknowledges receipt. */
export interface RestoreAck { type: typeof IucControlType.Ack; transferId: Uint8Array; count: number }

/** The discriminated union of all IUC control messages. */
export type IucControlMessage =
  | RestoreRequest | RestoreOffer | RestoreDeclined | RestoreEnvelope | RestoreComplete | RestoreAck;

function asArray(v: CborValue): CborValue[] {
  if (!Array.isArray(v)) throw new Error("iuc control: payload is not an array");
  return v;
}
function bytes(v: CborValue, ctx: string): Uint8Array {
  if (!(v instanceof Uint8Array)) throw new Error(`iuc control: expected bytes (${ctx})`);
  return v;
}
function str(v: CborValue, ctx: string): string {
  if (typeof v !== "string") throw new Error(`iuc control: expected string (${ctx})`);
  return v;
}
function int(v: CborValue, ctx: string): number {
  if (typeof v !== "number" || !Number.isInteger(v)) throw new Error(`iuc control: expected int (${ctx})`);
  return v;
}
function arity(a: CborValue[], n: number, ctx: string): void {
  if (a.length !== n) throw new Error(`iuc control: wrong arity for ${ctx}`);
}

/**
 * Encode an IUC control message to canonical-CBOR payload bytes (no frame — the caller wraps it with
 * `frameContent(ContentKind.IucControl, …)`).
 * @param msg - The control message.
 * @returns Canonical CBOR bytes.
 */
export function encodeIucControl(msg: IucControlMessage): Uint8Array {
  switch (msg.type) {
    case IucControlType.Request:
    case IucControlType.Offer:
      return encode([msg.type, msg.transferId, msg.conversationId]);
    case IucControlType.Declined:
      return encode([msg.type, msg.transferId]);
    case IucControlType.Envelope:
      return encode([msg.type, msg.transferId, msg.blobId, msg.K, msg.count, msg.sha256]);
    case IucControlType.Complete:
      return encode([msg.type, msg.transferId, msg.count, msg.sha256]);
    case IucControlType.Ack:
      return encode([msg.type, msg.transferId, msg.count]);
  }
}

/**
 * Strict-decode a canonical-CBOR IUC control payload. Fails closed on any malformed/untrusted input.
 * @param payload - The CBOR bytes (after unframing the `[kind:1]` content frame).
 * @returns The validated {@link IucControlMessage}.
 * @throws {Error} On a non-array payload, unknown type, wrong arity, or wrong field type.
 */
export function decodeIucControl(payload: Uint8Array): IucControlMessage {
  const a = asArray(decode(payload, { maxItems: 16 }));
  const type = int(a[0], "type");
  switch (type) {
    case IucControlType.Request:
      arity(a, 3, "request");
      return { type, transferId: bytes(a[1], "transferId"), conversationId: str(a[2], "conversationId") };
    case IucControlType.Offer:
      arity(a, 3, "offer");
      return { type, transferId: bytes(a[1], "transferId"), conversationId: str(a[2], "conversationId") };
    case IucControlType.Declined:
      arity(a, 2, "declined");
      return { type, transferId: bytes(a[1], "transferId") };
    case IucControlType.Envelope:
      arity(a, 6, "envelope");
      return {
        type, transferId: bytes(a[1], "transferId"), blobId: str(a[2], "blobId"),
        K: bytes(a[3], "K"), count: int(a[4], "count"), sha256: bytes(a[5], "sha256"),
      };
    case IucControlType.Complete:
      arity(a, 4, "complete");
      return { type, transferId: bytes(a[1], "transferId"), count: int(a[2], "count"), sha256: bytes(a[3], "sha256") };
    case IucControlType.Ack:
      arity(a, 3, "ack");
      return { type, transferId: bytes(a[1], "transferId"), count: int(a[2], "count") };
    default:
      throw new Error(`iuc control: unknown message type ${type}`);
  }
}
```

- [ ] **Step 4: Run — verify it passes; typecheck; commit.**

CHANGELOG `### Added`: `kind:1 IUC control-message codec (\`secure-chat-core/restore/control\`) — canonical-CBOR encode/decode for request/offer/declined/envelope/complete/ack; strict, fail-closed.`

```bash
git add packages/secure-chat/core/src/restore/control.ts packages/secure-chat/core/src/restore/control.test.ts CHANGELOG.md
git commit -m "✨ feat(secure-chat): add kind:1 IUC control-message codec"
```

---

## Task 3 — Transport + contract (`transport/rest.ts`, `contract/index.ts`)

**Files:**
- Modify: `packages/secure-chat/core/package.json` (`@agora-server/contract` `^0.9.3 → ^0.13.0`)
- Modify: `packages/secure-chat/core/src/contract/index.ts` (re-exports)
- Modify: `packages/secure-chat/core/src/transport/rest.ts` (3 methods + `SecureRestoreError`)
- Test: `packages/secure-chat/core/src/transport/rest.test.ts`

**Interfaces:**
- Consumes: nothing from T1/T2.
- Produces: `class SecureRestoreError extends Error { code: string; status: number }`; on `SecureChatRestClient`: `uploadRestoreBlob(body: UploadRestoreBlobBody): Promise<UploadRestoreBlobResponse>`, `getRestoreBlob(blobId: string): Promise<RestoreBlobModel | null>`, `deleteRestoreBlob(blobId: string): Promise<void>`; re-exported types `RestoreBlobModel`, `UploadRestoreBlobResponse`, `UploadRestoreBlobBody`.

- [ ] **Step 1: Bump the contract dep.** Edit `packages/secure-chat/core/package.json`:

```jsonc
"@agora-server/contract": "^0.13.0",
```

Run: `pnpm install` → resolves `0.13.0`.

- [ ] **Step 2: Add the type re-exports** to `packages/secure-chat/core/src/contract/index.ts` (in the existing `export type { … } from "@agora-server/contract"` block, or a new one):

```ts
// ── IUC restore-blob (ENVELOPE) ───────────────────────────────────────────────
export type {
  RestoreBlobModel,
  UploadRestoreBlobResponse,
} from "@agora-server/contract";
// The upload body is the z.input of the contract's zod schema (type-only — erased from the build).
import type { uploadRestoreBlobSchema } from "@agora-server/contract";
import type { z } from "zod";
export type UploadRestoreBlobBody = z.input<typeof uploadRestoreBlobSchema>;
```

> If `@agora-server/contract` exports `UploadRestoreBlobBody` directly, re-export it instead and drop the
> `z.input` derivation. Confirm against the installed `0.13.0` `.d.ts` (look in
> `node_modules/.pnpm/@agora-server+contract@0.13.0/.../dist`); the guide names the exports
> `uploadRestoreBlobSchema`, `RestoreBlobModel`, `UploadRestoreBlobResponse`. `zod` is a transitive dep
> of the contract; if it is not resolvable as a direct type import, derive the body type by hand to match
> the schema: `{ conversationId: string; fromDeviceId: string; targetDeviceId: string; blob: string }`.

- [ ] **Step 3: Write the failing test** — `transport/rest.test.ts` (mock axios at the instance boundary). Mirror any existing rest test harness in the repo; if none, construct the client with stub resolvers and `vi.spyOn` its private `http`:

```ts
// REST client tests for the restore-blob endpoints — mock the axios instance; assert body shape,
// 404→null (closed existence oracle), and typed errors for 413/429.
import { describe, it, expect, vi } from "vitest";
import { SecureChatRestClient, SecureRestoreError } from "./rest.js";

function makeClient() {
  return new SecureChatRestClient({
    projectId: "p",
    getBaseUrl: () => "http://localhost:4000/v7",
    getAccessToken: () => "t",
  });
}

// Reach the private axios instance to stub per-method. (Cast through unknown — test-only.)
function http(c: SecureChatRestClient): { post: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> } {
  return (c as unknown as { http: { post: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> } }).http;
}

function axiosError(status: number, code: string) {
  return { isAxiosError: true, response: { status, data: { code } }, config: {}, message: code };
}

describe("rest: uploadRestoreBlob", () => {
  it("POSTs /restore-blobs with the body incl. fromDeviceId and returns the response", async () => {
    const c = makeClient();
    const post = vi.fn().mockResolvedValue({ data: { blobId: "b1", expiresAt: "2026-01-01T00:00:00Z" } });
    (http(c) as { post: unknown }).post = post;
    const body = { conversationId: "c1", fromDeviceId: "dev-A", targetDeviceId: "dev-B", blob: "QUJD" };
    const res = await c.uploadRestoreBlob(body);
    expect(post).toHaveBeenCalledWith("/restore-blobs", body);
    expect(res).toEqual({ blobId: "b1", expiresAt: "2026-01-01T00:00:00Z" });
  });
  it("maps 413 restore-blob-too-large to a typed SecureRestoreError", async () => {
    const c = makeClient();
    (http(c) as { post: unknown }).post = vi.fn().mockRejectedValue(axiosError(413, "secure-chat/restore-blob-too-large"));
    await expect(c.uploadRestoreBlob({ conversationId: "c1", fromDeviceId: "a", targetDeviceId: "b", blob: "x" }))
      .rejects.toMatchObject({ name: "SecureRestoreError", code: "secure-chat/restore-blob-too-large", status: 413 });
  });
  it("maps 429 rate-limited to a typed SecureRestoreError", async () => {
    const c = makeClient();
    (http(c) as { post: unknown }).post = vi.fn().mockRejectedValue(axiosError(429, "common/rate-limited"));
    await expect(c.uploadRestoreBlob({ conversationId: "c1", fromDeviceId: "a", targetDeviceId: "b", blob: "x" }))
      .rejects.toBeInstanceOf(SecureRestoreError);
  });
});

describe("rest: getRestoreBlob", () => {
  it("returns the row on 200", async () => {
    const c = makeClient();
    const row = { blobId: "b1", conversationId: "c1", fromDeviceId: "a", blob: "QUJD", createdAt: "", expiresAt: "" };
    (http(c) as { get: unknown }).get = vi.fn().mockResolvedValue({ data: row });
    expect(await c.getRestoreBlob("b1")).toEqual(row);
  });
  it("returns null on 404 (closed existence oracle)", async () => {
    const c = makeClient();
    (http(c) as { get: unknown }).get = vi.fn().mockRejectedValue(axiosError(404, "secure-chat/restore-blob-not-found"));
    expect(await c.getRestoreBlob("b1")).toBeNull();
  });
});

describe("rest: deleteRestoreBlob", () => {
  it("resolves on 204", async () => {
    const c = makeClient();
    (http(c) as { delete: unknown }).delete = vi.fn().mockResolvedValue({ status: 204 });
    await expect(c.deleteRestoreBlob("b1")).resolves.toBeUndefined();
  });
  it("resolves on 404 (idempotent)", async () => {
    const c = makeClient();
    (http(c) as { delete: unknown }).delete = vi.fn().mockRejectedValue(axiosError(404, "secure-chat/restore-blob-not-found"));
    await expect(c.deleteRestoreBlob("b1")).resolves.toBeUndefined();
  });
});
```

> **Test-harness note:** the client builds its axios instance in the constructor as `this.http`. The
> stub above overwrites `this.http.{post,get,delete}` after construction. If the repo already has a
> `rest.test.ts` with a cleaner axios-mock harness (e.g. `axios-mock-adapter` or an injected instance),
> follow that instead — keep the assertions (body shape, 404→null, typed 413/429).

- [ ] **Step 4: Implement in `transport/rest.ts`.** Add the import + error class near the top, and the three methods after the existing message/backup methods. Add to the contract-type import block: `RestoreBlobModel`, `UploadRestoreBlobResponse`, `UploadRestoreBlobBody`.

```ts
/**
 * A typed error for the restore-blob endpoints, carrying the server's stable error `code` so callers
 * branch on the code (never a parsed string). Caps/quotas are per-deployment — `413
 * secure-chat/restore-blob-too-large` is the authoritative cap signal; `429 common/rate-limited` is the
 * quota signal.
 */
export class SecureRestoreError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message?: string
  ) {
    super(message ?? code);
    this.name = "SecureRestoreError";
  }
}

/** Narrow an axios error to its `{ status, code }`, or null if it isn't one. */
function restoreErr(err: unknown): { status: number; code: string } | null {
  if (axios.isAxiosError(err) && err.response) {
    return { status: err.response.status, code: (err.response.data as { code?: string } | undefined)?.code ?? "" };
  }
  return null;
}
```

The three methods (place with the other endpoint methods):

```ts
  // ── IUC restore-blobs (ENVELOPE) ─────────────────────────────────────────────
  /**
   * Upload a sealed history blob addressed to a target device (device A). The blob is opaque
   * XChaCha20-Poly1305 ciphertext; the key `K` is NEVER sent here (it crosses MLS only).
   *
   * @param body - `{ conversationId, fromDeviceId, targetDeviceId, blob }` — `blob` is base64.
   * @returns `{ blobId, expiresAt }`.
   * @throws {SecureRestoreError} On `413 secure-chat/restore-blob-too-large` (chunk down),
   *   `429 common/rate-limited` (back off), or another typed server error.
   */
  async uploadRestoreBlob(body: UploadRestoreBlobBody): Promise<UploadRestoreBlobResponse> {
    try {
      const { data } = await this.http.post<UploadRestoreBlobResponse>("/restore-blobs", body);
      return data;
    } catch (err) {
      const e = restoreErr(err);
      if (e) throw new SecureRestoreError(e.code, e.status);
      throw err;
    }
  }

  /**
   * Fetch a sealed blob by id (device B). **Non-destructive.** Returns `null` on `404` — the server
   * returns the same 404 for missing, expired, and not-the-owner (closed existence oracle), so the
   * caller treats `null` as "nothing for me" and never branches on the reason.
   *
   * @param blobId - The blob id (learned from the MLS `restore-envelope` message).
   * @returns The blob row, or `null`.
   */
  async getRestoreBlob(blobId: string): Promise<RestoreBlobModel | null> {
    try {
      const { data } = await this.http.get<RestoreBlobModel>(`/restore-blobs/${encodeURIComponent(blobId)}`);
      return data;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) return null;
      throw err;
    }
  }

  /**
   * Delete a blob after the history is durably persisted (device B). Idempotent: a `404` resolves
   * (already gone / not ours), so a retry after a partial failure is safe.
   *
   * @param blobId - The blob id to remove.
   */
  async deleteRestoreBlob(blobId: string): Promise<void> {
    try {
      await this.http.delete(`/restore-blobs/${encodeURIComponent(blobId)}`);
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) return;
      throw err;
    }
  }
```

- [ ] **Step 5: Run — verify it passes; typecheck.**

Run: `pnpm vitest run packages/secure-chat/core/src/transport/rest.test.ts` (green) and `pnpm run typecheck` (clean — the `0.13.0` types resolve).

- [ ] **Step 6: Commit.**

CHANGELOG `### Added`: `Restore-blob REST methods (\`uploadRestoreBlob\`/\`getRestoreBlob\`/\`deleteRestoreBlob\`) + \`SecureRestoreError\`; \`@agora-server/contract\` bumped to \`^0.13.0\` with type-only re-exports of \`RestoreBlobModel\`/\`UploadRestoreBlobResponse\`/\`UploadRestoreBlobBody\`.`

```bash
git add packages/secure-chat/core/package.json pnpm-lock.yaml packages/secure-chat/core/src/contract/index.ts packages/secure-chat/core/src/transport/rest.ts packages/secure-chat/core/src/transport/rest.test.ts CHANGELOG.md
git commit -m "✨ feat(secure-chat): add restore-blob REST methods + contract@0.13.0"
```

---

## Task 4 — Public exports + final gate (`index.ts`)

**Files:**
- Modify: `packages/secure-chat/core/src/index.ts`
- Verify: `CHANGELOG.md`

- [ ] **Step 1: Add the restore surface to `core/src/index.ts`** (after the MIMI content block):

```ts
// ── IUC restore (ENVELOPE foundation) ─────────────────────────────────────────
export {
  generateRestoreKey, restoreAad, sealRestoreBlob, openRestoreBlob, SecureRestoreSealError,
} from "./restore/seal.js";
export type { RestoreDescriptor } from "./restore/seal.js";
export { encodeIucControl, decodeIucControl, IucControlType } from "./restore/control.js";
export type {
  IucControlMessage, RestoreRequest, RestoreOffer, RestoreDeclined, RestoreEnvelope, RestoreComplete, RestoreAck,
} from "./restore/control.js";
export { SecureRestoreError } from "./transport/rest.js";
export type { RestoreBlobModel, UploadRestoreBlobResponse, UploadRestoreBlobBody } from "./contract/index.js";
```

> Verify each name against its source module. `RestoreBlobModel`/`UploadRestoreBlobResponse`/`UploadRestoreBlobBody`
> flow through `./contract/index.js` (Task 3); the others from `./restore/*`.

- [ ] **Step 2: CHANGELOG consolidation** — ensure `## [Unreleased]` reads cleanly (one bullet per concept across Tasks 1–3; formatting only).

- [ ] **Step 3: Final gate.**

```bash
pnpm run typecheck   # clean
pnpm test            # green — restore/seal, restore/control, transport/rest + whole suite
pnpm run build-all   # clean dual ESM/CJS (core picks up restore/ + @noble/ciphers; react-js ESM-only)
```

- [ ] **Step 4: Commit.**

```bash
git add packages/secure-chat/core/src/index.ts CHANGELOG.md
git commit -m "📝 docs(secure-chat): export the IUC ENVELOPE foundation surface"
```

---

## Verification (end-to-end)

1. **`pnpm run typecheck`** — clean: `restore/` compiles, `0.13.0` contract types resolve, exports valid.
2. **`pnpm test`** — green. Spot-confirm the security-load-bearing cases:
   - **seal:** `seal→open` round-trip; wrong-K / flipped-byte / **mismatched-AAD-descriptor** all throw; the blob never contains the plaintext.
   - **control:** all six messages round-trip; `restore-envelope` preserves `K`/`sha256`; fail-closed decode (unknown type, wrong arity/type, truncated).
   - **transport:** body carries `fromDeviceId`; `getRestoreBlob` 404 → null; `413`/`429` → typed `SecureRestoreError`; **no test path puts `K` in a REST body.**
3. **`pnpm run build-all`** — clean dual ESM/CJS for core; react-js ESM-only.
4. No server/e2e run — pure client primitives; the live transport is exercised when slice #2's state machine lands.

## Self-Review (run before handoff)

**Spec coverage:** seal/key/AAD → T1; control codec (6 msgs) → T2; transport (3 methods + contract bump + re-exports + typed error) → T3; exports + gate → T4. Every spec component maps to a task.

**Placeholder scan:** the only flagged-uncertainty spots are T3's contract-export shape (with a concrete fallback: derive `{ conversationId, fromDeviceId, targetDeviceId, blob }` by hand) and the rest-test harness (mirror an existing one if present) — both name exactly what to do; no silent gaps.

**Type consistency:** names are stable across tasks — `RestoreDescriptor`, `SecureRestoreSealError`, `generateRestoreKey`/`restoreAad`/`sealRestoreBlob`/`openRestoreBlob`; `IucControlType`/`IucControlMessage`/`encodeIucControl`/`decodeIucControl`; `SecureRestoreError`; `RestoreBlobModel`/`UploadRestoreBlobResponse`/`UploadRestoreBlobBody`; `uploadRestoreBlob`/`getRestoreBlob`/`deleteRestoreBlob`.

## Out of scope (later slices)

The A↔B transfer state machine, INLINE `restore-chunk` + history-row schema, chunking/drain, dedup, resume markers, persistence, the SAS gate (Act I), and the `useSecureRestore` hook — all per the spec's "Out of scope."
