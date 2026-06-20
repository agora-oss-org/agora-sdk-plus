# IUC — Inanna Underground Chat: history restore on a re-provisioned device

**Status:** draft design — review folded in (2026-06-18); SAS now derived from the post-join MLS exporter secret
**Date:** 2026-06-18
**Scope:** A **Phase-3** secure-chat feature: when a user reinstalls/re-provisions a device and re-joins
an existing conversation, restore the **back-history** that forward secrecy makes otherwise
unrecoverable, by transferring **attested plaintext** from a peer device over the **MLS channel the new
device just re-joined** — server-blind, no out-of-band key exchange. Excludes: the durable local message
store (prerequisite — **now shipped** via the replay/history fix), at-rest encryption of that store
(Phase-2.5 — shipped as `createEncryptedStore`), multi-device *live* fan-out, and cross-device key sync.
Web + native.

> **The myth.** Inanna descends to the underworld and is stripped of everything at seven gates; she is
> brought back only because another keeps her memory and restores it to her. A re-provisioned device
> arrives stripped — 0 messages — and is made whole again by a peer who kept the history. Hence **IUC,
> Inanna Underground Chat**: the protocol of descent (loss) and restoration (return).

## Goal

Let a re-provisioned device **B** recover the plaintext history of a conversation it has re-joined,
from a peer device **A** that still holds it, **without** weakening any E2EE invariant: the blind server
never sees plaintext or keys, the transfer is authenticated and forward-secret, and no symmetric secret
ever crosses a channel weaker than MLS.

This is necessary because of **forward secrecy**, not in spite of it. When B's app is gone, its MLS key
material is gone; the conversation's past application-message keys were single-use and deleted by every
member the instant they were used (RFC 9420 secret tree). B re-joining gets B the **current** epoch
keys — enough to read *future* messages — but **nothing** decrypts the past. The only way B can ever
see its history again is for a peer to hand over the **plaintext** it decrypted-once-and-stored (the
durable local message store this builds on). IUC is the secure courier for that hand-off.

## Why the naive "send a password" design is unsafe (and unnecessary)

A tempting sketch: *B generates a random password, sends it to A; A encrypts the history file with it
and sends the file.* This is a **total E2EE break** if the password travels over the blind relay: the
server sees the password, then the ciphertext encrypted under it, and decrypts everything. Sending the
symmetric key over the same channel as the ciphertext provides **zero** confidentiality.

The fix dissolves the problem: **B has just re-joined the MLS group**, so A↔B already share a
forward-secret, authenticated, server-blind channel. Send the payload (or, for large histories, just a
content key) **over MLS**. No separately-exchanged password exists to leak.

## Decisions (from brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Transfer channel | **The re-joined MLS group** (application messages) | Already E2EE, authenticated, server-blind, forward-secret. Reuses everything; nothing new to secure. |
| Key exchange | **None.** No ad-hoc password | A symmetric key sent over the relay = no security; sent over MLS = redundant with sending the payload over MLS. |
| Large payloads | **Envelope encryption**: A encrypts history with a fresh random key `K`, uploads the **ciphertext blob** to the server (opaque, like a Welcome/backup), sends **only `K`** over MLS | Keeps bulk off MLS app-messages while `K` never touches the relay in the clear. |
| Verbal "code word" | **Short Authentication String (SAS) derived from the post-join MLS *exporter secret*** — not from the public KeyPackage, and not a key | Humans can't speak 256 bits. Its real job: A and B compare it out-of-band to confirm the device that joined is really B's, defeating a server that splices in its own device. **Critical:** deriving it from public KeyPackage bytes (which the server relays) is **grindable** — a hostile server can brute-force a substitute KeyPackage whose truncated hash matches (≈2²⁰–2³⁰ tries for a human-length code). The exporter secret is shared only by parties that *actually joined* this epoch, so a substituted device can't compute **any** matching SAS — it fails by construction, not by luck. Same UX; one input changes. |
| Sender consent | A explicit **`y/n` prompt** before any transfer | Human authorization; history is sensitive. Never auto-transfer. |
| What transfers | `{ conversationId, messageId, senderUserId, createdAt, plaintext }` per row | Restores ordering + conversation association + dedup against the live stream B starts receiving on re-join. Text + sender alone loses all three. |
| Trust model | History is **attested by A**, not cryptographically verified | FS deleted the old keys, so B *cannot* verify A's plaintext against the server's old ciphertext. Documented, not hidden. |
| Payload framing | Application messages gain a **typed frame** (`chat` vs `iuc` control) | Control messages (offer/request/chunk/complete) ride MLS alongside chat; the receiver must distinguish them after decrypt. Requires versioning the app-message payload (today it's raw UTF-8). |

## Protocol

Two acts: **Descent** (authenticated re-join) and **Return** (the transfer). Every IUC control message
is an **MLS application message** with a typed frame — the blind server sees only ciphertext.

### Act I — Descent: authenticated re-join

```
1. B reinstalls → generates a fresh KeyPackage → publishes it (standard device bootstrap).
2. B (or A) initiates re-join: A commits an Add of B's KeyPackage → server relays Commit + Welcome.
   (Or B external-joins if the group allows it.)
3. B processes the Welcome → joins at the CURRENT epoch. B can now decrypt FUTURE messages, but its
   local store reports 0 historical messages → this is the IUC trigger.
4. SAS check (out-of-band, AFTER the join): A and B each derive a short code word from the **MLS
   exporter secret** of the new epoch (a label/context-bound export, truncated to human length), render
   it as words/digits, and confirm verbally. Mismatch → A removes the just-Added device and sends/accepts
   **nothing**. Because the exporter secret is shared only by parties that genuinely joined this epoch, a
   server-substituted device cannot compute any matching SAS — the check fails by construction. (Do
   **not** derive the SAS from B's public KeyPackage bytes: the server relays those, so it could grind a
   colliding substitute and forge a match.) **No transfer payload — chunk or envelope — is sent or
   accepted before this SAS check completes** (the M3 hard gate).
```

### Act II — Return: the transfer (over MLS)

```
5. B detects "re-joined a conversation with server-side history, but local store is empty" and sends
   an MLS control message  iuc/restore-request { transferId, conversationId, sinceCreatedAt?: null }.
   (Or A, seeing B re-join, sends iuc/restore-offer { transferId, … } first — either ordering works.)
   `transferId` is a fresh CSPRNG id bound to EVERY frame of this transfer (request/offer/chunk/
   complete/envelope/ack), so overlapping or retried transfers can't interleave and a resume has a target.
6. SAS gate (Act I.4 must have confirmed). A prompts its user — showing the **SAS-verified human
   identity**, not a raw deviceId: "Restore <conversationId> history to <verified peer>?  [y/n]".
   On NO → A replies iuc/restore-declined and stops; B **backs off** (no auto-retry storm). On YES →
   continue. A sends NO payload until SAS has confirmed.
7. A reads its durable plaintext store and builds the history array, ordered by **(createdAt, messageId)**
   — messageId is the deterministic tiebreaker, since `createdAt` is server-assigned and untrusted:
   [ { conversationId, messageId, senderUserId, createdAt, plaintext }, … ]

   Variant INLINE (small history):
     A sends iuc/restore-chunk { transferId, seq, total, rows[] } as one or more MLS application
     messages (chunked under a safe app-message size), then iuc/restore-complete { transferId, count, sha256 }.

   Variant ENVELOPE (large history) — server contract SETTLED 2026-06-20, see "ENVELOPE — settled
   server contract" below and the integration guide
   (`docs/cross-repo/2026-06-20-iuc-restore-blob-implementation-guide.md`):
     A: K = CSPRNG 256-bit key  (FULL entropy — NO argon2id/KDF; do not reuse the passphrase-backup path)
     A: blob = XChaCha20-Poly1305(K, canonicalJSON(history))   (named AEAD; the transfer descriptor — incl.
        transferId, conversationId, fromDeviceId, targetDeviceId, chunkIndex, count — bound as AAD)
     A: POST /restore-blobs { conversationId, fromDeviceId, targetDeviceId, blob } → 201 { blobId, expiresAt }
        (one blob ≤ the server's size cap; a larger history is N independent blobs — chunk, do NOT fall
        back to INLINE, see "Chunking" below)
     A: sends iuc/restore-envelope { transferId, blobId, K, count, sha256 } over MLS   (K only crosses MLS)
     B: register/re-assert its current device first (authz is the USER who owns targetDeviceId — tokens
        are user-scoped, not device-scoped), then GET /restore-blobs/:blobId (non-destructive) →
        AEAD_decrypt(K) → verify sha256 + AAD → persist → then DELETE /restore-blobs/:blobId.
        Backstop: any blob B never DELETEs is swept after a short TTL. Re-GET on a crash before persist.
8. Before writing, B records a **restore-in-progress** marker keyed by `transferId`. B validates (sha256
   over the SAME pinned canonical JSON form — see N1), bounds-checks the frame (max size / max chunk
   count — it is untrusted input from A; see Wire framing), de-duplicates against any rows it already
   holds (by messageId — B may have started receiving LIVE messages the instant it re-joined at step 3),
   populates its durable plaintext store, then writes **restore-complete** and sends
   iuc/restore-ack { transferId, count }.
9. Done. B renders full history from its store; live messages continue uninterrupted. A crash between
   8's start and completion leaves the in-progress marker, so B **resumes/restarts** the transfer
   rather than being stranded with partial history (the empty-store trigger alone would never re-fire).
```

### Wire framing (the typed application-message payload)

Today a decrypted application message is raw UTF-8 chat text (after unpadding). IUC requires a
discriminator so control traffic can share the channel:

```jsonc
// the plaintext INSIDE the MLS application message (before padding), v2 framing:
{ "v": 2, "kind": "chat", "text": "hello 💜" }
{ "v": 2, "kind": "iuc",  "iuc": { "transferId": "…",
                                   "type": "restore-request" | "restore-offer" | "restore-declined"
                                          | "restore-chunk" | "restore-envelope" | "restore-complete"
                                          | "restore-ack",
                                   /* type-specific fields per Act II */ } }
```

- `v:1` (legacy raw text) stays readable for back-compat; new sends emit `v:2`.
- The chat hooks route `kind:"chat"` to the message list and `kind:"iuc"` to the IUC state machine.
  Control messages are **never** rendered as chat and **never** stored as history.
- The server-relayed `restore-blob` (envelope variant) is opaque base64, stored/relayed exactly like a
  Welcome or passphrase backup; it carries no plaintext and no `K`.
- **Capability negotiation:** never send `v:2` IUC frames to a `v:1`-only peer — advertise frame support
  at the device/handshake level and fall back. (Legacy `v:1` chat must still render on a `v:2` client —
  the back-compat direction above.)
- **Hardened parsing (untrusted input):** the decrypted frame is **attested, not verified** input from A,
  so enforce a max frame size, a max chunk count/`total`, and reject malformed JSON — a
  malicious-or-buggy A must not be able to OOM/crash B with a chunk flood. Per CLAUDE.md §1: validate,
  then decode, everything relayed — this holds even though A is a trusted *peer*, because "attested" ≠
  "well-formed".

### ENVELOPE — settled server contract (2026-06-20)

The blob relay the ENVELOPE variant needs is **owned by agora-server** (the blind Delivery Service +
`@agora-server/contract`); the SDK only consumes it. The functional request
(`docs/cross-repo/2026-06-20-iuc-restore-blob-server-request.md`) was **answered** by the integration
guide (`docs/cross-repo/2026-06-20-iuc-restore-blob-implementation-guide.md`), which is the source of
truth. The load-bearing facts the SDK-side ENVELOPE design must honor:

- **Endpoints** (under `{baseUrl}/{projectId}/secure-chat`): `POST /restore-blobs` →
  `201 { blobId, expiresAt }`; `GET /restore-blobs/:blobId` (non-destructive) → the blob; `DELETE
  /restore-blobs/:blobId` → `204`. Binary is base64; bearer auth as everywhere else.
- **Authz is USER-scoped, not device-scoped.** Agora tokens carry a userId, not a per-device credential,
  so the server enforces "caller is the **user who owns** device row `targetDeviceId`." B must therefore
  **register/re-assert its current (non-revoked) device first**, then fetch. Upload requires the caller
  to own `fromDeviceId` (a **required** body field — the server can't infer the sender device from a
  user token) and to be an active member of `conversationId`.
- **Existence oracle is closed.** Missing, expired, and not-the-owner all return the **same 404** on
  GET/DELETE. Treat 404 as "nothing for me"; never branch on it.
- **Lifecycle = explicit DELETE + TTL backstop** (the option this spec recommended). GET is
  non-destructive → decrypt → verify → persist → **then** DELETE. Re-GET on a crash before persist.
- **Limits are per-deployment; do NOT hardcode.** Defaults: 16 MB/blob, 900 s (15 min) TTL, 16
  outstanding A→B, 64 outstanding to B. Discover the size cap empirically: too-large is **HTTP 413 with
  code `secure-chat/restore-blob-too-large`** (key the chunk decision on the code). `429
  common/rate-limited` on quota → back off and retry as B drains earlier chunks. Complete within the TTL.
- **Chunking is client-side; the server is single-blob and stateless about it.** A history past one blob
  is **N independent transfers** (N blobIds, N `K`s, N `sha256`s), reassembled and integrity-checked by
  the SDK against its own descriptor (`transferId`, `chunkIndex`, `chunkCount`). **Do not fall back to
  INLINE for the large case** — that re-introduces the thousands-of-MLS-messages pathology ENVELOPE
  exists to avoid. (One open item to confirm back to the server: that the SDK chunks rather than
  INLINE-falls-back.)
- **Optional realtime nudge:** `secure:restore-blob-available { conversationId }` to B's device socket on
  `/secure` — carries no `blobId`/key, B already learns `blobId` over MLS. Latency nicety only; never
  depend on it.
- **Contract types** ship in `@agora-server/contract` 0.10.0 (additive minor): `UploadRestoreBlobBody`,
  `RestoreBlobModel`, `UploadRestoreBlobResponse`. The SDK type-only re-exports them from
  `core/src/contract/` and adds thin REST methods (`uploadRestoreBlob` / `getRestoreBlob` /
  `deleteRestoreBlob`). **Blocked until 0.10.0 is published** (we are on `^0.9.3`).

## Security analysis

| Adversary | Outcome |
|---|---|
| **Blind server** (relays everything) | Sees only: KeyPackages, Commit/Welcome, MLS-encrypted control messages, and (envelope) an AEAD blob. Never plaintext, never `K`, never the SAS. Unchanged blindness. |
| **Actively-malicious / compromised server on the join** | The exporter-secret SAS (Act I.4) detects a substituted device: one that didn't truly join can't compute the SAS, so the check fails by construction and A aborts. This requires the server to *actively rewrite the KeyPackage in the live path* during the rare re-provision window (a passive breach can't do it) — in-threat-model but high-effort, and free to defend, so we do. **A KeyPackage-derived SAS would be grindable and is explicitly rejected** (see Decisions). |
| **Network MITM on the transfer** | Payload/`K` ride MLS (authenticated + confidential); tampering breaks the MLS auth tag → dropped. The envelope blob is AEAD-sealed; tampering fails decryption. |
| **Malicious peer A** | A can **omit or fabricate** history (see Known Issues #1). IUC does not defend B against a dishonest *source* — only against the network/server. Consent (A.6) bounds *which* user can be asked. |
| **Abusive requester** | Repeated `restore-request` is rate-limited and always gated by A's `y/n`; B cannot pull history without a human yes on A. |

## Known issues & limitations

1. **Attested, not verified.** B trusts A's plaintext. Because forward secrecy deleted the old
   message keys, B *cannot* re-derive them to check A's claims against the server's old ciphertext.
   A could silently drop or invent messages. **Acceptable** for a user's own second device or a DM
   peer; **must be surfaced in UI** ("history restored from <A>, not independently verified"). A
   future hardening could have A include, per row, the original server `messageId`. **Caveat
   (cross-spec):** the delivery design makes the server a *delete-on-delivery cache with no durable
   message list*, so there is nothing to attest *against* once a blob is delivered — this hardening would
   need a separate, deliberate "message existed" ledger, which re-introduces exactly the durable-metadata
   trail that design collapses. Treat it as a trade to decide, not a free add.
2. **Group-history privacy.** Re-handing full history to a re-joining member can re-expose messages
   from members who have since **left**, or content others did not expect re-shared. Fine for **DM**
   (current focus). Before group support: policy decision (transfer only messages from epochs the
   member was present for? only since their last membership? require all-member consent?).
3. **Plaintext in transit (by necessity).** The whole point is moving *plaintext* history; it is
   E2EE in transit, but it *is* the cleartext crossing the wire (inside MLS). The envelope blob at rest
   on the server is AEAD-sealed under a full-entropy random `K` that never leaves MLS, so even an
   unauthorized fetch yields only ciphertext. Still, as defense-in-depth: **scope the blob to B's
   `deviceId`** (server denies any other fetcher), make **delete-on-ack-or-short-TTL normative**, and
   **name the AEAD** (XChaCha20-Poly1305). `K` is full-entropy, so there is **no argon2id/KDF** here —
   don't reuse the passphrase-backup KDF path; a KDF over a random key buys nothing. **Realized by the
   settled contract (2026-06-20):** the scope is enforced as "the **user** who owns `targetDeviceId`"
   (tokens are user-scoped, not device-scoped — equivalent for the threat model), delete-on-DELETE +
   short TTL is the lifecycle, and XChaCha20-Poly1305 is the named AEAD. See "ENVELOPE — settled server
   contract".
4. **Which peer is the source.** In a DM, it's the one other member. In a group, multiple members
   could serve history and may disagree. Phase-3 DM picks the peer; group needs a source-selection
   rule (e.g. longest-tenured online member) — out of scope here.
5. **Transfer ↔ live-stream overlap.** B starts receiving live messages at re-join (Act I.4), before
   the transfer completes. Dedup by `messageId` is **mandatory**; ordering by `createdAt`. Late-arriving
   restore rows must not clobber a newer live row of the same id.
6. **App-message size / chunking.** MLS application messages aren't sized for a giant blob; the inline
   variant must chunk and the receiver must reassemble by `seq/total`. The envelope variant exists
   precisely to avoid large inline transfers.
7. **Framing migration.** Introducing `v:2` typed frames touches the hot path (`encryptMessage` payload
   + `decrypt` unframing). Must stay back-compatible with any `v:1` history already stored and with
   peers that only emit `v:1` during rollout. Add **capability negotiation** (never send `v:2` to a
   `v:1`-only peer) and a **bounded, hardened parser** for the decrypted frame (max size / max chunk
   count / reject malformed JSON) — see Wire framing.
8. **SAS UX.** The code word is derived deterministically from the **post-join MLS exporter secret** on
   *both* sides and must render identically (wordlist/locale). A weak/rushed verbal check is the practical
   soft spot — the cryptography is only as strong as the human comparison. (Derivation source is
   load-bearing: exporter secret, never the public KeyPackage — see Act I.4 and Decisions.)
9. **No availability guarantee.** If no peer holding the history is ever online/consenting, B simply
   never recovers it. IUC is best-effort restoration, not a backup service. (The passphrase
   `exportBackup`/`importBackup` path remains the user-controlled durable backup.)
10. **Re-provision ≠ multi-device.** This restores history to a device that *replaces* a lost one. It
    is not live multi-device sync (two active devices for one user receiving the same stream); that's a
    separate Phase-3 item with its own key-management story.
11. **Resumability (crash mid-restore).** A crash after writing some restore rows but before completion
    leaves a non-empty-but-incomplete store, so the empty-store trigger never re-fires and B is stranded
    with partial history. The `transferId` + restore-in-progress/complete markers (Act II.8) make a
    partial restore **resume or restart** rather than strand.
12. **`sha256` canonicalization.** "sha256 over canonical JSON" only works if the canonical form is
    pinned identically on both sides — key order, whitespace, and Unicode normalization (NFC) of
    `plaintext`. Specify the exact canonicalization, or honest transfers fail the integrity check across
    web/native.

## Testing strategy

- **Unit (core, mock crypto + MemoryStore):** the IUC state machine — request/offer/decline,
  chunk reassembly (`seq/total`), `sha256` mismatch → reject, dedup by `messageId` against
  pre-existing/live rows, `v:1`/`v:2` frame routing (chat vs control never cross over).
- **Hooks (mock):** A's `y/n` consent gate (no transfer on no; transfer on yes), B's trigger
  ("re-joined + empty store" fires exactly once), live-overlap dedup.
- **ts-mls layer (`react-js`):** end-to-end over the real core + IndexedDB — B re-joins at the current
  epoch (cannot decrypt pre-join ciphertext, proving FS), A transfers history over MLS, B's store is
  populated and renders, **server sees only ciphertext/opaque blob** (assert no plaintext on the wire).
  Cover both INLINE and ENVELOPE variants.
- **SAS (exporter-based):** deterministic derivation from the post-join exporter secret produces
  identical strings on both genuinely-joined sides; a device that did **not** actually join **cannot
  compute any SAS** (the abort signal — proving grinding resistance, not just "a different string").
- **Transfer gated on SAS (M3):** no chunk/envelope/`K` leaves A before SAS confirms.
- **Resumability (M2):** a crash after partial writes resumes/restarts via the in-progress marker; the
  empty-store trigger is not the only completion path.
- **`transferId` disambiguation (M4):** interleaved/overlapping transfers never splice; a spliced
  transfer is rejected by the sha256 check.
- **Hardened parser / DoS bounds (M6):** oversized or malformed frames and chunk floods are rejected; a
  `v:2` frame sent to a `v:1`-only peer is handled (no crash) and legacy `v:1` chat still renders; a
  decline triggers back-off, not a retry storm.
- **Envelope blob authz (M5):** a non-recipient device is denied the `blobId`; the blob is deleted on
  ack or TTL; `K` is a full-entropy random key (no KDF).
- **Canonicalization (N1):** identical canonical bytes (key order / whitespace / NFC) on web + native.

## Out of scope / future

- At-rest encryption of the local store (Phase-2.5: argon2id-derived, AEAD-wrapped DB key, auto-lock).
- Group-history transfer policy (#2) and source selection (#4).
- Per-row ciphertext-existence attestation (#1 hardening).
- Live multi-device sync (#10).

## Relationship to existing architecture

- **Builds on** the durable local plaintext message store (the forward-secrecy history fix): IUC's
  source is A's store; its sink is B's store. No store, no IUC.
- **Reuses** the blind-relay pattern for the envelope blob (same shape as Welcomes / passphrase
  backups) and the MLS channel + `SecureChatCrypto` seam for all control traffic.
- **Adds** a `v:2` typed application-message frame (chat vs IUC control) and an IUC state machine,
  most naturally a `useSecureRestore` hook + a small `iuc/` module under `secure-chat/core`.
- **Storage** stays behind the swappable `SecureChatStore` seam; native (Phase 3) puts the envelope
  `K` / restored-store key in Keychain/Keystore, web in a non-extractable WebCrypto key.
- **At-rest (the sink).** B's restored plaintext lands in the durable `SecureChatStore`, which on web
  can now be sealed at rest by wrapping it with `createEncryptedStore` (see
  `2026-06-18-encryption-at-rest-design.md`) — IUC populates the store; the decorator seals it.
