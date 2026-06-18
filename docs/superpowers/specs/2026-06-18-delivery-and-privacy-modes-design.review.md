# Review — Secure chat: delivery model & privacy modes

**Reviews:** [`2026-06-18-delivery-and-privacy-modes-design.md`](2026-06-18-delivery-and-privacy-modes-design.md)
**Also touches:** [`2026-06-18-iuc-history-restore-design.md`](2026-06-18-iuc-history-restore-design.md)
**Date:** 2026-06-18
**Reviewer:** design + security pass (E2EE / blind-server model)

## Headline

Content confidentiality is **sound** — MLS still protects all message content and the blind server
never gains keys. The design's problems are not confidentiality breaks; they are **durability**,
**dependency-sequencing**, **cross-spec consistency**, and **metadata-honesty** problems. The
recommendation is not "don't do this" — the inversion is coherent — but "don't ship it in this order,
and close the gaps below first."

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
posture of every claim below.

## Severity calibration (how to read the ratings)

Severities were **recalibrated after review discussion**. Two things drive a rating:

1. **Which axis is it on?**
   - **Durability / correctness (honest-user):** the harm happens through *ordinary bugs, crashes, or
     normal offline conditions* — **no attacker required**. These do **not** get a likelihood discount;
     they bite real users in normal use, so they keep their weight.
   - **Security (adversary-dependent):** the harm requires a malicious or actively-compromised server (a
     passive data breach is not enough — the attacker must tamper with live traffic) **and** often a
     rare window. These get a likelihood discount: real, in-threat-model, but not everyday.
2. **Cost to fix now.** Everything here is design-stage; several fixes are nearly free now and expensive
   later. That keeps a low-likelihood item on the list without inflating its severity.

> **Finding IDs (H1, M2, …) are stable identifiers from the first draft, _not_ the severity.** The
> severity is the 🔴/🟠/🟡 on each finding and in the table below. Some IDs lettered "H…"/"M…" have been
> recalibrated up or down; the letter is historical.

| ID | Axis | Calibrated | Was | One-line reason |
|---|---|---|---|---|
| H1 | durability | 🔴 High | 🔴 | Silent permanent data loss via ordinary crash; **no attacker needed**; no fallback once server deletes. Stays. |
| H2 | durability | 🟠 Medium | 🔴 | Real data-loss gap, but **bounded and tunable by TTL**; the headline harm is a *false claim* in the doc, fixable now. |
| H3 | correctness | 🟠 Medium | 🔴 | A scoping constraint, fully **neutralized by shipping single-device-DM first**; adversarial sub-case is low-likelihood. |
| M1 | correctness | 🟠 Medium | 🟠 | A privacy feature can break the *main* channel for honest users; conditional on ephemeral mode shipping. Stays. |
| M2 | metadata-honesty | 🟡 Note | 🟠 | Not a hole — the posture doc **overstates**; fix is accurate wording. |
| M3 | metadata-honesty | 🟡 Note | 🟠 | Inherent and unavoidable; **document**, don't "fix." |
| M4 | correctness | 🟠 Medium | 🟠 | Genuinely unspecified design decision with real correctness fallout; must be chosen. Stays. |
| M5 | correctness/UX | 🟡 Note | 🟠 | Minor: a cosmetically wrong "unterminated private chat" label; trivial fix. |
| N1–N5 | mixed | 🟡 Note | 🟡 | Smaller points; unchanged. |

Net: **1 High, 4 Medium (H2, H3, M1, M4), the rest notes.**

---

## 🔴 High severity

### H1 — Delete-on-delivery on a not-yet-existent durable store = silent permanent data loss
**Axis: durability (honest-user). Severity: 🔴 High — unchanged.** This needs **no attacker**; it is
ordinary-failure data loss, so the likelihood discount does not apply.

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

---

## 🟠 Medium severity

### H2 — TTL "recovery falls to IUC" is a false claim; offline > TTL = permanent loss
**Axis: durability (honest-user). Severity: 🟠 Medium — downgraded from High.** *Why down:* the harm is
**bounded and tunable** — a conservative TTL shrinks the exposed window to near-zero, and the real defect
is an *incorrect sentence in the doc* (catchable now), not a default catastrophe. *Why still Medium:* if
left as written, honest users who are offline past the TTL silently lose messages they believe are
recoverable.

The spec repeatedly soothes "recovery then falls to IUC" (TTL expiry; known-issue #3; model table). But
IUC triggers on **"re-joined a conversation… but local store is empty"**
(`iuc-history-restore-design.md:77`) — a *re-provisioned/empty* device doing a *full* restore. A
recipient merely **offline longer than the TTL** has a **non-empty store with a middle gap** — a case
IUC does **not** cover. So "recovery falls to IUC" is incorrect for the TTL case; as specced it is
**permanent loss** of that window. Either add an IUC gap-fill variant, or state plainly that
offline-beyond-TTL is irrecoverable and treat TTL as a **durability** parameter, not a privacy dial.

### H3 — Group / multi-device delete-correctness depends on roster (scope it out of v1)
**Axis: correctness (+ a low-likelihood adversarial sub-case). Severity: 🟠 Medium — downgraded from
High.** *Why down:* it is **fully neutralized by the obvious scoping decision** (ship single-device DM
first); it only becomes High if you ship groups *without* solving roster. The adversarial sub-case
(server lies about ACK-set completeness) needs an actively-malicious server **and** lands in H1's
data-loss domain — low everyday likelihood.

Deletion fires when "**all** subscribed recipient devices ACK," which needs the blind server to hold a
complete, current device roster — trivial only for a 2-party, 1-device DM. **Recommendation:** v1
delete-on-delivery is **single-device DM only**; groups/multi-device **default-retain** until roster
lands. State this as a gate in *this* doc — its own correctness claims depend on it.

### M1 — Dropped/un-persisted ephemeral messages can break decryption of *subsequent legitimate* messages
**Axis: correctness (honest-user). Severity: 🟠 Medium — unchanged.** *Why it holds:* a *privacy*
feature able to poison the *main* channel for honest users is serious; it is gated only on ephemeral
mode actually shipping and on a burst exceeding the skip window.

Every ephemeral message **advances the MLS secret-tree generation** (spec agrees), yet ephemeral
messages are **relay-only / dropped if offline** and state is dropped on reload. A recipient who misses
an ephemeral burst (offline, or reload mid-session) hits a **generation jump** on the next
non-ephemeral message; MLS forward-derives across skipped generations only up to a **max-skip bound**.
A burst larger than that window → the next legitimate message lands **"rejected" (terminal)**
(`useSecureMessages.tsx:234-250`). **Fix:** specify a session-end epoch bump or a bounded-session cap,
and test that the next normal message after *any* missed ephemeral generations still decrypts.

### M4 — Marker write semantics are unspecified — and that's the central design decision
**Axis: correctness. Severity: 🟠 Medium — unchanged.** *Why it holds:* "write a marker on both ends"
hides two materially different designs, and getting it wrong yields *asymmetric history* on honest users.

- **(a) Each side writes locally** on the flag transition → if the recipient is offline for the first
  (dropped) ephemeral message, it **never sees the transition** → asymmetric history (sender shows `🔒`,
  recipient nothing).
- **(b) The start marker is a sent non-ephemeral message** → reliable & symmetric & IUC-carried — but
  the server sees a durable message bracketing a relay-only burst = a **sharper** boundary beacon than
  the flag itself.

You can't have both reliable bracketing and minimal metadata. **Pick (a) or (b) and document it.** (See
also M5 for the crash case.)

---

## 🟡 Notes / smaller points

### M2 — The ACK introduces new durable metadata (posture overstates "in-flight only")
**Axis: metadata-honesty. Severity: 🟡 Note — downgraded from Medium.** *Why down:* it is not a
vulnerability — it's an **accuracy** issue in the posture text. Delete-on-delivery removes ciphertext
at rest but **adds** a per-device/per-message ACK (delivery) graph the server (or a compromised one) can
retain after deletion. **Fix = honesty:** enumerate residual durable metadata (membership, device
roster, KeyPackage publishes, the timestamped handshake log, and now the ACK graph) instead of claiming
"in-flight only."

### M3 — The `ephemeral` flag is a cleartext "sensitivity beacon"
**Axis: metadata-honesty. Severity: 🟡 Note — downgraded from Medium.** *Why down:* it's **inherent** —
a blind DS must read the flag to route, so it cannot be removed, only disclosed. State plainly that
ephemeral traffic is wire-distinguishable and that the flag advertises "off-the-record right now."

### M5 — Crash during a private session → dangling `🔒` with no `🔓`
**Axis: correctness/UX. Severity: 🟡 Note — downgraded from Medium.** *Why down:* worst case is a
cosmetically wrong "unterminated private chat" label; trivial fix. Rule: write `🔓` eagerly on any
session-terminating transition, and auto-close a dangling `🔒` on load.

### N1 — Server build is undercounted
Messages today have **no seq, no per-device cursor**; this needs a whole **per-device message
delivery-tracking subsystem** (seq assignment, per-device message cursor, ACK-set bookkeeping), not just
delete + TTL + honor-ephemeral. Size it honestly.

### N2 — Two independent persistence impls, no net
Durability now rests on *both* web (IndexedDB) and native stores being individually correct, with zero
server fallback. Known-issue #1 frames loss as a *user-action* trade; it under-states **bug-induced**
loss — invisible before (server had a copy), now permanent. (Closely related to H1.)

### N3 — Group ephemeral fragmentation
Relay-only "to currently-connected devices" means group members receive different subsets of an
ephemeral exchange by who's online — the conversation fragments per-recipient. Worth a sentence even
with group total-privacy deferred.

### N4 — Legal/compliance dimension
Designed-non-retention has upsides (less to subpoena) and potential obligations (jurisdictional
retention rules). Flag for someone to check.

### N5 — "Read" vs "device-ACK" framing
The ACK avoids the *read*-receipt leak, not the *delivery*-receipt metadata (see M2). The doc conflates
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
with minimal massaging. Ordered by the calibrated severity of the issue they close.

### Edit 1 — Rollout sequencing gate (closes H1)

> Add as a new top-level section, **"## Rollout sequencing (gate)"**, before "## Server as a delivery
> cache".

**Server deletion is the LAST thing enabled, not the first.** Because the device store is the only
fallback after delete-on-delivery, deletion MUST NOT be enabled until the store is proven durable and
IUC restore works. Ship in three reversible stages:

| Stage | Server retention | Client | Gate to advance |
|---|---|---|---|
| **0 — today** | durable archive (unchanged) | RAM-only `okCache` | — |
| **1 — durable store** | durable archive (unchanged) | persist plaintext after decrypt; ACK on persist; **server still keeps blobs** | crash/atomicity tests green; IUC restore green E2E |
| **2 — mark-delivered, retain** | keeps blobs, records ACK-set, marks "delivered"; **no delete yet** | unchanged from stage 1 | delivery telemetry correct in staging; no ACK-before-persist observed |
| **3 — delete-on-delivery** | deletes on complete ACK-set + TTL | unchanged | only after stages 1–2 are stable in production |

Stage 2 is the safety valve: it earns the entire delivery-tracking subsystem and the ACK protocol
**without** the irreversible deletion. Promotion 2 → 3 is a config flip, reversible by re-enabling
retention.

**Persist/ACK atomicity (normative).** The single-use MLS key is consumed at decrypt
(`useSecureMessages.tsx:213-216`); plaintext is only safe once it is **durably committed**. Therefore:
1. decrypt → 2. **durably** write plaintext (await the store's commit) → 3. only then ACK. A crash
between (1) and (2) must be **replayable**: until the plaintext commit is confirmed, retain the source
ciphertext in a local write-ahead buffer keyed by message id, cleared only after the commit. The ACK is
derived from the confirmed plaintext commit, never from the decrypt.

### Edit 2 — Scope gate: single-device DM first (closes H3)

> Add to the model table footnote and to "## Known issues & limitations" #2.

v1 delete-on-delivery is **single-device DM only**. The ACK-set rule requires a complete, current device
roster that exists trivially only for a 2-party, 1-device-each DM. **Groups and multi-device default to
retain** (stage ≤ 2 above) until roster management lands, because a stale roster either deletes a blob a
member still needs (→ data loss) or the **server computes** ACK-set completeness, so a buggy/compromised
server can declare it complete and delete early with no client-side "everyone got it" proof.

### Edit 3 — Reconcile TTL recovery with IUC (closes H2)

> Replace known-issue #3 and the model table's "Offline delivery" cell wording.

IUC restores history **only to an empty store** on a re-provisioned device. A device **offline > TTL**
has a **non-empty store with a middle gap** — IUC does **not** cover it. Be precise: offline-beyond-TTL
is **not** "recovery falls to IUC." Pick one:
- **(3a) Accept the loss.** Re-frame TTL as a **hard data-loss horizon**; surface the gap explicitly
  (a gap marker, not a silent hole); set TTL conservatively (it is now a durability parameter).
- **(3b) Add IUC gap-fill.** Extend IUC with `restore-request { sinceCreatedAt, untilCreatedAt }` for a
  **non-empty** store with a known gap — needs its own trigger (gap via cursor discontinuity, not
  "empty store") and re-auth over the **existing** MLS channel (the SAS/re-join ceremony doesn't fit a
  device that never left). A real IUC-spec addition, not a footnote.

### Edit 4 — Ephemeral generation-gap handling (closes M1)

> Add as a subsection under "## Total-privacy mode", **"### Ratchet-gap safety"**.

Ephemeral messages advance the secret-tree generation yet are relay-only/dropped and reload-dropped, so
a recipient can face a generation jump on the next non-ephemeral message that exceeds MLS's max-skip
window → terminal "rejected". **Pick one and document the bound:**
- **(4a) Epoch reset on session end** — initiator Commits (epoch bump) before the next default message.
- **(4b) Bounded sessions** — cap ephemeral messages below the skip window; force an epoch bump at the
  cap.
Either way, the next non-ephemeral message after **any** missed/forgotten ephemeral generations MUST
still decrypt — a hard invariant.

### Edit 5 — Marker mechanism + crash integrity (closes M4, M5)

> Replace the second paragraph of "### The `🔒 Private chat` markers" and expand issue #7.

**Mechanism — choose explicitly:** **(5a) sent non-ephemeral message (recommended)** — reliable,
symmetric, IUC-carried, ordered by seq/createdAt; accept the sharper boundary-beacon metadata cost. Or
**(5b) local-only write on flag transition** — no extra boundary message, but asymmetric if the
recipient was offline for the first (dropped) ephemeral message. **Crash integrity (normative):** write
`🔓` eagerly on any session-terminating transition; on load, auto-close a dangling `🔒` with a synthetic
`🔓` at the last-known boundary.

### Edit 6 — Metadata-honesty pass (closes M2, M3, N5)

> Replace the "Default mode keeps no durable ciphertext archive…" bullet and the "Not claimed" bullet
> in "## Privacy posture".

Default mode removes the **ciphertext** archive but introduces **new durable metadata** — be explicit
rather than claiming "in-flight only": enumerate what **remains** (membership, device roster, KeyPackage
publishes, the timestamped Commit/Welcome log, and the **per-device/per-message ACK (delivery) graph**, a
compromised server can retain after deleting ciphertext). State that **`ephemeral` is a cleartext
sensitivity beacon** (must be server-readable; wire-distinguishable by design) and that **device-ACK
avoids the *read*-receipt leak, not the *delivery*-receipt leak**.

---

## Testing gaps to add (drafted as concrete cases)

Add to "## Testing strategy". Grouped by layer.

**Unit (core, mock crypto + MemoryStore)**
- **ACK-after-persist ordering (H1):** ACK emitted **only after** the store's plaintext commit resolves;
  no ACK when the commit rejects/throws.
- **ACK never precedes persist under concurrent reload (H1):** reload/teardown interleaved with a
  decrypt-in-flight emits no ACK for an uncommitted message.
- **Write-ahead replay (H1):** with plaintext commit forced to fail after key consumption, the source
  ciphertext is retained and the message is replayable, not lost; retry persists then ACKs.
- **Per-message ephemeral honoring:** receiver honors a message's `ephemeral` flag regardless of local
  toggle.
- **Marker crash integrity (M5):** a stored `🔒` with no `🔓` auto-closes on load; `🔓` written on
  conversation-close/background.

**Transport contract**
- **ACK-set early-delete adversary (H3):** a mock server declaring a complete ACK-set with a device
  missing must not make the client treat history as safely delivered.
- **Ephemeral relay-only:** an ephemeral send carries `ephemeral:true`, is never written via
  `saveMessagePlaintext`, and triggers **no** catch-up fetch.

**ts-mls layer (`react-js`, real core + IndexedDB)**
- **Ratchet-gap survival (M1):** an ephemeral session of **N > max-skip-window** messages, then
  dropped/forgotten (offline or reload), then a normal message → **still decrypts**.
- **History survives server delete:** a default message survives reload from the local store with the
  server blob **already deleted**.
- **Ephemeral gone, markers remain:** ephemeral content absent after reload; `🔒`/`🔓` markers remain and
  IUC carries the markers, not the content.

**Offline > TTL (proves H2 either way)**
- With **(3a):** recipient offline past TTL gets an **explicit gap marker**, and the TTL-expired
  messages are confirmed **unrecoverable** (no empty-store IUC trigger fires for a non-empty store).
- With **(3b):** a non-empty store with a detected gap triggers IUC **gap-fill**, authenticated over the
  existing MLS channel, filled + de-duped by `messageId`.

**Server (separate repo)**
- Blob deleted only after a **complete** ACK-set; an incomplete set retains. (H3)
- TTL deletes an unacked blob; ephemeral blob is never persisted nor served from a cursor.
- ACK/delivery-graph retention is documented and bounded (so M2's new metadata is a reviewed choice).
