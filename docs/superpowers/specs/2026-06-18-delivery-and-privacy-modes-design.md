# Secure chat — delivery model & privacy modes

**Status:** draft design — pending review
**Date:** 2026-06-18
**Scope:** The conversation-delivery and retention model for secure chat: the server as a **pure
delivery cache** (blind ciphertext, deleted once delivered), the resulting **source-of-truth inversion**
(server → device), and an opt-in **total-privacy mode** (relay-only, RAM-only, online-only) bracketed by
a content-free `🔒 Private chat` marker. Builds directly on the durable on-device plaintext store (the
forward-secrecy history fix) and the IUC restore protocol (`2026-06-18-iuc-history-restore-design.md`).
Excludes: at-rest encryption of the local store (Phase-2.5), live multi-device fan-out internals, and
read-receipt UX (noted only where it touches deletion).

## Goal

Make the server a **blind delivery cache, not an archive**: it holds an opaque ciphertext blob only
long enough to deliver it to every recipient device, then deletes it. The **durable record of a
conversation lives on the participants' devices** (the local plaintext store), and cross-device recovery
is peer-to-peer over MLS (IUC). On top of this, give users an explicit **total-privacy mode** in which a
message is never cached server-side and never written to either device — leaving only a content-free
marker that the private exchange occurred.

## The model

| Mode | Server | Device | Offline delivery | Durable history |
|---|---|---|---|---|
| **Default** | delivery cache; blob deleted on all-recipient-device ACK (TTL fallback) | durable plaintext store = **source of truth** | ✅ held until delivered | full; IUC-restorable |
| **Total privacy** | relay-only; **never** cached | RAM only + a stored `🔒 Private chat` marker | ❌ online-only; dropped if recipient offline | marker only (content-free) |

## Decisions (from brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Server role | **Delivery cache**, not durable archive | Privacy: no standing ciphertext hoard, collapsed durable-metadata trail. Reliability is preserved by holding until delivered. |
| Deletion trigger | **All recipient devices ACK** receipt (fetched + persisted locally) — **not** "read" | The blind server can't observe "read" without a client signal; a read trigger leaks read-receipts to the server and retains data until someone opens the app. Device-ACK is observable and prompt. |
| Retention bound | **TTL fallback** (e.g. N days) even if unacked | A permanently-gone recipient device must not pin a blob forever. |
| Source of truth | **On-device plaintext store** (server REST list becomes a catch-up cache for *undelivered* messages) | Direct consequence of delete-on-delivery; makes the durable-store fix load-bearing and IUC the only cross-device history path. |
| Privacy mode signalling | **`ephemeral` flag in the unencrypted wire envelope** | The blind server must read it to apply relay-only policy; it's metadata, never content. |
| Total-privacy delivery | **Online-only, best-effort**; dropped if recipient offline | No server cache ⇒ nothing to deliver later. Acceptable, expected off-the-record behavior; surfaced in UI. |
| Private-session record | **Content-free `🔒 Private chat` start/end markers** (normal stored messages) | Preserves the *fact* of a private exchange (and restores via IUC) without any recoverable content. |

## Server as a delivery cache

The blind Delivery Service continues to accept and relay **opaque base64 ciphertext** for default-mode
messages, but its retention changes from "store durably + serve from a `seq` cursor forever" to:

```
1. A sends ciphertext (ephemeral:false) → server assigns seq, caches the blob, fans out realtime.
2. Each recipient DEVICE, on receipt (live or via catch-up GET .../messages?since=cursor), decrypts,
   persists plaintext locally, and ACKs the seq for its device row.
3. When EVERY subscribed recipient device has ACKed a seq, the server DELETES that blob.
4. TTL fallback: a blob unacked after N days is deleted regardless (the recipient device is treated as
   gone; recovery is then peer-to-peer via IUC).
```

- **Catch-up still works for offline recipients:** the blob lives until delivered, so a recipient who
  was offline still pulls it on reconnect. Durability of *delivery* is preserved; only durability of the
  *archive* moves to the device.
- **Multi-device / group:** deletion waits for **all** subscribed recipient devices (every member's
  every device). Until the device-roster ACK set is complete, the blob stays. (Single-device DM is the
  trivial case; multi-device fan-out detail is out of scope here but the ACK-set rule is the contract.)
- **Ordering / cursors unchanged for live + catch-up:** the monotonic `seq` and per-device cursor remain
  the ordering and gap-detection mechanism while a blob is still cached.

## Source-of-truth inversion (the architectural consequence)

Today's documented invariant — *"the durable source of truth is always the REST `GET .../messages`
endpoint; realtime is a notification optimization"* (`CLAUDE.md`, server `docs/SECURE_CHAT.md`) — **is
overturned by this design.** After delete-on-delivery:

- The server's `GET .../messages` list is a **transient catch-up cache** of *not-yet-delivered* messages,
  not a durable archive.
- The **durable record of conversation history is the on-device plaintext store.**
- Therefore the durable-store work (persist-after-receive + write-through `okCache`, from the
  forward-secrecy replay/history fix) stops being a reload nicety and becomes **the** history mechanism.
- And **IUC** (`2026-06-18-iuc-history-restore-design.md`) becomes the **only** way a re-provisioned or
  additional device obtains history — the server can no longer backfill it.

This is a deliberate, coherent inversion, but it is a cross-repo contract change: the server stops being
an archive, and the SDK + server spec must both state the new invariant explicitly.

## Total-privacy mode

A per-message property, toggled in-conversation; subsequent messages carry `ephemeral:true`.

**Wire envelope (server-readable metadata, never content):**
```jsonc
{ "ephemeral": true, /* conversationId, senderDeviceId, epoch, ciphertext … */ }
```

**Server policy when `ephemeral:true`:** **relay-only** — fan out to currently-connected recipient
devices, assign no durable cache entry, serve from no cursor; if a recipient device is offline at relay
time, the message is **dropped** (never delivered later).

**Client policy when `ephemeral:true`:** decrypt and render **in memory only**; **never** call
`saveMessagePlaintext`; drop from state on conversation-close / background / reload. The sender MAY hold
the ciphertext in RAM to retry while both peers are online, but it is never written to disk and is lost
on reload — by design.

**What still persists (unavoidable):** the message is a normal MLS application message, so it **advances
the ratchet**, and the group/ratchet state **must** still persist (or the next default-mode send
replays — the exact failure the history fix addresses). So total privacy guarantees **"no message
plaintext or ciphertext is retained,"** not "zero protocol trace": the ratchet generation position
implicitly records that *N messages happened* (count only — no content, no text, no sender-of-record in
the durable store beyond the marker).

### The `🔒 Private chat` markers

When a private session starts, the client writes a **normal, non-ephemeral system message** to the
durable store on both ends: `🔒 Private chat` (and a matching `🔓 Private chat ended` when it stops).
These are content-free, render as a bracket/divider in the timeline, and — being ordinary stored history
— are carried by IUC to a re-provisioned device. The restored device thus sees *"a private conversation
happened here"* with nothing recoverable inside it.

## Privacy posture (scoped)

The honest one-liner: **the server only ever holds ciphertext it cannot read, and in default mode it
deletes that ciphertext as soon as it's delivered.** Concretely:

- **Content** is protected by MLS regardless of caching — the blind server has no keys.
- **Default mode** keeps no durable ciphertext archive and collapses the long-term durable-metadata
  trail to "in-flight only," paired with strong instance hardening.
- **Total-privacy mode** additionally keeps nothing on either device (beyond the marker + ratchet
  advance) and delivers online-only.
- **Not claimed:** metadata in transit (who↔whom, when, size, and the `ephemeral` flag itself) is still
  visible to the relaying server; total-privacy is **cooperative** at the recipient end (a patched
  client or a screenshot defeats it, like any disappearing-message feature).

## Known issues & limitations

1. **Device is now the only archive.** Lose every device that holds a conversation with no peer able to
   re-serve it via IUC, and that history is gone. This is the intended privacy/durability trade; the
   passphrase `exportBackup`/`importBackup` path remains the user-controlled durable backup.
2. **ACK-set completeness for groups/multi-device.** Deletion correctness depends on a complete,
   current roster of subscribed recipient devices; a stale roster could delete a blob a not-yet-known
   device still needs, or retain blobs for a device that's actually gone (handled by TTL). Roster
   management is the load-bearing detail for group support (out of scope here).
3. **TTL vs. slow recipients.** A recipient offline longer than the TTL loses delivery of cached
   messages (recovery falls to IUC). TTL choice is a privacy/availability dial.
4. **Total-privacy delivery is best-effort.** Offline recipient ⇒ dropped. Must be shown in UI
   ("private messages deliver only while your peer is online; they're never saved").
5. **Cooperative enforcement.** `ephemeral` and the markers are honored by honest clients; they cannot
   bind a malicious peer.
6. **Mixed-mode handling.** The `ephemeral` flag is per message; the receiver honors the *message's*
   flag regardless of its own UI toggle. Both UIs should reflect the active mode, but correctness
   rides on the flag, not on synchronized toggles.
7. **Marker placement under races.** Start/end markers are ordered by the same `seq`/`createdAt` as
   chat; a private session that overlaps reconnects must still bracket correctly.

## Relationship to existing architecture

- **Depends on** the durable on-device plaintext store (forward-secrecy replay/history fix) — that store
  becomes the source of truth here.
- **Makes IUC the sole cross-device history path** — reinforces that spec's purpose.
- **Overturns** the `CLAUDE.md` / server `docs/SECURE_CHAT.md` invariant that the REST `/messages`
  endpoint is the durable source of truth. Both repos must restate it: server = delivery cache;
  device = archive.
- **Server-side work (separate repo):** delete-on-all-device-ACK + TTL, an ACK endpoint/extension to the
  per-device cursor, and honoring the `ephemeral` relay-only policy. The SDK side: send/honor the
  `ephemeral` flag, ACK on local-persist, RAM-only ephemeral rendering, and write/restore the markers.

## Testing strategy

- **Unit (core, mock crypto + MemoryStore):** ephemeral messages are rendered but **never** written via
  `saveMessagePlaintext`; default messages are; markers are written as normal history; the receiver
  honors a message's `ephemeral` flag independent of local toggle.
- **Transport contract:** client ACKs a seq only after a successful local persist; an ephemeral send
  carries `ephemeral:true` and the client treats relay-only delivery (no catch-up fetch) correctly.
- **ts-mls layer (`react-js`):** default message survives reload from the local store with the server
  blob already deleted (prove history no longer depends on the server); ephemeral message is gone after
  reload while the `🔒 Private chat` markers remain and an IUC restore carries the markers (not the
  ephemeral content).
- **Server (separate repo):** blob deleted after all-device ACK; TTL deletes an unacked blob; ephemeral
  blob is never persisted nor served from a cursor.

## Out of scope / future

- At-rest encryption of the local store (Phase-2.5: argon2id-derived, AEAD-wrapped DB key, auto-lock).
- Multi-device roster management and live fan-out internals.
- Read-receipt UX (distinct from the delete-on-delivery ACK).
- Group total-privacy policy (who can enable it, all-member consent).
