# MLS Exporter on the `SecureChatCrypto` seam (`exportSecret`)

**Status:** approved design — ready for an implementation plan
**Date:** 2026-06-20
**Scope:** A small, isolated **prerequisite** for IUC history restore: expose RFC 9420's **MLS Exporter**
through the `SecureChatCrypto` interface so a later layer can derive a Short Authentication String (SAS)
from the post-join epoch secret. **Client-only** — no server, contract, wire, hook, provider, or
repository change. **Out of scope (deferred to the IUC feature):** the SAS derivation itself, its
label/length/encoding choices, human rendering (wordlist/digits/locale), and any consent/verification UX.

## Goal

The IUC design (`docs/superpowers/specs/2026-06-18-iuc-history-restore-design.md`) makes the SAS — the
out-of-band code A and B compare to confirm the device that joined is genuinely B's — derive from the
**post-join MLS exporter secret**, *not* from a public KeyPackage (which the blind server relays and
could grind a collision against). That security property is load-bearing: a server-substituted device
that did not truly join the epoch cannot compute *any* matching SAS, so the check fails by construction.

To build that SAS, the crypto seam must first expose the exporter. Today it does not. This spec adds the
one primitive; the SAS is built on top of it later, with IUC.

## Why this is a clean, low-risk addition

- **ts-mls already ships the primitive.** `mlsExporter(exporterSecret, label, context, length, cs)` is a
  public export, and the current-epoch `exporter_secret` lives on `ClientState.keySchedule`. The real
  implementation is a thin pass-through, not new cryptography.
- **The mock already has a per-group secret** that travels inside the Welcome (so cross-instance joins
  share it). A deterministic derivation over that secret reproduces the exporter's *structural*
  properties — same group ⇒ same output, non-member ⇒ different — which is exactly what the seam-contract
  tests need.
- **Only two implementors.** `SecureChatCrypto` is implemented by `mock-crypto.ts` and `ts-mls/crypto.ts`
  only; the RN/Expo packages are Phase-3 stubs that do not implement the interface, and agora-server
  consumes the mock (updated here). Adding a method breaks no other build.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Scope | **Just the seam primitive** (exporter); SAS deferred to IUC | True prerequisite; isolated, no UX entanglement. The security property is fully testable at the primitive level (determinism, domain-separation, group-binding, epoch-binding). |
| Which primitive | **General MLS Exporter** (`mlsExporter`), not the Epoch Authenticator | The IUC spec is written around the exporter secret; it is reusable for any future domain-separated, group-bound secret; and `label`+`context` binding lets the SAS be version- and transfer-bound. An epoch-authenticator-equivalent is derivable from the exporter with a fixed label, not vice-versa. |
| Signature | `exportSecret(group, label: string, context: Uint8Array, length: number): Promise<Uint8Array>` | Mirrors ts-mls/RFC 9420 faithfully; no narrowing that would force a breaking change when IUC needs the full primitive. |
| Failure mode | **Fail closed** — unknown/not-joined group throws; `length ≤ 0` throws | Matches the existing `lookupGroup` contract; never returns a zero/empty/partial secret. |
| Secret hygiene | The raw `exporter_secret` is **never** returned, logged, or serialized into an error | Per CLAUDE.md §1; only the *derived, domain-separated* output crosses the method boundary. |

## Architecture

One method on the existing seam; two concrete implementations; no new files beyond tests.

### Interface — `crypto/src/interface.ts`

A new "out-of-band authentication" section on `SecureChatCrypto`:

```ts
/**
 * RFC 9420 MLS Exporter. Derive an application-specific secret from the group's CURRENT-epoch
 * exporter_secret, domain-separated by (label, context, length).
 *
 * The same group + epoch + label + context yields identical bytes on every member of the epoch;
 * a device that did not join the epoch cannot reproduce them. Primary use: deriving the IUC SAS
 * (out-of-band device-authenticity check). The underlying exporter_secret is never exposed.
 *
 * @param group   - A joined group handle (current epoch).
 * @param label   - Domain-separation label (e.g. "iuc-sas-v1"); the caller owns the namespace.
 * @param context - Domain-separation context bytes (may be empty; e.g. a transferId/conversationId).
 * @param length  - Output length in bytes (> 0).
 * @returns The derived secret bytes (length `length`).
 * @throws {Error} If the group is unknown/not joined, or `length <= 0`.
 */
exportSecret(group: GroupHandle, label: string, context: Uint8Array, length: number): Promise<Uint8Array>;
```

### Real implementation — `crypto/src/ts-mls/crypto.ts`

Thin pass-through over ts-mls:

```ts
async exportSecret(group, label, context, length) {
  if (length <= 0) throw new Error("secure-chat: exportSecret length must be > 0");
  const st = this.lookupGroup(group);          // throws "unknown group (not joined)" — fail closed
  const cs = await this.cs();
  return mlsExporter(st.keySchedule.exporterSecret, label, buf(context), length, cs);
}
```

(`buf` is the existing `Uint8Array` → `BufferSource` coercion helper; the exact `keySchedule`
field name is confirmed against ts-mls during implementation.)

### Mock implementation — `crypto/src/mock-crypto.ts`

Deterministic, non-cryptographic, with the structural properties the seam contract requires — derived
from `(group.secret ‖ label ‖ context ‖ epoch)` via the existing FNV/keystream helper expanded to
`length`:

- **Deterministic:** same inputs → same bytes.
- **Domain-separated:** different `label` or `context` → different bytes.
- **Group-bound:** two mock instances joined to the same group share `secret` (it rode the Welcome) →
  identical output; a non-member has a different/absent secret → different (or throws on unknown group).
- **Epoch-bound:** `epoch` is folded into the derivation.
- **Fail-closed:** unknown group throws; `length ≤ 0` throws.

This is never shipped (the mock is test-only); it needs the right *shape*, not real strength.

## Data flow

```
caller (later: IUC SAS)
  │  exportSecret(group, "iuc-sas-v1", context, N)
  ▼
SecureChatCrypto
  ├─ ts-mls:  lookupGroup → keySchedule.exporter_secret → mlsExporter(label, context, N) ─▶ N bytes
  └─ mock:    lookupGroup → keystream(secret‖label‖context‖epoch, N)                      ─▶ N bytes
```

The raw `exporter_secret` never leaves the implementation; only the derived `N` bytes return.

## Error handling

- **Unknown / not-joined group** → throw (reuse `lookupGroup`'s existing message). Never return bytes.
- **`length ≤ 0`** → throw before touching any secret.
- ts-mls enforces its own HKDF max output length; that error surfaces as-is.
- No path logs, throws, or serializes the `exporter_secret` or the derived bytes.

## Testing strategy

- **Mock seam-contract** (`crypto/src/mock-crypto.test.ts`):
  - determinism — same `(group, label, context, length)` → identical bytes;
  - domain-separation — a changed `label` and a changed `context` each change the output;
  - **group-binding** — two instances joined to one group derive identical bytes; a non-member instance
    derives different bytes (or throws on an unknown group);
  - requested `length` honored;
  - fail-closed — unknown group throws; `length ≤ 0` throws.
- **Real-primitive correctness** (`crypto/src/ts-mls/crypto.test.ts`, the established real-ts-mls test
  pattern):
  - two real `TsMlsSecureChatCrypto` clients in the **same** group derive the **same** `exportSecret`
    for the same `(label, context, length)` — the property the SAS depends on;
  - a different `label` → different bytes (domain separation on the real KDF);
  - **epoch-binding** — a Commit that advances the epoch changes the output (proving the SAS is bound to
    the post-join epoch, not a stale one).
- `pnpm test` green and `pnpm run typecheck` clean after the interface gains a method (both implementors
  updated in the same change).

## Out of scope / future (the IUC feature owns these)

- The SAS derivation: the concrete `label` (e.g. `"iuc-sas-v1"`), `context` binding, output `length`,
  and the truncation/encoding to a human-comparable value.
- Human rendering: wordlist vs digits vs emoji, locale-stable encoding, entropy target.
- The consent/verification flow and the "abort + remove device on mismatch" handling.
- The Epoch Authenticator primitive (derivable from the exporter with a fixed label if ever wanted).

## Relationship to existing architecture

- **Unblocks** the IUC SAS (`2026-06-18-iuc-history-restore-design.md`, Act I.4 + Decisions): that design
  mandates an exporter-derived SAS; this method is the missing capability.
- **Extends** the `SecureChatCrypto` seam additively — same dual ts-mls + mock shape as every other
  method; agora-server's mock-based tests keep working once the mock implements it.
- **Touches no** server, contract, wire format, provider, hook, or repository. It is the smallest
  self-contained step toward IUC.
