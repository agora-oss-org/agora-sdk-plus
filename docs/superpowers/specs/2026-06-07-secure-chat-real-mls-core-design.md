# Secure Chat — real MLS core (Phase 2, task 1)

**Status:** approved design, ready for implementation plan
**Date:** 2026-06-07
**Scope:** ROADMAP Phase 2 task 1 (pick + implement the MLS core), built on **ts-mls**, behind the
existing `SecureChatCrypto` interface, with **real** group/device-state serialization wired into the
existing persistence layer, and proven by running the existing e2e with the real core swapped in for
the mock. Excludes backup KDF (task 5), metadata padding (task 6), generation-counter gap detection
(task 1's hardening sub-item — we only confirm it is *reachable*), and native RN/Expo (Phase 3).

## Goal

Replace the throwing web-crypto stub with a **real, RFC 9420 MLS implementation** so the web client
performs genuine end-to-end encryption — not the deterministic mock. The transport, persistence,
provider/hooks, and handshake processing are all built and validated (the foundation e2e passes); the
one remaining placeholder is the crypto itself (`react-js/src/crypto-web.ts` currently returns a stub
whose every method throws). Landing this makes a browser app, against an **unmodified** agora-server,
register a device, start a DM, exchange real MLS-encrypted messages, and survive a reload — with the
server storing only ciphertext.

This is the keystone the ROADMAP flags as task 1 ("decide ts-mls vs OpenMLS→WASM; implement behind
the interface"). Everything downstream (backup UX, padding, native) builds on a working real core.

## Decisions (from brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| MLS library | **ts-mls** (pure TS; `@hpke/core` + `@noble/curves`, no WASM) | Same JS runs on web now and RN/Expo later with no native bridge — fastest web→native path. Functional API maps cleanly onto the seam. Cost: younger/less-audited than OpenMLS; mitigated by keeping it behind the interface so it can be swapped. |
| Default ciphersuite | **Suite 1** — `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` | RFC 9420 mandatory-to-implement baseline; matches the mock's `ciphersuite: 1`; broadest support; no PQ overhead. The wrapper maps the contract's numeric id ↔ ts-mls's string name so more suites can be added later. |
| Packaging | Real core on an **opt-in subpath** `@agora-sdk/secure-chat-crypto/ts-mls`; bare entry + `./testing` stay dependency-free | Only consumers of `./ts-mls` pull in ts-mls + its deps. Matches the ROADMAP "opt-in subpath" plan. |
| Persistence | Implement real `exportGroupState`/`importGroupState` + `exportDeviceState`/`importDeviceState`; **no persistence-layer changes** | The seam, repository, and IndexedDB store already exist; the real core just serializes real `ClientState` instead of the mock's toy state. |
| Join-from-Welcome | The wrapper's Welcome payload is an encoded `{welcome, ratchetTree}` pair (server is blind to payload contents) | The blind server delivers only the one opaque Welcome blob; `joinGroup` needs the ratchet tree. Bundling it in our own payload is fully under our control. Preferred refinement if ts-mls supports it: the standard `ratchet_tree` GroupInfo extension; the bundled pair is the guaranteed fallback. |
| Validation | Parametrize the existing e2e with an injectable crypto factory; run it a second time with the real core | The strongest possible proof: real MLS blobs relayed by the blind server, recipient joining from the Welcome alone, reload-survives — end to end. |

## Architecture

### Where it lives

```
packages/secure-chat/crypto/src/
  interface.ts          (unchanged — the seam)
  mock-crypto.ts        (unchanged — ./testing)
  ts-mls/
    index.ts            createTsMlsSecureChatCrypto(): SecureChatCrypto   (the ONLY public export)
    ciphersuite.ts      number ↔ ts-mls suite-name map (+ the suite-1 default)
    state.ts            serialize/deserialize ClientState, device state, pending KeyPackages
    crypto.ts           the wrapper class implementing SecureChatCrypto over ts-mls
```

- `package.json` `exports` gains `./ts-mls` (esm+cjs, same dual-build pattern as `.` and `./testing`);
  `ts-mls` is added to the package's `dependencies` (pulled only when `./ts-mls` is imported).
- `react-js/src/crypto-web.ts` `createWebSecureChatCrypto()` returns `createTsMlsSecureChatCrypto()`
  instead of the throwing stub.

### The wrapper model (mirrors the mock's shape)

The wrapper holds an in-memory `Map<groupIdHex, ClientState>`. `GroupHandle.mlsGroupId` is the lookup
key; `GroupHandle.epoch` is a `bigint` read from the live `ClientState`. Every method looks up the
live state, performs the ts-mls operation, and stores the returned `newState` back (ts-mls is
immutable — each op yields a new state). This is exactly how `MockSecureChatCrypto` already works, so
the interface and all call sites are unchanged.

## Interface → ts-mls mapping

| `SecureChatCrypto` method | ts-mls | Notes |
|---|---|---|
| `generateDeviceIdentity({deviceId})` | generate a stable Ed25519 **signature keypair** + a basic `Credential` (identity = `deviceId`) | `privateState` = the signature private key (+ format/version tag). The credential identity is the client `deviceId` string. |
| `generateKeyPackages(n)` | `generateKeyPackage({credential, cipherSuite})` × n, **reusing the device signature keypair** | Each call's `privatePackage` (the one-time HPKE init key) is retained in a local **pending-KeyPackage store** keyed by `keyPackageRef`; the ref is the value the server stores and `claimKeyPackage` returns. |
| `createGroup({initialMembers})` | `createGroup` + `createCommit` adding members | Returns `{group, welcomes}`; each Welcome payload = encoded `{welcome, ratchetTree}`. |
| `addMember(group, newDevice)` | `createCommit` with an Add proposal | Returns `{commit, welcomes, epoch}`. |
| `removeMember(group, leaf)` | `createCommit` with a Remove proposal | Returns `{commit, welcomes:[], epoch}`. |
| `encryptMessage(group, pt)` | `createApplicationMessage` | Returns `{ciphertext, epoch}`. |
| `decryptMessage(group, ct)` | `processMessage` | Returns `{plaintext, senderDeviceId, epoch}`; `senderDeviceId` = the sender's credential identity (same convention as the mock). |
| `processWelcome(payload)` | decode `{welcome, ratchetTree}`, find the matching pending KeyPackage by ref, `joinGroup` | Registers the new `ClientState` in the map; returns its `GroupHandle`. |
| `processCommit(group, commit)` | `processMessage` | Advances epoch; stores `newState`. |
| `processProposal(group, proposal)` | `processMessage` (stages the proposal) | No-op-ish until its Commit lands. |
| `export/import GroupState` | serialize/deserialize `ClientState` | See persistence below. |
| `export/import DeviceState` | serialize/deserialize signature keypair + credential + pending-KeyPackage store | Re-hydrates a device after reload. |
| `export/import Backup` | **deferred to task 5** | Implemented as a clearly-marked "not yet — task 5" throw, OR a minimal real-AEAD placeholder; **never** the mock's fake KDF. Decided at plan time; default is the explicit task-5 throw. |

### The two flagged risks (with fallbacks)

1. **Join-from-Welcome-alone.** The recipient must join with only the server-relayed Welcome blob.
   `joinGroup` needs the ratchet tree → the wrapper bundles `{welcome, ratchetTree}` into its Welcome
   payload (the server never parses it). If ts-mls cleanly supports the `ratchet_tree` GroupInfo
   extension, prefer that and drop the bundling. **Not a blocker** — the bundle is fully ours.
2. **`ClientState` serialization.** Needed for persistence. Use ts-mls's own state codec if it exposes
   one; otherwise a small `Uint8Array`-safe CBOR/JSON (de)serializer, hidden entirely behind
   `export/importGroupState`. **Not a blocker** — the state is structured immutable data.

## Security (standard #1)

- Plaintext, group secrets, signature/HPKE **private** keys, `privateState`, and the pending
  KeyPackage privates **never** cross the wire or land in logs/errors. Only ciphertext, public
  KeyPackages, Welcomes/Commits cross the wire.
- Randomness comes from ts-mls / `@noble` / WebCrypto CSPRNGs — never `Math.random()`.
- **Fail closed:** a failed decrypt/verify, unknown group, missing pending KeyPackage, or epoch
  mismatch throws and drops the message — never a plaintext or empty-key fallback.
- The server is blind/untrusted: decode-then-validate every relayed blob; do not trust a
  server-supplied epoch/id without MLS verifying it.
- ts-mls + crypto deps are pinned. No key material in fixtures.
- Generation-counter replay/gap detection is **deferred**, but the design confirms the counter is
  *reachable* from `processMessage` results so task-1-hardening can enforce it without rework.

## Testing

- **Unit (no server)** — `crypto/src/ts-mls/crypto.test.ts`: a two-party real-crypto flow mirroring
  `mock-crypto.test.ts` — createGroup → Welcome → join → encrypt → decrypt; addMember/Commit advances
  epoch; `export/importGroupState` and `export/importDeviceState` round-trips reconstruct a working
  group on a *fresh* wrapper instance; plaintext-hiding (ciphertext never contains the plaintext
  bytes); fail-closed paths (bad ciphertext, unknown group). Suite-1 only.
- **E2e (the proof)** — refactor `e2e/secure-chat.e2e.ts` to take an injectable crypto factory, then
  run the same suite twice: once with `MockSecureChatCrypto` (fast smoke) and once with
  `createTsMlsSecureChatCrypto()` (real MLS). Same env gate (`AGORA_E2E_TEST_DATABASE_URL`); same
  assertions incl. server-blindness and live fan-out; the real-core run additionally proves the
  recipient joins from the Welcome alone.
- `pnpm test` stays green and server-free (unit suite includes the new real-core unit test, which
  needs no server). `pnpm run typecheck` clean.

## Non-goals (explicitly deferred)

- **Task 5** — passphrase backup/restore with a real argon2id KDF + AEAD, and eviction→restore
  recovery. `export/importBackup` is a marked task-5 throw in this slice.
- **Task 6** — ciphertext size-bucket padding; safety-number UI.
- **Generation-counter enforcement** — only *reachability* is confirmed here; enforcement is a
  follow-up.
- **Native** — RN/Expo wiring + hardware keystore (Phase 3).
- **No new runtime deps beyond `ts-mls`** (and its transitive `@hpke/*` / `@noble/*`), pulled only via
  the `./ts-mls` subpath.

## Definition of done

`pnpm test` green (incl. the real-core unit test); `pnpm run typecheck` clean; `pnpm test:e2e` green
for **both** the mock and the real ts-mls core against a running agora-server — register → DM → send →
receive → realtime → reload, recipient joining from the Welcome alone, server storing only ciphertext.
`react-js`'s `createWebSecureChatCrypto()` returns the real core. CHANGELOG `Added` bullet in the same
commit.
