# IUC — Inanna Underground Chat: history restore on a re-provisioned device

**Status:** draft design — pending review
**Date:** 2026-06-18
**Scope:** A **Phase-3** secure-chat feature: when a user reinstalls/re-provisions a device and re-joins
an existing conversation, restore the **back-history** that forward secrecy makes otherwise
unrecoverable, by transferring **attested plaintext** from a peer device over the **MLS channel the new
device just re-joined** — server-blind, no out-of-band key exchange. Excludes: the durable local message
store (prerequisite — see `2026-06-18`/the replay-fix plan), at-rest encryption of that store
(Phase-2.5), multi-device *live* fan-out, and cross-device key sync. Web + native.

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
| Verbal "code word" | **Short Authentication String (SAS)** for the *re-join*, not a key | Humans can't speak 256 bits. Its real job: A and B compare it out-of-band to confirm the KeyPackage A Adds truly belongs to B, defeating a server that splices in its own device during the join. |
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
3. SAS check (out-of-band): A and B each compute a short code word from B's joining identity key
   (e.g. the first N bits of a hash of B's KeyPackage credential + group id), render it as words/digits,
   and confirm verbally. Mismatch → A aborts the Add. This authenticates the human↔key binding and
   stops a malicious server from substituting its own KeyPackage during the join.
4. B processes the Welcome → joins at the CURRENT epoch. B can now decrypt FUTURE messages, but its
   local store reports 0 historical messages → this is the IUC trigger.
```

### Act II — Return: the transfer (over MLS)

```
5. B detects "re-joined a conversation with server-side history, but local store is empty" and sends
   an MLS control message  iuc/restore-request { conversationId, sinceCreatedAt?: null }.
   (Or A, seeing B re-join, sends iuc/restore-offer first — either ordering works.)
6. A prompts its user: "Restore <conversationId> history to <B's device>?  [y/n]".  On NO → A replies
   iuc/restore-declined and stops. On YES → continue.
7. A reads its durable plaintext store for the conversation and builds the history array:
   [ { conversationId, messageId, senderUserId, createdAt, plaintext }, ... ]   (ascending createdAt)

   Variant INLINE (small history):
     A sends iuc/restore-chunk { seq, total, rows[] } as one or more MLS application messages
     (chunked to stay under a safe app-message size), then iuc/restore-complete { count, sha256 }.

   Variant ENVELOPE (large history):
     A: K = CSPRNG key;  blob = AEAD_encrypt(K, JSON(history))
     A: POST blob to the server as an opaque restore-blob → gets a blobId
     A: sends iuc/restore-envelope { blobId, K, count, sha256 } over MLS   (K only crosses MLS)
     B: GET blob by blobId → AEAD_decrypt(K) → history
8. B validates (sha256 over the canonical JSON), de-duplicates against any rows it already holds
   (by messageId — B may have started receiving LIVE messages the instant it re-joined at step 4),
   and populates its durable plaintext store. B sends iuc/restore-ack { count }.
9. Done. B renders full history from its store; live messages continue uninterrupted.
```

### Wire framing (the typed application-message payload)

Today a decrypted application message is raw UTF-8 chat text (after unpadding). IUC requires a
discriminator so control traffic can share the channel:

```jsonc
// the plaintext INSIDE the MLS application message (before padding), v2 framing:
{ "v": 2, "kind": "chat", "text": "hello 💜" }
{ "v": 2, "kind": "iuc",  "iuc": { "type": "restore-request" | "restore-offer" | "restore-declined"
                                          | "restore-chunk" | "restore-envelope" | "restore-complete"
                                          | "restore-ack",
                                   /* type-specific fields per Act II */ } }
```

- `v:1` (legacy raw text) stays readable for back-compat; new sends emit `v:2`.
- The chat hooks route `kind:"chat"` to the message list and `kind:"iuc"` to the IUC state machine.
  Control messages are **never** rendered as chat and **never** stored as history.
- The server-relayed `restore-blob` (envelope variant) is opaque base64, stored/relayed exactly like a
  Welcome or passphrase backup; it carries no plaintext and no `K`.

## Security analysis

| Adversary | Outcome |
|---|---|
| **Blind server** (relays everything) | Sees only: KeyPackages, Commit/Welcome, MLS-encrypted control messages, and (envelope) an AEAD blob. Never plaintext, never `K`, never the SAS. Unchanged blindness. |
| **Network MITM on the join** | SAS comparison (Act I.3) detects a substituted KeyPackage; A aborts. Without SAS, a server-substituted device could join and *request* history — SAS is the gate. |
| **Network MITM on the transfer** | Payload/`K` ride MLS (authenticated + confidential); tampering breaks the MLS auth tag → dropped. The envelope blob is AEAD-sealed; tampering fails decryption. |
| **Malicious peer A** | A can **omit or fabricate** history (see Known Issues #1). IUC does not defend B against a dishonest *source* — only against the network/server. Consent (A.6) bounds *which* user can be asked. |
| **Abusive requester** | Repeated `restore-request` is rate-limited and always gated by A's `y/n`; B cannot pull history without a human yes on A. |

## Known issues & limitations

1. **Attested, not verified.** B trusts A's plaintext. Because forward secrecy deleted the old
   message keys, B *cannot* re-derive them to check A's claims against the server's old ciphertext.
   A could silently drop or invent messages. **Acceptable** for a user's own second device or a DM
   peer; **must be surfaced in UI** ("history restored from <A>, not independently verified"). A
   future hardening could have A include, per row, the original ciphertext's server `messageId` so B
   can at least confirm *existence and ordering* of rows against the server's opaque list (not their
   content).
2. **Group-history privacy.** Re-handing full history to a re-joining member can re-expose messages
   from members who have since **left**, or content others did not expect re-shared. Fine for **DM**
   (current focus). Before group support: policy decision (transfer only messages from epochs the
   member was present for? only since their last membership? require all-member consent?).
3. **Plaintext in transit (by necessity).** The whole point is moving *plaintext* history; it is
   E2EE in transit, but it *is* the cleartext crossing the wire (inside MLS). The envelope blob at
   rest on the server is AEAD-sealed, but the server holds it until GC — define a **short TTL** and
   delete-on-ack.
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
   peers that only emit `v:1` during rollout.
8. **SAS UX.** The code word must be derived deterministically from the joining key + group context on
   *both* sides and rendered identically (wordlist/locale). A weak/rushed verbal check is the practical
   soft spot — the cryptography is only as strong as the human comparison.
9. **No availability guarantee.** If no peer holding the history is ever online/consenting, B simply
   never recovers it. IUC is best-effort restoration, not a backup service. (The passphrase
   `exportBackup`/`importBackup` path remains the user-controlled durable backup.)
10. **Re-provision ≠ multi-device.** This restores history to a device that *replaces* a lost one. It
    is not live multi-device sync (two active devices for one user receiving the same stream); that's a
    separate Phase-3 item with its own key-management story.

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
- **SAS:** deterministic derivation produces identical strings on both sides for a given joining
  key+group; a substituted KeyPackage yields a different string (the abort signal).

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
