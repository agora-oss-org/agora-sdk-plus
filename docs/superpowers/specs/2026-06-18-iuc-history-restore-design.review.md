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

**But there is one real cryptographic flaw**: the **SAS is derived from public KeyPackage data and
truncated to human length, which makes it grindable** — a malicious server can substitute its own device
and still produce a matching code word. That defeats the exact attack the SAS exists to stop. Everything
else is design-hardening (resumability, transfer-gating, framing rollout) and one **cross-spec
contradiction** with the delivery design. None of it is a content-confidentiality break in steady state;
the SAS issue is a *join-time authentication* break.

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

---

## 🔴 High severity

### H1 — The SAS is grindable: it authenticates *public* KeyPackage bytes, truncated to human length

The SAS is specified as *"the first N bits of a hash of B's KeyPackage credential + group id"*
(`:67`, `:159-161`). Its stated job is to stop a malicious server from substituting its own KeyPackage
during the join (`:69`, security table `:125`). **As specified it does not reliably do that.**

The attack it's meant to block, run against this SAS:
1. Server intercepts B's published KeyPackage `KP_B` (public — it relays it) and computes B's expected
   SAS = `truncate_N(H(cred_B ‖ gid))`. All inputs are **public and known to the server.**
2. Server generates its own device `E` and **grinds** candidate KeyPackages `KP_E = {identity:"B",
   sigkey: E_pub, …}` — freely varying `E_pub` / the leaf HPKE key — until
   `truncate_N(H(cred_E ‖ gid)) == truncate_N(H(cred_B ‖ gid))`.
3. Server substitutes `KP_E`. A adds `E`; the Welcome is sealed to `E` → server reads the group and can
   `restore-request` as "B". A and B compare SAS over the phone → **they match** → A proceeds.

For human-length codes (≈ 20–30 bits: 6 digits or 4–6 words), grinding step 2 is ~2²⁰–2³⁰ hashes —
**trivial to feasible offline.** Deriving a SAS from *public, attacker-known* inputs gives the MITM
everything needed to forge a collision.

**The standard fix:** derive the SAS from a **secret established by the join**, not from the public
KeyPackage. In MLS, use the group **exporter secret** (or a key-confirmation value) — i.e. A and B each
compute the code from the shared group secret *after* B joins. Then:
- the inputs are **secret**, so the server can't grind a public value to match;
- crucially, a substituted `E` (not B) means **B never joined and has no group secret**, so B **cannot
  compute any SAS** → the comparison fails by construction, not by luck.

This is a small change in derivation with a large change in guarantee. **Until this is fixed, the SAS
provides a false sense of authentication** and should not be described as defeating server substitution.

---

## 🟠 Medium severity

### M1 — Cross-spec contradiction: the #1 hardening assumes a server archive the delivery design deletes

IUC known-issue #1 proposes a future hardening where *"A includes, per row, the original ciphertext's
server `messageId` so B can confirm existence and ordering against the server's opaque list"* (`:138`).
But the sibling [delivery design](2026-06-18-delivery-and-privacy-modes-design.md) makes the server a
**delete-on-delivery cache** with **no durable message list** to check against — and names IUC as the
*reason* history isn't on the server. So the two specs are aligned in motivation but the IUC **hardening
is incompatible** with the delivery model: there will be no server-side messageId list to attest
against. Either drop that hardening, or define a separate durable "message existed" ledger (which
re-introduces exactly the metadata trail the delivery spec collapses). Flag and reconcile.

### M2 — No resumability: a crash mid-restore strands B with partial history forever

B's trigger is *"re-joined a conversation with server-side history but local store is **empty**"* (`:77`).
If B crashes (or the app restarts) **after** writing some restore rows but before completion, the store
is **non-empty but incomplete** → the empty-store trigger **never re-fires** → B is permanently stuck
with partial history and no path to finish. (This is the IUC twin of the delivery spec's gap-fill gap.)
Needs a **restore-in-progress / restore-complete** state (a marker or transfer-ledger entry) so a
partial restore **resumes or restarts**, rather than being silently abandoned.

### M3 — Transfer must be hard-gated on SAS success; "either ordering" creates a hazard

The spec allows offer-first or request-first (`:78`, `:80`) and places SAS in Act I, transfer in Act II.
Good — but it must state **normatively** that **no transfer payload (chunk/envelope) is sent or accepted
before SAS verification completes.** Otherwise an implementation that lets A send `restore-offer` →
chunks promptly on seeing B re-join could ship plaintext history to an **unauthenticated** (possibly
substituted) device before the human SAS check runs. Make SAS-confirmed a precondition of step 6–7.

### M4 — Missing `transferId`: concurrent/overlapping transfers can interleave

The frames carry `seq/total` but no transfer identifier. If two transfers overlap — B re-requests after
a timeout, or A offers while B requests, or a group later has two sources — chunks from different
transfers **cannot be disambiguated** and reassembly can splice them. Add a `transferId` to every
`iuc/*` frame and bind `seq/total/sha256/ack` to it. (Also lets M2's resume target a specific transfer.)

### M5 — Envelope blob needs access control + normative TTL/delete-on-ack

The envelope variant POSTs an AEAD blob and B GETs it by `blobId` (`:91-93`). Two gaps:
- **Authorization:** the blind server must scope the restore-blob to the **intended recipient device**,
  or any device/member can fetch the (sealed) blob — a metadata/availability leak and a needless
  exposure surface. Specify "fetchable only by B's deviceId."
- **Lifecycle:** #3 says "define a short TTL and delete-on-ack" but leaves it informal. Make it
  normative: blob deleted on B's `restore-ack` **or** TTL, whichever first; A may retry within TTL.
- **Primitive:** name the AEAD (and note that, unlike passphrase backups, `K` is a **full-entropy random
  key**, so **no argon2id/KDF** is needed here — don't accidentally reuse the backup KDF path).

### M6 — `v:2` framing rollout + parser robustness

Introducing `v:2` (`:104-118`) touches the hot path and crosses a trust boundary (it parses
**attacker-influenced** decrypted bytes from peer A):
- **Capability negotiation:** a `v:1`-only peer receiving a `v:2` frame will mis-render or choke. Define
  how a sender knows the peer understands `v:2` (and confirm IUC participants — a fresh re-install (B)
  and an up-to-date peer (A) — are always `v:2`, while legacy `v:1` *chat* still renders on `v:2`
  clients, which the spec covers).
- **Hardened parsing:** the decrypted frame is **untrusted input from A** (attested, not verified).
  Enforce a max frame size, max chunk count, and reject malformed JSON — otherwise a malicious/buggy A
  can OOM or crash B via a giant `restore-chunk` flood or a pathological frame. Pair with the
  rate-limiting already noted for `restore-request`.

---

## 🟡 Notes / smaller points

- **N1 — `sha256` canonicalization is underspecified.** "sha256 over the canonical JSON" (`:94`) only
  works if canonicalization (key ordering, whitespace, Unicode normalization of `plaintext`) is pinned
  identically on both sides; otherwise honest transfers fail the integrity check. Specify the exact
  canonical form.
- **N2 — `createdAt` is server-assigned and the server is untrusted.** Ordering rows by `createdAt`
  (`:84`, `:94`) leans on a value the blind-but-untrusted server set originally. Low impact (A stores
  what it received), but define a **deterministic tiebreaker** (e.g. `messageId`) for equal timestamps.
- **N3 — Consent prompt should show the SAS-verified identity, not a raw `deviceId`.** A's `y/n` (`:80`)
  is only meaningful if A's user is authorizing the *human* they SAS-verified, not an opaque device
  string. Tie the prompt copy to the SAS outcome.
- **N4 — Decline handling / cooldown.** After `restore-declined`, define B's behavior (no auto-retry
  storm; back-off) in addition to the request-side rate limit (`:128`).
- **N5 — At-rest exposure at the sink is real but correctly deferred.** B now writes plaintext history
  durably; that's the Phase-2.5 at-rest story (`:185`) — fine to defer, worth a one-line pointer where
  IUC populates the store.

---

## ✅ What the design gets right

- **The central security argument** (`:31-41`): naming "send a password over the relay" as a *total
  E2EE break* and dissolving it by reusing the re-joined MLS channel is exactly right, and well argued.
- **Envelope encryption** (`:48`, `:89-93`): bulk ciphertext off MLS, only `K` over MLS, blob handled
  like a Welcome/backup — the correct pattern, reusing an existing blind-relay shape.
- **Attested-not-verified honesty** (`:52`, `:132-138`) with a hard **UI-surfacing requirement** — the
  forward-secrecy reason B *cannot* verify is explained, not hidden.
- **Live-overlap handling** (`:94`, `:151`): mandatory dedup by `messageId`, order by `createdAt`,
  late restore rows must not clobber newer live rows — the right invariants, correctly called out.
- **Consent gate, never auto-transfer** (`:50`, `:79-80`) and **rate-limiting** the requester (`:128`).
- **Group history re-exposure and source-selection correctly deferred to DM** (`:139-142`, `:147-149`).
- **Reuse of existing seams** (crypto, blind-relay, swappable store) keeps the new attack surface small
  (`:190-200`).
- **Testing strategy already strong**: SAS determinism, FS proof that B can't read pre-join ciphertext,
  both inline + envelope variants, frame routing.

---

## Decisions to add to the design doc

1. **SAS from the MLS exporter secret, not the public KeyPackage (H1).** Re-derive so only a party that
   actually joined can compute it; a substituted device fails by construction.
2. **Transfer hard-gated on SAS success (M3).** No chunk/envelope sent or accepted before SAS confirms.
3. **Add `transferId` + a restore-in-progress/complete marker (M2, M4).** Make restore resumable,
   idempotent, and safe under overlap.
4. **Reconcile #1 hardening with delete-on-delivery (M1).** Either drop the server-messageId attestation
   or define a deliberate "message existed" ledger.
5. **Envelope blob: recipient-scoped + normative TTL/delete-on-ack + named AEAD, no KDF (M5).**
6. **`v:2` capability negotiation + hardened, bounded frame parser (M6).**

## Testing gaps to add

- **SAS grinding resistance (H1):** a substituted KeyPackage cannot yield a matching code word; with the
  exporter-based SAS, a device that did not actually join **cannot compute any SAS** (the abort signal).
- **Transfer blocked until SAS confirmed (M3):** no plaintext/`K` leaves A before SAS success.
- **Crash mid-restore → completes, not stranded (M2):** a partial store resumes/restarts rather than
  silently staying partial; the empty-store trigger isn't the only path.
- **Overlapping transfers disambiguated by `transferId` (M4):** interleaved chunks from two transfers
  never splice.
- **`v:2` frame to a `v:1` peer is handled (M6):** no crash/garbage; legacy `v:1` chat still renders.
- **DoS bounds (M6):** oversized/malformed frames and chunk floods are rejected; decline triggers
  back-off, not a retry storm.
- **Envelope blob authz (M5):** a non-recipient device is denied the `blobId`; blob deleted on ack/TTL.
- **`sha256` canonicalization stable cross-platform (N1):** identical canonical bytes on web + native.