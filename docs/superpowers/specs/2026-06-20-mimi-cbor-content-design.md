# MIMI CBOR content format for secure-chat messages

**Status:** approved design — ready for an implementation plan
**Date:** 2026-06-20
**Scope:** Adopt the IETF **MIMI content format** (`draft-ietf-mimi-content-08`, the CBOR-encoded
`MimiContent` structure) as secure-chat's message **content** payload, replacing the bespoke `v:2`
JSON frame that was only ever designed, never shipped. This gives richer messages (replies, reactions,
edits/deletes) in a standards-shaped container and makes the SDK **interop-ready** for a future MIMI
world. **Client-only** — message content is, and stays, fully opaque to the blind server (only
ciphertext crosses the wire); **zero `@agora-server/contract`, REST, or socket change.** This is
**not** MIMI federation (hub-and-spoke routing, cross-provider identity, cross-server KeyPackage
exchange) — only the content format. There are **no existing users and no stored history**, so this is
a clean break with **no `v:1` back-compat, no migration, no capability negotiation**.

## Goal

Today a secure-chat message is **raw UTF-8 text** wrapped in a size-bucket padding frame
(`core/src/util/padding.ts`) — text-only, no replies, reactions, edits, or attachments. The planned
richer format was a bespoke `{ "v": 2, "kind": "chat"|"iuc", … }` JSON frame
(`docs/superpowers/specs/2026-06-18-iuc-history-restore-design.md`, "Wire framing"), still design-only.

Rather than invent our own message schema, adopt the IETF standard `MimiContent` (CBOR). We get the
conversational features users expect, a fixed well-designed schema, and genuine interop-readiness — at
the cost of a small deterministic CBOR codec. Because nothing uses secure-chat yet, MIMI content
becomes the **only** content format from day one.

## Decisions (from brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Purpose | **Standards-aligned content format (internal)**, replacing the `v:2` frame | High-leverage, self-contained; subsumes the unshipped `v:2` work and sets up interop without taking on federation. |
| Back-compat | **None.** MIMI CBOR is the only content format | Zero users, zero stored history — no `v:1` legacy, no migration, no capability negotiation. A clean break. |
| Frame / discriminator | The padded payload is **`[kind:1][payload]`**: `kind 0 = MimiContent (CBOR)`, `kind 1 = IUC control` (reserved) | One byte routes user content vs control traffic; keeps MIMI bytes *pure* (a 1-byte prefix, not a wrapping struct). |
| Surfaced features | **Tier 2** — text, replies, reactions, edits/deletes — while the **codec encodes/decodes the full schema** | The features that justify the move and exercise MIMI's referencing model; Tier-3 fields (attachments, expiry, threading) ride in the types/codec and are surfaced later **without rework**. |
| CBOR codec | **Hand-rolled, deterministic, dependency-free** (B), with a **library oracle** (`cbor2`) in tests (A) | Matches the `@noble/*` minimalist ethos; the needed subset excludes CBOR's hard parts (floats/indefinite/bignums); avoids ESM-only-lib friction in the dual-build core; the determinism guarantee is ours. The oracle + IETF vectors buy a mature decoder's confidence with no production dependency. |
| Reference model | **Hybrid** — references by **MIMI content-hash**, storage/ordering/dedup by **server `messageId`** | The only option that makes "interop-ready" true without re-plumbing the existing `(createdAt, messageId)` ordering; the hash is near-free given the canonical codec. |
| Rendered list | **Folded reducer in the hook** (A); raw decoded `MimiContent` still available | Core already owns message-list state (dedup/order/write-through); folding reactions/edits is the same state management, and out-of-order buffering reuses an existing pattern. |

## Architecture & module layout

A new **`packages/secure-chat/core/src/content/`** module, sitting **above** the crypto seam — the
`SecureChatCrypto` interface is unchanged (`encryptMessage`/`decryptMessage` still exchange
`Uint8Array`); content encoding is a core concern, never crypto's.

```
core/src/content/
  cbor.ts           deterministic CBOR codec (encode/decode the constrained subset)
  mimi-content.ts   MimiContent types + encode/decode/validate + contentHash()
  frame.ts          the 1-byte routing layer: [kind:1][payload]
  (reducer)         the fold lives next to useSecureMessages (message-list state)
```

- **`cbor.ts`** — encode/decode for: unsigned ints, negative ints, byte strings, text strings, arrays,
  maps, tags, and the simple values `false`/`true`/`null`. **No** floats, indefinite-length items, or
  bignums. Encoding is **canonical** (RFC 8949 §4.2 core deterministic rules for this subset):
  shortest-form integer/length encoding, definite lengths, and **map keys sorted by their encoded
  bytes**. Decode is **strict**: any major type, value, or non-canonical encoding outside the subset is
  **rejected**, and decode enforces bounds (max total size, max nesting depth, max array/map length).
- **`mimi-content.ts`** — the full `MimiContent` schema as TypeScript types, plus `encodeMimiContent`,
  `decodeMimiContent` (which validates the schema after CBOR-decoding), and
  `contentHash(content): Uint8Array` = **SHA-256** over the canonical CBOR bytes (via `@noble/hashes`,
  already a dependency; MIMI carries a `hashAlgorithm` discriminator — SHA-256 is the only value we
  emit).
- **`frame.ts`** — `frameContent(kind, payload)` → `[kind][payload]` and `unframe(bytes)` →
  `{ kind, payload }`. Sits inside the existing padding frame (padding is a transport concern and is
  unchanged).

## The content model

We **encode and decode the complete `MimiContent`** structure; the hook **surfaces Tier 2**.

`MimiContent` (per `draft-ietf-mimi-content-08`, 2 Mar 2026) fields the codec models:

- `salt` — per-message CSPRNG bytes (unlinkability of the content hash);
- `replaces` — content-hash of a message this one replaces (edit / delete / un-react);
- `topicId` — threading id (Tier 3; encoded, not surfaced);
- `expires` — absolute expiry (`Expiration = [relative: bool, time: uint]`; Tier 3; encoded, not surfaced);
- `inReplyTo` — a **bare 32-byte `MessageId`** (`Uint8Array | null`) — the content-hash of the reply
  target. (Note: the doc previously modeled this as `{ hash, hashAlgorithm }` but draft-08 uses a
  bare 32-byte `bstr.size 32`; the `MessageDerivedValue` type is removed accordingly.)
- `extensions` — extension map (round-tripped opaquely); `lastSeen` is **not in draft-08** (removed);
- `nestedPart` — the body tree. A `Part` is a cardinality-tagged union: **NullPart** (tombstone),
  **SinglePart** `{ contentType, content, … }`, **ExternalPart** `{ contentType, url, size, enc… }`
  (Tier-3 attachments — encoded, not surfaced), **MultiPart** `{ partSemantics, parts[] }`.

> **`contentHash` / MessageId derivation — deliberate documented deviation:** we emit
> `0x01 || sha256(canonical CBOR)[0..30]` (a MessageId-shaped 32-byte value) but the hash INPUT is
> simplified — no MIMI federation `senderUri`/`roomUri` — because this SDK adopts the content format,
> not MIMI federation. The WIRE CBOR is draft-08-faithful; only the hash input deviates (documented in
> the `mimi-content.ts` file header).

**Tier-2 feature → `MimiContent` mapping (surfaced):**

| Feature | Encoding |
|---|---|
| Text message | `nestedPart` = a SinglePart, `contentType: "text/markdown"`, `content` = the UTF-8 body; fresh `salt`. |
| Reply | as a text message **plus** `inReplyTo = <target contentHash>` (a bare 32-byte `MessageId`). |
| Edit | a text message with `replaces = <target contentHash>` and the new body. |
| Delete | `replaces = <target contentHash>` with a **NullPart** body (tombstone). |
| Reaction | a message that `inReplyTo`-references the target, body = the reaction token. |
| Un-react | `replaces = <your reaction message's contentHash>` with a **NullPart** body. |

> The exact reaction content-type / disposition encoding follows `draft-ietf-mimi-content-08` (2 Mar
> 2026); MIMI models reactions as ordinary messages, which fits the reducer cleanly.

## Data flow

**Send** (`useSecureMessages`):
```
app: sendMessage(content) | reply(target, …) | react(target, token) | edit(target, …) | delete(target)
  → build MimiContent (fresh CSPRNG salt; set inReplyTo/replaces as needed)
  → encodeMimiContent → frameContent(0, cbor) → padPlaintext → crypto.encryptMessage → transport
```

**Receive** (`useSecureMessages`):
```
crypto.decryptMessage → unpadPlaintext → unframe → kind?
  kind 0: decodeMimiContent + contentHash → reducer
  kind 1: hand the payload to the IUC state machine (reserved; out of scope here)
```

**Fold (reducer):** maintains the rendered `messages[]` keyed by server `messageId`, plus an in-memory
**`contentHash → messageId`** index. Each decoded content message:
- a **plain/reply message** → inserted/updated by `messageId`, indexed by its `contentHash`;
- a **reaction** → resolve `inReplyTo.hash` through the index → aggregate onto the target's `reactions`;
- an **edit** → resolve `replaces` → rewrite the target's body, stamp `editedAt`;
- a **delete** → resolve `replaces` → set `deleted: true` (tombstone, body cleared);
- an **un-react** → resolve `replaces` (the reaction's own hash) → remove that reaction.

## Reference resolution & out-of-order delivery

A reaction/edit/delete whose target hash is **not yet in the index** (target not decoded — MLS delivery
is not globally ordered, and B may receive a reaction before the message it reacts to) is **buffered**
in a pending-by-target-hash map and applied the moment the target arrives — the same fail-closed
"buffer, never silently drop" discipline the codebase already uses for dedup/ordering. On reload, the
index is **rebuilt by recomputing `contentHash` from the stored canonical bytes** (deterministic and
cheap), so no separate persisted hash→id index is required.

## Persistence

`SecureChatRepository.saveMessagePlaintext`/`loadMessagePlaintext` (keyed `msg:<conversationId>:<messageId>`)
evolve from raw UTF-8 to persisting the **decrypted content-frame bytes** (`[kind][payload]`). Reactions
and edits are themselves messages with their own `messageId`s, so they are stored as messages and the
reducer **re-folds on load** — the rendered view after a reload is identical to the live one.

Because there are no users, this is a clean break: `DecryptedSecureMessage.plaintext: string | null` is
**replaced** by a structured shape — a decoded `content` (the Tier-2 projection: body text, `replyTo`
hash, `editedAt`, `deleted`) plus an aggregated `reactions` map — with the raw decoded `MimiContent`
available underneath for power users. At-rest posture is unchanged (local-only plaintext; sealable by
the existing `createEncryptedStore` decorator).

## Error handling (fail closed)

Decoded content is **attested-not-verified** peer input (CLAUDE.md §1: validate, then decode,
everything relayed — a *peer* is trusted to be honest, not to be well-formed). Defenses:

- The CBOR decoder rejects unknown major types, non-canonical encodings, and anything outside the
  subset, and enforces **bounds** (max total frame size, max nesting depth, max array/map length).
- The `MimiContent` validator enforces **schema bounds** (max parts, max reactions, max `lastSeen`
  length, allowed content-types) and rejects malformed structures.
- Any rejection surfaces as the **existing** `status: "rejected", rejectedReason: "malformed"` path in
  `useSecureMessages` — never a thrown raw byte buffer, never plaintext or key material in an error.
- An `inReplyTo`/`replaces` referencing an **unknown** hash is **buffered**, not an error.
- Fail closed throughout: a content message that doesn't decode/validate is dropped (surfaced as
  rejected), never rendered as partial or guessed content.

## Testing strategy

- **CBOR codec (unit):** round-trip every value in the subset; **canonical byte-exactness** against the
  IETF draft's known vectors; reject non-canonical input (e.g. non-shortest ints, unsorted map keys),
  oversized/over-deep input, and out-of-subset major types.
- **Differential oracle:** cross-check our encoder/decoder against **`cbor2`** (a **test
  devDependency**, never a production dep) over randomized in-subset structures — bytes must match in
  both directions. A disagreement is a caught bug.
- **`MimiContent` (unit):** encode→decode round-trips for each Tier-2 shape and representative Tier-3
  shapes (attachments/multipart/expiry) to prove the codec models them; `contentHash` stability;
  schema-validation rejections.
- **Reducer (unit, mock crypto):** reply/edit/delete/react/un-react fold correctly; **out-of-order**
  (reaction before target) buffers then applies; dedup against the live stream; reload from the store
  re-folds identically.
- **Hooks (mock crypto):** `sendMessage`/`reply`/`react`/`edit`/`delete` round-trip end-to-end; the
  rendered `messages[]` reflects the fold; the wire payload (post-encrypt) never contains the plaintext
  body (server-blindness).
- **Hash stability across runtimes:** `contentHash` is identical for the same content (web/native), so
  references resolve cross-platform.

## Cross-spec impact (IUC)

This design **supersedes** the IUC spec's `v:2` JSON "Wire framing"
(`docs/superpowers/specs/2026-06-18-iuc-history-restore-design.md`): the `{ "v": 2, "kind": … }` JSON
frame is replaced by the **`[kind:1][payload]` routing byte + CBOR**. IUC control messages ride under
`kind 1`, encoded via this same CBOR codec (the control *semantics* remain IUC's to define). The
canonical-CBOR `contentHash` also gives IUC a pinned canonical form, **resolving IUC Known-Issue #12**
(sha256 canonicalization across web/native). Updating the IUC spec's Wire-framing section to reference
this design is part of this work.

## Out of scope / future

- **Tier-3 surfacing:** attachments (`ExternalPart` — encrypted blobs), disappearing messages
  (`expires`), threading (`topicId`/`lastSeen`). Encoded by the codec now; surfaced in the hook later,
  additively.
- **IUC control semantics** (request/offer/chunk/envelope/complete/ack) — owned by the IUC feature;
  this spec only reserves and routes `kind 1`.
- **Any server/contract/wire change** — message content is fully opaque to the blind server; this is a
  pure client-side content-encoding change with **zero** `@agora-server/contract` impact.
- **MIMI federation** — hub-and-spoke transport, cross-provider identity resolution, cross-server
  KeyPackage exchange. Adopting the content format is a deliberate *step toward* interop, not interop.

## Relationship to existing architecture

- **Replaces** the unshipped `v:2` frame as the message content format; **reuses** the existing padding
  frame (`util/padding.ts`) unchanged and the `SecureChatCrypto` seam unchanged.
- **Extends** `useSecureMessages` with the reducer and a structured message shape; **evolves** the
  durable store to hold content-frame bytes.
- **Unblocks/aligns** IUC: supplies the typed-frame routing IUC needs and a canonical hash that closes
  IUC #12.
- Adds **one small, dependency-free, fail-closed** module (`content/`) in the spirit of the repo's
  `@noble/*` + `ts-mls` minimalist crypto posture.
