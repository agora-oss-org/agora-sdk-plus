# Review — IUC: history restore on a re-provisioned device

**Reviews:** [`2026-06-18-iuc-history-restore-design.md`](2026-06-18-iuc-history-restore-design.md)
**Also touches:** [`2026-06-18-delivery-and-privacy-modes-design.md`](2026-06-18-delivery-and-privacy-modes-design.md)
**Date:** 2026-06-18
**Reviewer:** design + security pass (E2EE / blind-server model)

## Headline

The **core insight is excellent**: don't invent a key-exchange — reuse the MLS channel B just re-joined,
so plaintext (or an envelope key `K`) rides an already-authenticated, forward-secret, server-blind pipe.
The naive "send a password over the relay" anti-pattern is correctly identified and dissolved. The
durability/availability concerns are honest and mostly correctly scoped to DM.

The one genuine cryptographic finding (the SAS, F-SAS below) is **real but narrow**: it only matters
against a malicious or actively-compromised server, during the rare re-provision window, for a user who
actually performs the verbal check — and it's nearly free to fix at design time. It is **not** an active
hole an outsider can walk through. See the calibration note and the documented downgrade reasoning.

## Ground-truth check (what exists vs what IUC assumes)

| IUC assumes | Reality today |
|---|---|
| a durable plaintext store as **source (A) and sink (B)** | **Does not exist.** Plaintext is RAM-only in `okCache` (`core/src/hooks/useSecureMessages.tsx:149,262`); no `saveMessagePlaintext`. Same load-bearing prerequisite as the delivery spec. |
| `v:2` typed app-message frame | Today the decrypted payload is **raw UTF-8** (`v:1`). Adding `v:2` touches the encrypt/decrypt hot path. |
| a server **restore-blob** endpoint (envelope variant) | Not present; needs a new opaque-blob store/relay like Welcomes/backups. |
| a "re-joined but empty store" **trigger** | No such trigger exists; the hook has no restore state machine yet. |
| KeyPackage publish + Welcome processing | **Exists** (`crypto.processWelcome`, `secure:welcome`, device bootstrap). ✅ |

The takeaway matches the delivery review: IUC is a second story on the not-yet-poured durable-store
ground floor. It cannot be built or tested end-to-end until that store lands.

## Severity calibration (how to read the ratings)

Severities were **recalibrated after review discussion**. Two things drive a rating:

1. **Which axis is it on?**
   - **Durability / correctness (honest-user):** harm happens through ordinary bugs/crashes/normal
     conditions — **no attacker required**. No likelihood discount.
   - **Security (adversary-dependent):** harm requires a malicious or **actively-compromised** server
     (a passive data breach is not enough — the attacker must tamper with live traffic) **and** usually
     a rare window. These get a likelihood discount: in-threat-model, but not everyday.
2. **Cost to fix now** — design-stage, so several fixes are nearly free now and expensive later.

> **Finding IDs are stable identifiers, _not_ the severity.** Some are recalibrated from the first draft;
> the 🔴/🟠/🟡 on each finding and in the table is the severity.

| ID | Axis | Calibrated | Was | One-line reason |
|---|---|---|---|---|
| F-SAS (was H1) | security | 🟠 Medium | 🔴 | Real, but requires an **actively-malicious/compromised server**, a **rare re-provision window**, and a user who **does** the check. Free to fix now. See downgrade note. |
| M2 | correctness | 🟠 Medium | 🟠 | A crash mid-restore strands B with permanent **partial** history; honest-user harm, no fallback. Stays. |
| M1 | cross-spec | 🟡 Note | 🟠 | A **speculative future** hardening (#1) assumes a server archive the delivery spec deletes; reconcile. |
| M3 | security/hygiene | 🟡 Note | 🟠 | "Gate transfer on SAS" is a normative rule to state; same adversary as F-SAS. |
| M4 | robustness | 🟡 Note | 🟠 | Overlap is uncommon **and caught by the sha256 check**; trivial fix (`transferId`). |
| M5 | security/hygiene | 🟡 Note | 🟠 | Blob is **AEAD-sealed**, so missing authz is defense-in-depth + cleanup, not a break. |
| M6 | robustness/hygiene | 🟡 Note | 🟠 | `v:2` rollout + defensive parsing; worst case is a **crash/DoS from your own DM peer**, not a leak. |
| N1–N5 | mixed | 🟡 Note | 🟡 | Smaller points; unchanged. |

Net: **0 High, 2 Medium (F-SAS, M2), the rest notes.** (No High: a failed IUC mostly means "history not
restored" — best-effort by design — rather than corrupting good data; the nearest exception, M2, is
rare².)

---

## 🟠 Medium severity

### F-SAS (was H1) — The SAS is grindable: it authenticates *public* KeyPackage bytes, truncated to human length
**Axis: security (adversary-dependent). Severity: 🟠 Medium — downgraded from 🔴 High.**

**The finding.** The SAS is specified as *"the first N bits of a hash of B's KeyPackage credential +
group id"* (`:67`, `:159-161`); its job is to stop a malicious server substituting its own KeyPackage at
join (`:69`, `:125`). All those inputs are **public** (the server relays the KeyPackage). So a hostile
server can: compute B's expected SAS from public data → **grind** its own substitute KeyPackages until
one's truncated hash collides (≈ 2²⁰–2³⁰ tries for a human-length code — practical) → substitute it → A
and B compare the code → **it matches** → the server's device is in the group and can request history.
Deriving a verbal code from *public, attacker-known* inputs gives the MITM exactly what it needs to forge
a match.

**The fix (small, standard).** Derive the SAS from a **secret established by the join** — the MLS
**exporter secret** (or a key-confirmation value), computed by A and B *after* B joins. Then the inputs
are secret (ungrindable), and a substituted device that never actually joined **cannot compute any SAS at
all** → the check fails *by construction*, not by luck. Same UX; one input changes.

**Why downgraded from High → Medium (documented reasoning).** The original "High" over-weighted the
cryptographic possibility and under-weighted the threat model. On review:

- **It is not an outside-attacker hole.** The adversary is the **server itself**, acting maliciously —
  and not merely *breached* (a database dump or passive read is **not enough**): it must **actively
  tamper with live traffic**, rewriting the KeyPackage in-flight during the join. That is a deep level of
  compromise. *Knock out "server is actively hostile in the live path" and the attack disappears.*
- **The window is rare.** It can only happen *during a re-provision* (new phone, factory reset, lost
  device) — on the order of **once every 1–3 years per user**. The server doesn't have to *time* it (a
  re-join is an API call that flows through it, so it's auto-notified), but it still can't attack a
  specific target on demand without **forcing** a re-provision (e.g. stealing/bricking the phone) — a
  high-effort, targeted move. Rarity protects against *targeted* hits; it does **not** protect against a
  compromised server *opportunistically* skimming whoever happens to re-provision.
- **It only bites the careful user.** A user who skips the verbal check is lost regardless of how the SAS
  is derived; the grindability specifically defeats the user who *does* verify (the person the feature is
  for) — but that narrows the affected population.
- **It stays on the list (not dropped) for two reasons:** (1) the fix is **nearly free now** (change one
  derivation input in code not yet written) and a protocol change later; (2) the whole product promise is
  *"the server is blind and untrusted"* — this is a crack in **exactly that promise**, so a
  *technically-true* E2EE claim becomes *true-with-an-asterisk* if shipped as written. Pay nothing now,
  or footnote the promise later.

**One-liner for the design doc:** *"The verbal-code check has a subtle flaw that lets a malicious server
fake a match; it only matters if our own server is actively compromised and the user re-provisions, and
it's free to fix now — so derive the SAS from the post-join shared secret, not the public KeyPackage."*

### M2 — No resumability: a crash mid-restore strands B with partial history forever
**Axis: correctness (honest-user). Severity: 🟠 Medium — unchanged.** *Why it holds:* the harm hits an
honest user through an ordinary crash and has **no recovery path**; *why not higher:* the trigger is
rare² (a crash *during* the already-rare restore window).

B's trigger is *"re-joined… but local store is **empty**"* (`:77`). A crash **after** writing some
restore rows but before completion leaves the store **non-empty but incomplete** → the empty-store
trigger **never re-fires** → B is permanently stuck with partial history. **Fix:** a
**restore-in-progress / restore-complete** state (marker or transfer-ledger entry) so a partial restore
**resumes or restarts**.

---

## 🟡 Notes / smaller points

### M1 — Cross-spec contradiction: the #1 hardening assumes a server archive the delivery design deletes
**Axis: cross-spec consistency. Severity: 🟡 Note — downgraded from Medium.** *Why down:* it concerns a
**speculative future hardening** (#1's "a future hardening *could*…"), not core function. IUC #1 floats
attesting rows against *"the server's opaque list"* (`:138`), but the delivery design makes the server a
**delete-on-delivery cache with no durable message list**. Reconcile: drop that hardening, or define a
separate durable "message existed" ledger (which re-introduces the metadata trail the delivery spec
collapses).

### M3 — Transfer must be hard-gated on SAS success
**Axis: security/hygiene. Severity: 🟡 Note — downgraded from Medium.** *Why down:* it's a normative
rule to *state*, in the same adversary domain as F-SAS. The spec allows offer-first or request-first
(`:78`, `:80`); state explicitly that **no transfer payload is sent or accepted before SAS verification
completes**, so an implementation can't ship plaintext history to an unauthenticated/substituted device.

### M4 — Missing `transferId`: concurrent/overlapping transfers can interleave
**Axis: robustness. Severity: 🟡 Note — downgraded from Medium.** *Why down:* overlap is uncommon **and**
a spliced transfer is **caught by the `sha256` check** (`:94`) → rejected, not silently corrupting. Still
worth a trivial fix: add a `transferId` to every `iuc/*` frame and bind `seq/total/sha256/ack` to it (it
also gives M2's resume a target).

### M5 — Envelope blob needs access control + normative TTL/delete-on-ack
**Axis: security/hygiene. Severity: 🟡 Note — downgraded from Medium.** *Why down:* the blob is
**AEAD-sealed with a key `K` that never leaves MLS**, so an unauthorized fetch yields ciphertext only —
this is defense-in-depth + cleanup, not a break. Still: scope the blob to **B's deviceId**; make
**delete-on-ack-or-TTL** normative; **name the AEAD** and note `K` is a full-entropy random key, so **no
argon2id/KDF** here (don't reuse the passphrase-backup KDF path).

### M6 — `v:2` framing rollout + parser robustness
**Axis: robustness/hygiene. Severity: 🟡 Note — downgraded from Medium.** *Why down:* worst case is a
**crash/DoS from your own DM peer**, not a confidentiality leak. Two parts: (a) **capability
negotiation** so a `v:1`-only peer isn't sent `v:2` frames (legacy `v:1` chat must still render on `v:2`
clients — the spec covers this direction); (b) **hardened parsing** of the decrypted frame, which is
**untrusted input from A** (attested, not verified) — enforce max frame size / max chunk count / reject
malformed JSON so a malicious-or-buggy A can't OOM/crash B via a chunk flood. Per CLAUDE.md ("validate
then decode everything relayed"), part (b) is a real input-validation requirement even at Note severity.

### N1 — `sha256` canonicalization is underspecified
"sha256 over the canonical JSON" (`:94`) only works if canonicalization (key order, whitespace, Unicode
normalization of `plaintext`) is pinned identically on both sides; otherwise honest transfers fail
integrity. Specify the exact canonical form.

### N2 — `createdAt` is server-assigned and the server is untrusted
Ordering rows by `createdAt` (`:84`, `:94`) leans on a value the untrusted server set. Low impact (A
stores what it received), but define a **deterministic tiebreaker** (e.g. `messageId`) for equal
timestamps.

### N3 — Consent prompt should show the SAS-verified identity, not a raw `deviceId`
A's `y/n` (`:80`) is only meaningful if A's user authorizes the *human* they SAS-verified, not an opaque
device string. Tie the prompt copy to the SAS outcome.

### N4 — Decline handling / cooldown
After `restore-declined`, define B's behavior (no auto-retry storm; back-off) in addition to the
request-side rate limit (`:128`).

### N5 — At-rest exposure at the sink is real but correctly deferred
B now writes plaintext history durably — the Phase-2.5 at-rest story (`:185`). Fine to defer; worth a
one-line pointer where IUC populates the store.

---

## ✅ What the design gets right

- **The central security argument** (`:31-41`): naming "send a password over the relay" as a *total
  E2EE break* and dissolving it by reusing the re-joined MLS channel is exactly right, and well argued.
- **Envelope encryption** (`:48`, `:89-93`): bulk ciphertext off MLS, only `K` over MLS, blob handled
  like a Welcome/backup — the correct pattern, reusing an existing blind-relay shape.
- **Attested-not-verified honesty** (`:52`, `:132-138`) with a hard **UI-surfacing requirement**.
- **Live-overlap handling** (`:94`, `:151`): mandatory dedup by `messageId`, order by `createdAt`, late
  restore rows must not clobber newer live rows.
- **Consent gate, never auto-transfer** (`:50`, `:79-80`) and **rate-limiting** the requester (`:128`).
- **Group history re-exposure and source-selection correctly deferred to DM** (`:139-142`, `:147-149`).
- **Reuse of existing seams** keeps the new attack surface small (`:190-200`).
- **Testing strategy already strong**: SAS determinism, FS proof B can't read pre-join, both variants.

---

## Decisions to add to the design doc

1. **SAS from the MLS exporter secret, not the public KeyPackage (F-SAS).** Re-derive so only a party
   that actually joined can compute it; a substituted device fails by construction. *(🟠 — do it; it's
   free now.)*
2. **Add `transferId` + a restore-in-progress/complete marker (M2, M4).** Make restore resumable,
   idempotent, and safe under overlap. *(🟠 for M2 resumability; 🟡 for the overlap part.)*
3. **Transfer hard-gated on SAS success (M3).** No chunk/envelope sent or accepted before SAS confirms.
4. **Reconcile #1 hardening with delete-on-delivery (M1).** Drop the server-messageId attestation or
   define a deliberate "message existed" ledger.
5. **Envelope blob: recipient-scoped + normative TTL/delete-on-ack + named AEAD, no KDF (M5).**
6. **`v:2` capability negotiation + hardened, bounded frame parser (M6).**

## Testing gaps to add

- **SAS grinding resistance (F-SAS):** a substituted KeyPackage cannot yield a matching code word; with
  the exporter-based SAS, a device that did not actually join **cannot compute any SAS** (the abort
  signal).
- **Crash mid-restore → completes, not stranded (M2):** a partial store resumes/restarts; the empty-store
  trigger isn't the only path.
- **Transfer blocked until SAS confirmed (M3):** no plaintext/`K` leaves A before SAS success.
- **Overlapping transfers disambiguated by `transferId` (M4):** interleaved chunks never splice; a spliced
  transfer is rejected by the sha256 check.
- **`v:2` frame to a `v:1` peer is handled (M6):** no crash/garbage; legacy `v:1` chat still renders.
- **DoS bounds (M6):** oversized/malformed frames and chunk floods are rejected; decline triggers
  back-off, not a retry storm.
- **Envelope blob authz (M5):** a non-recipient device is denied the `blobId`; blob deleted on ack/TTL.
- **`sha256` canonicalization stable cross-platform (N1):** identical canonical bytes on web + native.
