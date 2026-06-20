# Request for functionality — IUC restore-blob endpoint (agora-server)

**To:** agora-server team (owner of the blind Delivery Service + `@agora-server/contract`)
**From:** agora-sdk-plus (secure-chat)
**Date:** 2026-06-20
**Status:** ✅ **ANSWERED (2026-06-20)** — the server team settled every `[SERVER DECISION]`. The
delivered contract is **`docs/cross-repo/2026-06-20-iuc-restore-blob-implementation-guide.md`** (this
repo). Read that for the authoritative shape; this request is kept for provenance. Notable deltas from
the sketch below: auth is **user-scoped** (caller owns `targetDeviceId`), `fromDeviceId` is a **required**
upload field, too-large is **413 + code `secure-chat/restore-blob-too-large`** (not 400), chunking is
**client-side / single-blob server**, and lifecycle is **explicit DELETE + TTL backstop** (our
recommended option). The settled facts are folded into the IUC spec's ENVELOPE section.
**Depends on / relates to:** `docs/superpowers/specs/2026-06-18-iuc-history-restore-design.md` (the IUC feature; ENVELOPE variant)

---

## One-paragraph summary

IUC ("history restore on a re-provisioned device") lets a reinstalled device **B** recover the
plaintext back-history of a conversation it has re-joined, handed over by a peer device **A** that still
holds it. Small histories ride MLS application messages directly (the **INLINE** variant — no server
change, already coverable by the existing relay). Large histories use the **ENVELOPE** variant: A seals
the history into one opaque AEAD blob, uploads it to the server, and sends **only the decryption key**
over MLS. For that we need a new server capability: **a targeted, ephemeral, opaque blob relay** — A
uploads a blob addressed to B; only B can fetch it; it is consumed once and then deleted. The server
stores **opaque bytes** and learns **no plaintext and no key** — same blindness it already has for
KeyPackages, Welcomes, and ciphertext.

This doc specifies what the SDK needs and proposes a contract; the **storage, lifecycle mechanism, TTL,
size caps, and rate-limiting are the server team's design call.** Decisions we'd like back from you are
flagged **[SERVER DECISION]**.

## Why a server endpoint at all (and why not just MLS)

Forward secrecy means B, after re-joining, can read *future* messages but **nothing** from before — the
old application-message keys were single-use and deleted. The only way B recovers its past is for A to
hand over the **plaintext** it decrypted-once-and-stored. INLINE sends that over MLS app-messages, which
is fine for small histories but pathological for large ones: thousands of MLS messages, each individually
encrypted/authenticated/relayed, each burning a generation in A's secret-tree ratchet, each fanned out
to **every** group member. ENVELOPE moves the bulk **off** the MLS channel into one opaque blob and sends
only a tiny key message over MLS. The blob endpoint is the missing piece.

## Hard requirements (non-negotiable — these preserve E2EE)

1. **Server stays blind.** The blob is `XChaCha20-Poly1305(K, history)` sealed **client-side**. The
   server stores/relays it as opaque base64 and **must never** receive, log, or be able to derive the
   key `K` or the plaintext. `K` travels **only** over MLS (A→B inside the group) and never touches this
   endpoint or any server field.
2. **Targeted delivery.** A blob is addressed to exactly one recipient device B (`targetDeviceId`). Only
   the authenticated device matching `targetDeviceId` may fetch or delete it. No one else — not other
   group members, not A after upload — may read it.
3. **Ephemeral.** The blob is consumed once and removed promptly (see lifecycle). It is **not** durable
   storage; it is a courier drop-box.
4. **Membership-scoped.** Both A (uploader) and B (target) must be **current members of
   `conversationId`** at upload time. The server already owns group membership, so it can enforce this;
   it stops a device from dumping blobs at arbitrary unrelated devices.
5. **Bounded.** A maximum blob size is enforced and oversize uploads are rejected (the SDK will chunk or
   fall back to INLINE rather than exceed it).

**Metadata the server will see (and that it already effectively has):** uploader deviceId, target
deviceId, conversationId, blob byte-size, timestamps. The server already relays the Commit/Welcome that
added B to the conversation, so "A is couriering something to B for conversation X" is **not new**
knowledge. The only genuinely new observable is **blob size + timing**, which is inherent to any
store-and-forward of bulk data and is acceptable.

## Functional behavior

### Upload (device A)
- A, an authenticated current member of `conversationId`, POSTs `{ conversationId, targetDeviceId, blob }`
  where `blob` is opaque base64.
- Server validates: caller is a member of `conversationId`; `targetDeviceId` is **also** a current member
  of `conversationId`; `blob` ≤ max size. On success it stores the blob and returns a `blobId` + `expiresAt`.
- A then sends `iuc/restore-envelope { transferId, blobId, K, count, sha256 }` over MLS (the SDK's job —
  the server never sees this).

### Fetch (device B)
- B, authenticated and matching `targetDeviceId`, GETs the blob by `blobId`. Any other caller → **404**
  (prefer 404 over 403 so the endpoint doesn't confirm a blob's existence to non-recipients).
- The GET is **non-destructive** (B may need to retry if it crashes between fetch and persist).

### Delete / lifecycle  **[SERVER DECISION]**
The server cannot see the MLS ack that tells A "B got it" — so deletion must hinge on a **server-visible**
event. We recommend, but defer to you:

- **Recommended — explicit DELETE + short TTL backstop.** B fetches (GET), decrypts, persists to its
  local store, **then** calls authenticated `DELETE /restore-blobs/:blobId`. A short TTL
  (**[SERVER DECISION]**, suggest ~1h) sweeps anything B never confirms. This is **resume-safe** (B can
  re-GET on a mid-restore crash) and keeps the at-rest window to seconds after success.
- Alternative — **consume-on-read**: the server deletes on B's first successful GET. Smallest surface,
  tightest window, but a fetch-then-crash forces A to re-upload.
- Alternative — **TTL-only**: simplest, worst hygiene (blob lingers the full TTL after a clean restore).

We'd take the recommended option; your call given your storage/ops constraints.

## Proposed contract (illustrative — final shape is yours)

Scoped under the existing secure-chat base (`{baseUrl}/{projectId}/secure-chat`), consistent with the
current device/handshake/message/key-backup endpoints.

```http
POST   /restore-blobs
  body:  { conversationId: string, targetDeviceId: string, blob: string /* base64 */ }
  200:   { blobId: string, expiresAt: string /* ISO-8601 */ }
  400:   blob too large / malformed
  403:   caller not a member of conversationId
  404:   targetDeviceId not a member of conversationId

GET    /restore-blobs/:blobId
  200:   { blobId, conversationId, fromDeviceId, blob /* base64 */, createdAt, expiresAt }
  404:   no such blob, OR caller != targetDeviceId   (do not distinguish)

DELETE /restore-blobs/:blobId
  204:   deleted (caller must == targetDeviceId)
  404:   no such blob, OR caller != targetDeviceId
```

**Realtime (optional, not required):** B already learns `blobId` from the MLS `iuc/restore-envelope`
message, so a socket notification is **not** needed for correctness. If a `/secure` event like
`secure:restore-blob-available { conversationId }` is cheap on your side it's a nice-to-have for latency,
but please don't block on it — and it must carry **no** `blobId`-without-authz and **no** key/plaintext.

## Open decisions for the server team  **[SERVER DECISION]**

1. **Deletion mechanism** — explicit DELETE + TTL (recommended), consume-on-read, or TTL-only.
2. **TTL value** — suggest ~1h; configurable.
3. **Max blob size** — suggest a few MB. Whatever you set, please return a **distinct 400** so the SDK
   can fall back to INLINE/chunked rather than fail opaquely. (Tell us the limit so we cap client-side.)
4. **Idempotency / resume** — on an A-side resume, is a re-POST a fresh `blobId` (old one TTLs out), or
   idempotent by `(transferId, targetDeviceId)`? We lean fresh-`blobId` + TTL cleanup (simplest); we can
   include `transferId` in the body purely for your correlation/logging if useful.
5. **Rate limiting** — per-uploader and per-target caps to stop a device spamming blobs at another. Your
   policy; the SDK will surface whatever error you return.
6. **Storage backend** — entirely yours (DB row, object store, etc.); the SDK is indifferent.

## Contract package + version

These types belong in **`@agora-server/contract`** (Apache-2.0), consistent with the agreed model — the
SDK will **type-only re-export** them from `core/src/contract/` and add thin REST-client methods
(`uploadRestoreBlob` / `getRestoreBlob` / `deleteRestoreBlob`). Suggested additions:

- `UploadRestoreBlobBody` — `{ conversationId, targetDeviceId, blob }`
- `RestoreBlobModel` — the GET response row
- (and the `blobId`/`expiresAt` response shapes)

This is an additive surface → a **minor** contract bump (e.g. `0.9.x` → `0.10.0`); the SDK will move its
`@agora-server/contract` dependency to the new minor when it's published.

## What the SDK guarantees on its side (so the blindness holds)

- The blob is sealed **client-side** with a full-entropy random `K` (no KDF — `K` is already 256 bits of
  CSPRNG, never a passphrase) using **XChaCha20-Poly1305**, with the transfer descriptor
  (`transferId`, `conversationId`, `fromDeviceId`, `targetDeviceId`, `count`) bound as **AAD** so a blob
  can't be replayed into a different transfer.
- `K` is transmitted **only** inside the MLS `iuc/restore-envelope` control message. It is **never** put
  in any field of any request to this endpoint.
- On the wire to this endpoint the SDK sends **only** opaque base64 + the routing metadata above.
- B validates the blob's integrity (`sha256` over a pinned canonical JSON form) and the AAD binding
  **after** AEAD-decrypting locally; the server is not asked to validate any of it.

## Explicitly NOT being asked

- No plaintext storage, no key storage, no MLS awareness, no decryption, no message-history ledger.
- No durable/long-term blob retention — this is a one-shot drop-box, not a backup service (the
  passphrase `key-backup` path, now deprecated, was the durable-backup mechanism; this is not that).

## References

- IUC design (ENVELOPE variant, security analysis, known issues): `docs/superpowers/specs/2026-06-18-iuc-history-restore-design.md`
- Cross-repo ownership model (SDK → contract): `STATUS.md`
