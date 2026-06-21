# IUC restore — slicing & the local-first prerequisite (sequencing note)

**Status:** decision record / sequencing note — *not* a design spec. Captures where the IUC slice-#2
brainstorm landed so the work can resume cold. The two designs it sequences (Slice 2a, Slice 2b) each
get their own `…-design.md` via the normal brainstorm → spec → plan flow.
**Date:** 2026-06-21
**Author context:** written during the brainstorm of "IUC slice #2 (the Act II transfer state machine)",
which surfaced an unbuilt prerequisite and forced a decomposition. This note records that.

## TL;DR

"IUC slice #2 = the A→B transfer state machine" **cannot land as one slice** — it has an unbuilt
prerequisite. The server is becoming a **delivery-only relay that lists nothing**; the durable record of
a conversation lives **on the device**. But the current SDK still renders `useSecureMessages` from the
server's message list (`rest.listMessages`) and only persists message *content bytes* locally — not full
message records. So a restored row has **nowhere durable to land** and **nothing to render against**.

**Decomposition (agreed):**

| Slice | What | Why first |
|---|---|---|
| **2a — local-first message persistence** ("device-as-archive") | Persist full message *records* locally; render `useSecureMessages` from the **local store** as source of truth; demote the server list to a catch-up that hydrates the store. | The prerequisite. Stands alone (normal reload is already broken in a delivery-only world without it). SDK-only, reversible, forward-compatible. |
| **2b — the IUC transfer (original "slice #2" spine)** | A reads its full local store → seals → ENVELOPE → B opens/verifies → **patches self-describing records into B's local-first store** → B renders the full restored conversation. | Lands cleanly once 2a gives it a real home. |

**Next action:** brainstorm **Slice 2a** (`→ docs/superpowers/specs/2026-06-21-local-first-message-persistence-design.md`),
then plan + build it, then return to 2b.

---

## How we got here (the discovery)

The slice-#1 ENVELOPE foundation (blob AEAD `seal.ts`, the `kind:1` control codec `control.ts`, the
three `restore-blobs` REST methods) is **shipped**. Slice #2 was scoped as "drive those primitives with
the Act-II transfer state machine." Two clarifications during brainstorming changed the shape:

1. **The server is moving to delivery-only — it lists nothing.** Per
   `2026-06-18-delivery-and-privacy-modes-design.md`: the blind server becomes a **delivery cache**
   (deletes a blob once delivered to all recipient devices, TTL fallback), and the **device's local
   store becomes the source of truth** ("source-of-truth inversion"). `rest.listMessages` as a *render
   source* goes away.

2. **A holds the whole conversation; B's own past messages come home through A.** In a DM, A's local
   store contains the messages A sent **and** the messages B sent (which A received and decrypted-once-
   and-stored). "Restore A's history" = hand B back the entire conversation, both directions. So a
   restored row's `senderUserId` is **load-bearing** (B must know which restored rows were its own, for
   `mine` alignment/rendering) — the row is firmly **self-describing**.

Together these mean: in the delivery-only world B cannot list historical rows from the server, so the
restore row must carry everything needed to render and order each message — **and** B needs a durable
local store that `useSecureMessages` renders from. That store + render path **does not exist yet**.
Hence the prerequisite, hence the split.

## Why the prerequisite is broader than IUC

The "render from the local store, server is just delivery" inversion is needed for **normal reload**
too, not only IUC: once the server stops re-serving history, a returning (same) device that reloads has
nothing to render unless it kept full records locally. So Slice 2a is valuable on its own and is the
honest foundation both delete-on-delivery **and** IUC restore stand on. It is the SDK-side realization
of the delivery-modes design's **Stage 1** ("store proven": persist after decrypt, render from store;
server still keeps blobs) — the reversible, SDK-only stage.

---

## Slice 2a — local-first message persistence ("device-as-archive")

### Scope (the edge)

> Persist full message **records** locally, and render `useSecureMessages` from the **local store** as
> the durable source of truth. The server's message list is demoted to a **catch-up that hydrates the
> store** (discover-and-persist), never the render source.

**Approach:** SDK-only, reversible, **forward-compatible**. It works whether the server still lists
durably (today) or eventually consume-deletes (tomorrow): the store renders either way, and the catch-up
just returns fewer rows over time. **No server contract change is required for 2a** — which is good,
because the server-side delivery-tracking subsystem (message `seq`, per-device message cursor, ACK
endpoint, `ephemeral` field) is **not built yet** (per the delivery-modes design's "Foundation status").

### Explicitly OUT of 2a (sibling slices of the delivery-modes design — not IUC prerequisites)

- ❌ delete-on-delivery + per-device ACK endpoint + TTL (server work)
- ❌ `ephemeral` / total-privacy mode + `🔒 Private chat` markers + ratchet-gap safety
- ❌ the new server message-cursor / `seq` contract

### Settled directions (to confirm/refine in 2a's own brainstorm)

- **Record schema:** generalize today's content-only persistence
  (`saveMessageContent`/`loadMessageContent`, keyed `msg:<conv>:<messageId>`) to a full **message
  record** = the `SecureMessageModel` envelope metadata (`id`, `conversationId`, `senderUserId`,
  `senderDeviceId`, `epoch`, `createdAt`, `contentType`) **+** the decrypted content-frame bytes
  (`[kind][payload]`, still needed for decode + fold). The model is available on every receive path
  (server list / socket event) and on send (`rest.sendMessage` response).
- **Render source:** `useSecureMessages` lists **records from the local store**, paginated locally;
  a server catch-up discovers not-yet-seen messages, decrypts, and **writes records into the store**,
  after which rendering is purely store-driven. Dedup by `messageId`.
- **Decrypt-once / forward secrecy:** unchanged — content is persisted on first decrypt; reload renders
  from the record without re-touching the (consumed) ratchet.

### Open questions for 2a's brainstorm

- **Ordered local pagination:** the durable list must page by `(createdAt, messageId)`. Design the
  record key (e.g. a sort-stable `msgrec:<conv>:<createdAt>:<messageId>`) so `SecureChatStore.list(prefix)`
  yields order, vs. an index record. Interacts with at-rest encryption (keys may be opaque).
- **Catch-up merge semantics:** how the server catch-up (today `rest.listMessages`; tomorrow a since-
  cursor consume pull) hydrates the store without double-rendering or clobbering a newer local row.
- **Migration:** zero users, clean break — but confirm whether existing content-only records need a
  one-time absorb or can be dropped.
- **Fold integration:** `MessageFold` stays; confirm it re-folds identically from records on reload.

---

## Slice 2b — the IUC transfer (the original "slice #2" spine)

Lands **after** 2a. Decisions already settled in the slice-#2 brainstorm:

- **Spine only:** single-blob **ENVELOPE** A↔B state machine end-to-end —
  gather → seal → upload → `restore-envelope` (`K` over MLS) → `restore-complete`; B reconstructs the
  AAD descriptor (per the slice-#1 hand-off table), fetch → open → verify `sha256` → dedup by
  `messageId` → persist record → delete → `restore-ack`; plus the `transferId` resume marker and
  live-overlap dedup. **Defer** multi-blob chunking (cap-outstanding / drain-as-you-go / `413`-split /
  `429`-backoff / reassembly) and the **INLINE** small-history variant to a later increment.
- **Self-describing rows:** each row = `{ messageId, senderUserId, createdAt, content-frame-bytes }`,
  `conversationId` transfer-level. B persists these as **full records into 2a's local-first store** and
  renders them through 2a's store-driven path. (This is why 2a must come first.)
- **Both directions:** A transfers its entire local store for the conversation — A-authored and
  B-authored messages alike — so B recovers the complete conversation.
- **SAS / consent gate is slice #3:** 2b models the gate as an abstract "transfer authorized"
  precondition (a guard/input the hook supplies); the real SAS derivation (reusing the shipped
  `exportSecret`) + consent UX + the "no payload before SAS" M3 hard gate land in slice #3.
- **State machine shape:** follow the repo idiom — a **pure reducer** (à la `MessageFold`) that the
  hook drives, with transport/crypto effects at the hook boundary (testable with mock crypto +
  MemoryStore).

### Deferred to later IUC slices (unchanged from the slice-#1 hand-off)

- **#2b chunking + INLINE** (above).
- **#3 Act I + SAS gate:** re-join / empty-store detection, SAS, consent UX, M3 hard gate.
- **#4 hook/UX:** `useSecureRestore`, triggers, progress; the optional
  `secure:restore-blob-available` realtime nudge.

---

## References

- Slice-#1 foundation (shipped): `docs/superpowers/specs/2026-06-20-iuc-envelope-foundation-design.md`
  — incl. the **slice-#2 AAD-reconstruction hand-off** table and the `count` ≠ `chunkCount` trap.
- Full IUC feature design: `docs/superpowers/specs/2026-06-18-iuc-history-restore-design.md`.
- Delivery-only / device-as-archive (the source of the prerequisite):
  `docs/superpowers/specs/2026-06-18-delivery-and-privacy-modes-design.md` — esp. "Source-of-truth
  inversion" and the staged, reversible rollout (Slice 2a ≈ its **Stage 1**, SDK-side).
- Settled server ENVELOPE relay contract:
  `docs/cross-repo/2026-06-20-iuc-restore-blob-implementation-guide.md`.
- MIMI content (the content-frame bytes 2a persists and 2b transfers):
  `docs/superpowers/specs/2026-06-20-mimi-cbor-content-design.md`.
