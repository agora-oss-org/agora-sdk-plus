# Review — Secure chat: delivery model & privacy modes

**Reviews:** [`2026-06-18-delivery-and-privacy-modes-design.md`](2026-06-18-delivery-and-privacy-modes-design.md)
**Also touches:** [`2026-06-18-iuc-history-restore-design.md`](2026-06-18-iuc-history-restore-design.md)
**Date:** 2026-06-18
**Reviewer:** design + security pass (E2EE / blind-server model)

## Headline

Content confidentiality is **sound** — MLS still protects all message content and the blind server
never gains keys. The design's problems are not confidentiality breaks; they are **durability**,
**dependency-sequencing**, **cross-spec consistency**, and **metadata-honesty** problems. Several, as
written, can cause **silent permanent message loss** or **break decryption of legitimate messages**.
The recommendation is not "don't do this" — the inversion is coherent — but "don't ship it in this
order, and close the gaps below first."

## Ground-truth check (this reframes every claim)

The spec builds on infrastructure that **does not exist in the repo yet**. Verified against the code:

| Spec assumes | Reality today |
|---|---|
| "durable on-device plaintext store" it "builds directly on" | **Does not exist.** Plaintext is RAM-only in `okCache` (a `useRef` Map), `core/src/hooks/useSecureMessages.tsx:149,262`. No `saveMessagePlaintext`; no plaintext persistence anywhere. |
| "monotonic `seq` and per-device cursor" for messages | Messages have **no `seq`**; they page with `before` (newest-first) via `rest.listMessages`. Per-device cursors exist **only for handshakes** (`handshake:cursor:` in `core/src/persistence/repository.ts`). |
| ACK endpoint / per-device message delivery tracking | **Does not exist** for messages at all. |
| `ephemeral` field in the wire envelope | **Not in the contract.** `SecureMessageModel` (`@agora-server/contract`) has no such field. |

**Consequence:** the "forward-secrecy history fix" (durable plaintext store) is not merely a
dependency — it is the load-bearing wall of this design, and it is still a plan. That changes the risk
posture of everything below.

---

## 🔴 High severity

### H1 — Delete-on-delivery on a not-yet-existent durable store = silent permanent data loss

Today the server is the durable archive and the device keeps nothing. This spec inverts that. If
server deletion ships **before** the device store is proven bulletproof, the failure mode is
**irreversible, silent loss with no fallback anywhere**.

The danger is the gap between two one-way, unrecoverable events:

1. **MLS decrypt consumes the single-use key** — the whole reason `okCache` exists
   (`useSecureMessages.tsx:213-216`: "its single-use key is already consumed").
2. **Plaintext is committed durably to disk.**

If the process dies / IndexedDB rejects the write / the tab closes **between (1) and (2)**, the key is
gone, the plaintext was never persisted, and once the ACK fires the server deletes the blob —
unrecoverable from every party. "ACK only after successful local persist" is necessary but **not
sufficient**: it doesn't address the window between *key consumption* and *persist confirmation*, which
exists independently of the ACK.

**Recommendations**
- **Hard sequencing gate:** no true server deletion until (a) the durable store ships with explicit
  crash/atomicity tests, and (b) IUC restore is proven end-to-end.
- Ship a reversible **intermediate**: server tracks ACKs and *marks* blobs delivered but **retains**
  them (reduced retention, not zero). Earns the delivery telemetry and de-risks the store before
  flipping to true delete.
- Define the **atomicity of "consume key → persist plaintext"**. Consider a local write-ahead buffer
  (persist the ciphertext transiently until plaintext persist is confirmed, so a crash mid-decrypt is
  replayable).

### H2 — The IUC "recovery" story does not cover the offline-too-long case

The spec repeatedly soothes "recovery then falls to IUC" (TTL expiry; known-issue #3; model table). But
IUC triggers on **"re-joined a conversation… but local store is empty"**
(`iuc-history-restore-design.md:77`) — a *re-provisioned/empty* device doing a *full* restore.

A recipient merely **offline longer than the TTL** is different: their store is **not empty**; they have
a **gap in the middle**. IUC has no gap-fill mode — its protocol transfers whole history for an empty
store, gated on a re-join + SAS ceremony. There is no "give me messages between X and Y" flow (the
`sinceCreatedAt?: null` hint is never developed).

**So "recovery falls to IUC" is incorrect for the TTL case.** As written, offline > TTL = **permanent
loss** of those messages. Either:
- IUC gains an explicit **gap-fill** variant (and the SAS/re-join ceremony doesn't fit a device that
  never left the group — needs its own design), **or**
- this spec states plainly that offline-beyond-TTL is irrecoverable, making TTL a **hard data-loss
  horizon**, not the gentle "privacy/availability dial" it's framed as.

### H3 — Group / multi-device delete-correctness is punted but is a prerequisite, not future work

Deletion fires when "**all** subscribed recipient devices ACK." That needs the **blind server** to hold
a complete, current roster of every member's every device. Roster management is deferred to "out of
scope (#2)" — but you **cannot ship delete-on-delivery for groups** without it: a stale roster either
deletes a blob a member still needs (→ H1) or pins blobs forever (→ TTL → H2).

Trust dimension: the **server computes** ACK-set completeness. A compromised/buggy server can declare
the set complete and delete early; there is no client-side "everyone got it" check.

**Recommendation:** scope v1 delete-on-delivery to **single-device DM**; groups/multi-device
**default-retain** until roster is solved. State this as a gate **in this doc** — its own correctness
claims depend on it.

---

## 🟠 Medium severity

### M1 — Dropped/un-persisted ephemeral messages can break decryption of *subsequent legitimate* messages

A real protocol interaction the spec misses; it touches the "buffer ahead-of-epoch / replay-gap
rejection" invariants directly.

Every ephemeral message **advances the MLS secret-tree generation** (spec agrees: "advances the
ratchet"). Combine:
- ephemeral messages are **relay-only, dropped if recipient offline** → the recipient can legitimately
  miss generations;
- ephemeral plaintext is **deliberately never persisted**, and state is dropped on reload.

A recipient who misses an ephemeral message, or reloads mid/after an ephemeral burst, hits a
**generation jump** on the next *non-ephemeral* message. MLS tolerates forward-derivation across skipped
generations only up to a **max-skip bound**. A burst longer than that window, followed by a real
message, → the real message lands as **"rejected" (terminal)** (`useSecureMessages.tsx:234-250`). A
privacy feature that can poison the main channel is a serious correctness regression.

**Recommendation:** specify how ephemeral generation gaps are bounded/recovered (e.g. an epoch
bump/Commit at session end to reset the ratchet, or persisting secret-tree consumption state across the
session). **Test:** N-message ephemeral session (N > skip window) → reload/offline → next normal message
still decrypts.

### M2 — The ACK introduces NEW durable metadata; the privacy win is partly illusory

"Privacy posture" claims default mode "collapses the long-term durable-metadata trail to in-flight
only." But delete-on-delivery **adds** a fine-grained, per-device, per-message **delivery graph**:
"device X fetched+persisted seq N at time T." Today the server doesn't necessarily record each device
pulling each message; the ACK protocol *creates* exactly that. A hostile/compromised server can retain
the ACK log forever **after** deleting ciphertext.

The design **trades ciphertext-at-rest for delivery-telemetry-at-rest** — possibly a net win, but
presented as pure subtraction. Be honest: enumerate the durable metadata that **remains** regardless —
conversation membership, device roster, KeyPackage publish events, the full Commit/Welcome handshake
log with timestamps, and now the ACK/delivery graph. "In-flight only" is too rosy.

### M3 — The `ephemeral` flag is a cleartext "sensitivity beacon"

It *must* be server-readable (correct — a blind DS can't route on encrypted metadata), and the spec
honestly lists it as visible. But it under-sells the consequence: the flag **paints a target.** An
observer learns "these two are deliberately going off-the-record *right now*" — often more interesting
than the content. Ephemeral traffic is wire-distinguishable by design. State it plainly.

### M4 — Marker write semantics are unspecified — and that's the central design decision

"The client writes a marker to the durable store **on both ends**" hides two very different designs:

- **(a) Each side writes locally** on observing the flag transition → if the recipient is offline for
  the first ephemeral message (which is *dropped* by policy), they **never see the transition** and
  write **no marker** → asymmetric history (sender shows `🔒`, recipient shows nothing).
- **(b) The start marker is a sent non-ephemeral message** → reliable, symmetric, IUC-carried — but the
  server now sees a durable message immediately before a burst of relay-only traffic = an even
  **sharper** private-session boundary beacon than the flag itself.

You can't have both reliable bracketing and minimal metadata. Issue #7 gestures at the symptom without
resolving the mechanism. **Pick (a) or (b) and document it.**

### M5 — Crash during a private session → dangling `🔒` with no `🔓`

Client policy drops ephemeral state on "conversation-close / background / reload." If a session ends via
crash/reload rather than explicit toggle-off, **no `🔓 Private chat ended` marker is written** — next
load shows an unterminated private chat. Need an explicit rule: write the end marker eagerly, or
auto-close a dangling start marker on load. Currently unspecified.

---

## 🟡 Notes / smaller points

- **N1 — Server build is undercounted.** Messages today have **no seq, no per-device cursor**; this
  needs a whole **per-device message delivery-tracking subsystem** (seq assignment, per-device message
  cursor, ACK-set bookkeeping), not just delete + TTL + honor-ephemeral. Size it honestly.
- **N2 — Two independent persistence impls, no net.** Durability now rests on *both* web (IndexedDB)
  and native stores being individually correct, with zero server fallback. Known-issue #1 frames loss
  as a *user-action* trade; it under-states **bug-induced** loss — a regression that was invisible
  before (server had a copy) is now permanent.
- **N3 — Group ephemeral fragmentation.** Relay-only "to currently-connected devices" means group
  members receive different subsets of an ephemeral exchange by who's online — the conversation
  fragments per-recipient. Worth a sentence even with group total-privacy deferred.
- **N4 — Legal/compliance dimension.** Designed-non-retention has upsides (less to subpoena) and
  potential obligations (jurisdictional retention rules). Flag for someone to check.
- **N5 — "Read" vs "device-ACK" is right, but** the ACK is still a *delivery*-confirmation channel
  (see M2). It avoids the *read*-receipt leak, not the *delivery*-receipt metadata. The doc conflates
  the two.

---

## ✅ What the design gets right

- **Device-ACK over "read"** as the deletion trigger — blind-server-observable, prompt, avoids the
  read-receipt leak (`:34`).
- **Persisting ratchet/group state while dropping plaintext** is correctly called unavoidable, and the
  "N-messages-happened count leak" is **honestly disclosed** (`:99-104`) rather than hidden.
- **Content-free markers carried by IUC** — elegant: preserves the *fact* without the content.
- **Cooperative-enforcement honesty** (#5) and the "patched client/screenshot defeats it" caveat are
  appropriately humble.
- **Naming the source-of-truth inversion as a cross-repo contract change** that both repos must restate
  (`:78-79`, `:154-156`) — mature; this rots silently otherwise.
- The `ephemeral`-flag-must-be-cleartext decision is correct for a blind DS, despite the M3 downside.

---

## Proposed edits (drafted, ready to fold into the design doc)

Each edit below is written so it can be pasted into
[`2026-06-18-delivery-and-privacy-modes-design.md`](2026-06-18-delivery-and-privacy-modes-design.md)
with minimal massaging. They are ordered by the blocking-ness of the issue they close.

### Edit 1 — Rollout sequencing gate (closes H1)

> Add as a new top-level section, **"## Rollout sequencing (gate)"**, before "## Server as a delivery
> cache".

**Server deletion is the LAST thing enabled, not the first.** Because the device store is the only
fallback after delete-on-delivery, deletion MUST NOT be enabled until the store is proven durable and
IUC restore works. Ship in three reversible stages:

| Stage | Server retention | Client | Gate to advance |
|---|---|---|---|
| **0 — today** | durable archive (unchanged) | RAM-only `okCache` | — |
| **1 — durable store** | durable archive (unchanged) | persist plaintext after decrypt; ACK on persist; **server still keeps blobs** | crash/atomicity tests green (Edit-1 tests); IUC restore green E2E |
| **2 — mark-delivered, retain** | keeps blobs, records ACK-set, marks "delivered"; **no delete yet** | unchanged from stage 1 | delivery telemetry correct in staging; no ACK-before-persist observed |
| **3 — delete-on-delivery** | deletes on complete ACK-set + TTL | unchanged | only after stages 1–2 are stable in production |

Stage 2 is the safety valve: it earns the entire delivery-tracking subsystem and the ACK protocol
**without** the irreversible deletion, so a latent persistence bug surfaces while the server still holds
a copy. Promotion 2 → 3 is a config flip, reversible by re-enabling retention.

**Persist/ACK atomicity (normative).** The single-use MLS key is consumed at decrypt
(`useSecureMessages.tsx:213-216`); plaintext is only safe once it is **durably committed**. Therefore:
1. decrypt → 2. **durably** write plaintext (await the store's commit, not just the call) → 3. only then
ACK. A crash between (1) and (2) must be **replayable**, not lossy: until the plaintext commit is
confirmed, retain the source ciphertext in a local write-ahead buffer keyed by message id, and clear it
only after the plaintext commit. The ACK is derived from the confirmed plaintext commit, never from the
decrypt.

### Edit 2 — Scope gate: single-device DM first (closes H3)

> Add to the model table footnote and to "## Known issues & limitations" #2.

v1 delete-on-delivery is **single-device DM only**. The ACK-set rule ("all subscribed recipient devices
ACK") requires a complete, current device roster that only exists trivially for a 2-party, 1-device-each
DM. **Groups and multi-device default to retain** (stage ≤ 2 above) until roster management lands,
because:
- a stale roster that under-counts deletes a blob a real member still needs (→ data loss), and
- the **server computes** ACK-set completeness, so a buggy/compromised server can declare it complete
  and delete early. There is no client-side "everyone got it" proof.

Group/multi-device delete-on-delivery is explicitly **out of scope until** a roster spec defines: how
the server learns current MLS membership without parsing Commit content, how a device entering/leaving
mid-flight is handled, and what client-observable signal (if any) bounds early deletion.

### Edit 3 — Reconcile TTL recovery with IUC (closes H2)

> Replace known-issue #3 and the model table's "Offline delivery" cell wording.

IUC as specified restores history **only to an empty store** on a re-provisioned device
(`iuc-history-restore-design.md:77`). A device that was merely **offline longer than the TTL** has a
**non-empty store with a middle gap** — a case IUC does **not** cover. So:

- **Be precise:** offline-beyond-TTL is **not** "recovery falls to IUC." As specced it is **permanent
  loss** of the TTL-expired window.
- **Pick one** and write it down:
  - **(3a) Accept the loss.** Re-frame TTL as a **hard data-loss horizon**, not a soft
    "privacy/availability dial." Surface it: a recipient offline > TTL sees an explicit gap marker, not
    a silent hole. Set TTL conservatively (it is now a durability parameter, not just privacy).
  - **(3b) Add IUC gap-fill.** Extend IUC with a `restore-request { sinceCreatedAt, untilCreatedAt }`
    variant for a **non-empty** store with a known gap. Note this needs its own trigger (gap detected
    via `seq`/cursor discontinuity, **not** "empty store") and a re-auth story — the SAS/re-join
    ceremony doesn't apply to a device that never left the group, so gap-fill must authenticate over the
    **existing** MLS channel. This is a real addition to the IUC spec, not a footnote.

### Edit 4 — Ephemeral generation-gap handling (closes M1)

> Add as a subsection under "## Total-privacy mode", **"### Ratchet-gap safety"**.

Every ephemeral message advances the MLS secret-tree generation, yet ephemeral messages are
**relay-only / dropped if offline** and their state is **dropped on reload**. A recipient who misses an
ephemeral burst (offline at relay, or reload mid-session) then faces a **generation jump** on the next
non-ephemeral message. MLS forward-derives across skipped generations only up to a bounded window;
a burst larger than that window → the next legitimate message lands **"rejected" (terminal)**
(`useSecureMessages.tsx:234-250`). A privacy feature must not be able to poison the main channel.

**Decision (pick one, document the bound):**
- **(4a) Epoch reset on session end.** When a private session ends, the initiator sends a Commit
  (epoch bump) before the next default message, resetting the secret-tree generation so no large
  app-message gap can accrue. Cost: a handshake per session boundary.
- **(4b) Bounded sessions.** Cap ephemeral messages per session below the configured max-skip window,
  and force an epoch bump when the cap is hit. Document the exact bound and where it is enforced.

Either way, the next non-ephemeral message after **any** missed/forgotten ephemeral generations MUST
still decrypt. This is a hard correctness invariant, not best-effort.

### Edit 5 — Marker mechanism + crash integrity (closes M4, M5)

> Replace the second paragraph of "### The `🔒 Private chat` markers" and expand issue #7.

**Marker write mechanism — choose explicitly:**
- **(5a) Sent non-ephemeral message (recommended).** The start marker is a real, durable, non-ephemeral
  MLS message; the end marker likewise. Pro: reliable, symmetric on both ends, IUC-carried for free,
  correctly ordered by `seq`/`createdAt`. Con: the server sees a durable message immediately bracketing
  a relay-only burst — a **sharper** private-session boundary beacon than the `ephemeral` flag alone.
  Accept and document this metadata cost.
- **(5b) Local-only write on flag transition.** Each side writes its own marker when it observes the
  mode change. Pro: no extra server-visible boundary message. Con: if the recipient is offline for the
  first (dropped) ephemeral message, it **never observes the transition** → asymmetric history (sender
  shows `🔒`, recipient shows nothing). Rejected unless asymmetry is acceptable.

**Crash integrity (normative).** A private session can end by crash/reload, not just an explicit
toggle-off. Rules:
- The `🔓 Private chat ended` marker is written **eagerly** on any session-terminating transition
  (toggle-off, conversation-close, background).
- On load, a **dangling `🔒` start marker with no matching `🔓`** is auto-closed (synthetic
  `🔓 Private chat ended` at the last-known session boundary) so the timeline never shows an
  unterminated private chat.

### Edit 6 — Metadata-honesty pass (closes M2, M3, N5)

> Replace the "Default mode keeps no durable ciphertext archive…" bullet in "## Privacy posture" and
> the "Not claimed" bullet.

Default mode removes the **ciphertext** archive but introduces **new durable metadata** — be explicit
rather than claiming "in-flight only":

- **Durable metadata that REMAINS regardless of deletion:** conversation membership, the device roster,
  KeyPackage publish events, the full Commit/Welcome handshake log **with timestamps**, and — new — the
  **per-device / per-message ACK (delivery) graph** ("device X persisted seq N at time T"). A
  compromised/hostile server can retain the ACK log **after** deleting ciphertext. Delete-on-delivery
  therefore **trades ciphertext-at-rest for delivery-telemetry-at-rest** — a different shape of
  exposure, not pure subtraction.
- **`ephemeral` is a cleartext sensitivity beacon.** It must be server-readable (a blind DS cannot route
  on encrypted metadata), so an observer learns *"these two are deliberately off-the-record right now"*
  — often more interesting than the content. Ephemeral traffic is wire-distinguishable by design.
- **Device-ACK avoids the *read*-receipt leak, not the *delivery*-receipt leak.** The ACK is still a
  per-message delivery-confirmation channel; do not conflate "no read receipts" with "no metadata."

---

## Testing gaps to add (drafted as concrete cases)

Add to "## Testing strategy". Grouped by layer to match the existing structure.

**Unit (core, mock crypto + MemoryStore)**
- **ACK-after-persist ordering:** the client emits an ACK **only after** the store's plaintext commit
  resolves; assert no ACK on a store whose commit rejects/throws. (H1)
- **ACK never precedes persist under concurrent reload:** simulate a reload/teardown interleaved with a
  decrypt-in-flight; assert no ACK was emitted for a message whose plaintext was not committed. (H1)
- **Write-ahead replay:** with plaintext commit forced to fail after key consumption, the source
  ciphertext is retained locally and the message is replayable (not lost); on retry it persists and
  only then ACKs. (H1)
- **Ephemeral mode toggle is per-message:** receiver honors the message's `ephemeral` flag independent
  of its own UI toggle (already listed — keep).
- **Marker crash integrity:** a stored `🔒` with no matching `🔓` is auto-closed on load; an eager
  `🔓` is written on conversation-close/background. (M5)

**Transport contract**
- **ACK-set early-delete adversary:** a mock server that declares the ACK-set complete with a device
  missing must **not** cause the client to treat history as safely delivered; client surfaces/handles
  the discrepancy rather than trusting the server's completeness claim. (H3)
- **Ephemeral relay-only:** an ephemeral send carries `ephemeral:true`, is never written via
  `saveMessagePlaintext`, and the client performs **no** catch-up fetch for it. (already listed — keep)

**ts-mls layer (`react-js`, real core + IndexedDB)**
- **Ratchet-gap survival (the M1 case):** run an ephemeral session of **N > max-skip-window** messages,
  then drop/forget them (offline or reload), then send a normal message → it **still decrypts**. Prove
  the epoch-reset/bound from Edit 4 actually prevents a terminal "rejected". (M1)
- **History survives server delete:** a default message survives reload from the local store with the
  server blob **already deleted** (proves history no longer depends on the server). (already listed —
  keep)
- **Ephemeral gone, markers remain:** ephemeral content is absent after reload; `🔒`/`🔓` markers remain
  and an IUC restore carries the markers, not the ephemeral content. (already listed — keep)

**Offline > TTL (new, proves H2 either way)**
- With **(3a)**: a recipient offline past TTL gets an **explicit gap marker**, not a silent hole, and
  the TTL-expired messages are confirmed **unrecoverable** (no IUC empty-store trigger fires for a
  non-empty store). (H2)
- With **(3b)**: a non-empty store with a detected `seq`/cursor gap triggers IUC **gap-fill**
  (`sinceCreatedAt`/`untilCreatedAt`), authenticated over the existing MLS channel (no SAS re-join), and
  the gap is filled + de-duped by `messageId`. (H2)

**Server (separate repo)**
- Blob deleted only after a **complete** ACK-set; an incomplete set retains. (H3)
- TTL deletes an unacked blob; ephemeral blob is never persisted nor served from a cursor. (already
  listed — keep)
- ACK/delivery-graph retention is documented and bounded (so the new metadata of M2 is a deliberate,
  reviewed choice). (M2)
