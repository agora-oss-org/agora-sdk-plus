# IUC ENVELOPE foundation — SDK client primitives

**Status:** approved design — ready for an implementation plan
**Date:** 2026-06-20
**Scope:** The **first slice** of the SDK-side IUC history-restore work — the *foundation primitives* for
the **ENVELOPE** variant: the blob AEAD (seal/open), the transfer-descriptor AAD canonicalizer, the
`kind:1` IUC control-message CBOR codec (envelope-relevant messages), the three `restore-blobs` REST
methods, and the contract type re-exports. **Client-only**; the server stays blind (only opaque
ciphertext + routing ids cross the wire). This slice is **pure primitives** — no A↔B state machine, no
SAS gate, no persistence, no hook (those are later slices).

**Authoritative inputs:**
- Settled server contract: `docs/cross-repo/2026-06-20-iuc-restore-blob-implementation-guide.md`
- Feature design (full IUC): `docs/superpowers/specs/2026-06-18-iuc-history-restore-design.md`
- Reuses the just-shipped MIMI content codec: `docs/superpowers/specs/2026-06-20-mimi-cbor-content-design.md`

## Goal

When a re-provisioned device **B** re-joins a conversation, MLS forward secrecy lets it read future
messages but **nothing** from before. The ENVELOPE recovery path has peer **A** seal the back-history
into one opaque AEAD blob, upload it to the blind server's `restore-blobs` relay, and send only the
decryption key `K` to B **over MLS**. This slice builds the **reusable client primitives** that the
later transfer state machine drives:

1. **Blob AEAD** — generate a full-entropy `K`, seal/open history bytes with XChaCha20-Poly1305, binding
   the transfer descriptor as AAD so a blob can't be replayed into a different transfer/slot.
2. **`kind:1` IUC control codec** — encode/decode the transfer-envelope control messages that ride
   inside the MIMI routing frame (`[kind:1][payload]`), most importantly `restore-envelope`, which
   carries `K` **only over MLS**.
3. **Transport** — the three `restore-blobs` REST methods + the contract type re-exports.

## Decisions (from brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Slice scope | **ENVELOPE foundation only** (primitives) | IUC restore is multi-subsystem; this is the unblocked, self-contained, security-critical base everything else builds on. |
| Module placement | A new **`core/src/restore/`** module; `@noble/ciphers` added to `core` deps | The blob AEAD is a generic byte-AEAD with an ephemeral `K` — **not** MLS group crypto and not state-aware, so it does NOT belong behind the `SecureChatCrypto` seam (unlike the state-aware passphrase backup). Identical on every platform → no DI benefit. Lives beside `transport/` + `content/`. |
| Canonical form | **Deterministic CBOR** (reuse `content/cbor.ts`) for the AAD descriptor and the control messages | Cross-runtime byte-stable, closes the old canonicalization Known-Issue #12 by construction, consistent with MIMI. |
| Control-codec scope | **Framework + the six transfer-envelope messages** (request/offer/declined/envelope/complete/ack); defer INLINE `restore-chunk` | `restore-chunk` embeds the history-row schema, an Act-II content decision (slice #2). The six envelope-flow messages are tiny descriptors and pair the K-carrying `restore-envelope` with the seal. |
| Existence oracle | `getRestoreBlob` maps **404 → `null`**; `deleteRestoreBlob` treats 404 as success | The server returns one 404 for missing/expired/not-owner. Callers treat "nothing for me" uniformly and never branch on 404. |
| Caps/quotas | **Never hardcoded**; `413`/`429` surface as a typed error with the contract code | Limits are per-deployment; `413 secure-chat/restore-blob-too-large` is the authoritative cap signal for slice #2's chunk decision. |

## Architecture & module layout

```
packages/secure-chat/core/src/
  restore/
    seal.ts        blob AEAD + key + AAD canonicalizer
    seal.test.ts
    control.ts     kind:1 IUC control-message codec (envelope-relevant)
    control.test.ts
  transport/rest.ts        + uploadRestoreBlob / getRestoreBlob / deleteRestoreBlob (+ SecureRestoreError)
  contract/index.ts        + type-only re-exports (RestoreBlobModel, UploadRestoreBlobResponse, UploadRestoreBlobBody)
  index.ts                 + public exports for the restore surface
packages/secure-chat/core/package.json   @noble/ciphers ^2.1.1 (dep); @agora-server/contract ^0.9.3 → ^0.13.0
```

`restore/` sits **above** the `SecureChatCrypto` seam (the seam is unchanged) and reuses `content/cbor.ts`
(canonical CBOR) and `util/base64.ts` (wire boundary). It depends on `@noble/ciphers` (XChaCha20-Poly1305)
and `@noble/hashes` (already a core dep from MIMI) for the optional integrity `sha256`.

## Component 1 — blob AEAD (`restore/seal.ts`)

The E2EE core. All functions are pure over bytes; `K`/plaintext/nonce never leave the client and are
never logged or serialized.

- `generateRestoreKey(): Uint8Array` — a **256-bit full-entropy** key from `crypto.getRandomValues`
  (CSPRNG). **Never** a KDF/passphrase — explicitly not the argon2id backup path.
- `interface RestoreDescriptor { transferId: Uint8Array; conversationId: string; fromDeviceId: string;
  targetDeviceId: string; chunkIndex: number; chunkCount: number }`.
- `restoreAad(descriptor: RestoreDescriptor): Uint8Array` — canonical **CBOR** of the descriptor
  (deterministic field order via a CBOR map keyed by stable small ints). This is the AEAD AAD, so a
  sealed blob is cryptographically bound to its exact `(transfer, slot)` and cannot be replayed
  elsewhere.
- `sealRestoreBlob(K: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array` —
  XChaCha20-Poly1305. A fresh 24-byte CSPRNG nonce is prepended to the ciphertext+tag: output =
  `nonce(24) || ct||tag`. Format-agnostic over `plaintext` (the history payload shape is slice #2's).
- `openRestoreBlob(K: Uint8Array, blob: Uint8Array, aad: Uint8Array): Uint8Array` — splits the nonce,
  AEAD-opens with the AAD, returns plaintext. **Fail closed:** throws `SecureRestoreSealError` on any
  auth/AAD/tamper/short-input failure; never returns partial or guessed plaintext.

> **Why AAD = the descriptor:** the server is blind and cannot validate the blob; the only thing binding
> a blob to its intended transfer/slot is the AEAD AAD. Binding the full descriptor stops a malicious or
> buggy relay from splicing blob *i* of transfer *X* into slot *j* of transfer *Y* — `open` fails closed.

## Component 2 — `kind:1` IUC control codec (`restore/control.ts`)

The transfer's control messages are MLS application messages framed with the MIMI routing byte
(`frameContent(ContentKind.IucControl=1, payload)`), with `payload` a deterministic-CBOR tagged union.

- `const IucControlType = { Request: 0, Offer: 1, Declined: 2, Envelope: 3, Complete: 4, Ack: 5 } as const`
  (chunk/INLINE = reserved, deferred to slice #2).
- Each message encodes as a CBOR array `[type, …fields]`. The typed shapes:
  - `RestoreRequest { transferId, conversationId }`
  - `RestoreOffer { transferId, conversationId }`
  - `RestoreDeclined { transferId }`
  - `RestoreEnvelope { transferId, blobId, K, count, sha256 }` — **`K` (bytes) and `sha256` (bytes)
    travel ONLY here, inside MLS.**
  - `RestoreComplete { transferId, count, sha256 }`
  - `RestoreAck { transferId, count }`
- `encodeIucControl(msg): Uint8Array` and `decodeIucControl(bytes): IucControlMessage` (a discriminated
  union). Decode is **strict + bounded + fail-closed** (untrusted peer input): unknown `type`, wrong
  arity, wrong field types, and oversize all throw; never partial.
- `transferId` is a fresh CSPRNG id (bytes) the state machine binds to every frame of a transfer.

> This slice defines the codec + the six message *shapes*; **sending/receiving/sequencing them is slice
> #2** (the state machine). Nothing here calls the transport or the crypto seam.

## Component 3 — transport + contract (`transport/rest.ts`, `contract/index.ts`)

- **Contract:** bump `@agora-server/contract` `^0.9.3 → ^0.13.0`; type-only re-export `RestoreBlobModel`,
  `UploadRestoreBlobResponse`, `UploadRestoreBlobBody` (the `z.input` of `uploadRestoreBlobSchema`:
  `{ conversationId, fromDeviceId, targetDeviceId, blob }`) from `core/src/contract/index.ts` — same
  erased-at-build type-only pattern as the existing secure-chat re-exports.
- **REST methods** on `SecureChatRestClient`, under `{baseUrl}/{projectId}/secure-chat`, base64 at the
  boundary:
  - `uploadRestoreBlob(body: UploadRestoreBlobBody): Promise<UploadRestoreBlobResponse>` — `POST /restore-blobs`.
  - `getRestoreBlob(blobId: string): Promise<RestoreBlobModel | null>` — `GET`; **404 → `null`** (closed
    existence oracle; callers never branch on 404).
  - `deleteRestoreBlob(blobId: string): Promise<void>` — `DELETE`; 404 resolves (idempotent).
  - `fromDeviceId` is a **required** upload field (the user-scoped token can't identify the sender
    device); set exactly as `senderDeviceId` is on message send.

## Error handling (fail closed)

- `class SecureRestoreError extends Error { code: string; status: number }` — carries the server's
  stable error code. `uploadRestoreBlob` maps `413 secure-chat/restore-blob-too-large` and
  `429 common/rate-limited` (and `403 secure-chat/not-a-member`, `404 secure-chat/device-not-found` /
  `restore-target-not-member`) to a typed `SecureRestoreError` so slice #2 branches on `code`, never on
  a parsed string. Caps/quotas are **never hardcoded**.
- `class SecureRestoreSealError extends Error` — `openRestoreBlob` throws it on any AEAD/AAD/tamper
  failure; the caller drops the blob. Never partial plaintext.
- **Never** log/throw-in-message/serialize: `K`, plaintext, the nonce, `sha256`, or the descriptor.
  Audit `console.*`, error messages, and request bodies — `K` must never appear in any REST field.

## Testing strategy (vitest, fully mocked — server-free)

- **Seal (`seal.test.ts`):** `seal→open` round-trip; wrong-`K` → throws; single flipped ciphertext byte
  → throws; **mismatched-AAD descriptor → throws** (the replay-into-another-slot defense); `K` is 32
  bytes and two generated keys differ; the sealed blob never contains the plaintext as a byte
  subsequence — nor the descriptor routing strings (`conversationId`/`fromDeviceId`), since the AAD is
  bound, not embedded (blindness); a too-short blob fails closed.
- **Control codec (`control.test.ts`):** round-trip each of the six messages; `restore-envelope`
  round-trips `K`/`blobId`/`count`/`sha256` faithfully; **fail-closed decode** — unknown `type`,
  truncated input, wrong arity/types, oversize all throw; an encoded `restore-envelope` is verified to
  contain no plaintext.
- **Transport (mock the axios/rest boundary):** `uploadRestoreBlob` sends the exact body incl.
  `fromDeviceId` and base64 `blob`; `getRestoreBlob` 404 → `null`, 200 → `RestoreBlobModel`;
  `deleteRestoreBlob` 404 → resolves; `413`/`429` → typed `SecureRestoreError` with the right `code`.
  **Cross-check: no test path puts `K` in a REST request body** (server-blindness analog).

## Slice #2 hand-off — reconstructing the AAD on the open side (settled)

The seal binds the **6-field `RestoreDescriptor`** as AAD, but the `RestoreEnvelope` control message
deliberately carries only `{ transferId, blobId, K, count, sha256 }`. The descriptor is **not** sent on
the wire (it's authenticated, not embedded — confirmed by the blindness tests). So slice #2's state
machine MUST reconstruct the exact descriptor on B's side from context. Field provenance:

| Descriptor field | Where B sources it when opening |
|---|---|
| `transferId` | the `RestoreEnvelope` message |
| `conversationId` | the enclosing MLS conversation the control message arrived on |
| `fromDeviceId` | **`RestoreBlobModel.fromDeviceId`** on the `getRestoreBlob` response (A's uploader device) |
| `targetDeviceId` | B's own current device row id |
| `chunkIndex` | `0` for the single-blob foundation (the chunk index when INLINE chunking lands) |
| `chunkCount` | `1` for the single-blob foundation (total blob chunks) |

> **Naming trap — `count` ≠ `chunkCount`.** The descriptor's **`chunkCount`** is the number of sealed
> **blob chunks** (the AEAD slot dimension). The control messages' **`count`** (in `Envelope`/`Complete`/
> `Ack`) is the number of **history rows** in the transfer — the application/integrity quantity paired
> with the running `sha256`. They are **distinct** and slice #2 must **not** conflate them: a blob's AAD
> uses `chunkIndex`/`chunkCount`; the transfer's completeness/integrity uses `count`/`sha256`. Getting
> this wrong yields blobs that fail closed on open (safe, but a silent functional break).

## Out of scope (later slices)

- **#2 state machine (Act II):** the A↔B transfer orchestration, INLINE `restore-chunk` + history-row
  schema, chunking / drain-as-you-go, dedup-by-messageId, resume markers, persistence integration.
- **#3 Act I + SAS gate:** re-join/empty-store detection, SAS derivation (reuses the shipped
  `exportSecret`), consent UX, the "no payload before SAS" M3 hard gate.
- **#4 hook/UX:** `useSecureRestore`, triggers, progress.
- The optional `secure:restore-blob-available` realtime nudge (a latency nicety; slice #2 may wire it).

## Relationship to existing architecture

- **Adds** a dependency-free-of-the-seam `restore/` module beside `content/` + `transport/`; **reuses**
  `content/cbor.ts` (canonical CBOR) and the `[kind:1]` frame from the MIMI work unchanged.
- **Extends** `SecureChatRestClient` with three methods and `contract/` with three type re-exports;
  bumps the contract dep to `^0.13.0` (now published).
- **Provides** the primitives the IUC transfer state machine (slice #2) will drive — keeping that slice
  free of crypto/transport/encoding details.
