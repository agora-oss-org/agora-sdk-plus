# Secure Chat — SDK Roadmap (Phase 2+)

> **Context:** the server-side MLS Delivery Service is **complete** (`agora-server` Phase 1 — blind
> DS, opaque ciphertext, membership enforcement, commit ordering, socket.io `/secure` namespace).
> Everything below is **client-side SDK work** in this repo (`agora-sdk-plus`).
>
> Server reference: `agora-server/apps/api/src/routes/secure-chat.ts`,
> `db/schema/secure-chat.ts`, `realtime/secure-socket.ts`.
> Design doc: `agora-server/docs/superpowers/specs/` (the approved Phase 1 plan).

---

## Package layout

| Package | Role |
|---|---|
| `@agora-sdk/secure-chat-crypto` | **The `SecureChatCrypto` seam** — interface (main entry) + `MockSecureChatCrypto` (`./testing` subpath). Apache-2.0, dependency-free. The real MLS core lands here in Phase 2. |
| `@agora-sdk/secure-chat-core` | Platform-agnostic transport (REST + `/secure` socket) + `SecureChatProvider` + hooks; crypto injected. |
| `@agora-sdk/secure-chat-react-js` | Web (Phase 2): real crypto + IndexedDB key storage. |
| `@agora-sdk/secure-chat-react-native` / `-expo` | Native (Phase 3 stubs). |

**Rule:** the crypto seam lives here in the SDK. The wire contract stays in `@agora-server/contract`
(Apache-2.0, publishable). The SDK depends on the contract — never the reverse.

---

## Phase 2 — Web client (real crypto behind the interface)

The server DS needs **no changes**; any gap feeds back as an additive migration.

- [ ] **Pick + implement a real `SecureChatCrypto`.** Decide between:
  - **ts-mls** — pure TypeScript, same JS on web/RN/Expo, younger/less-audited
  - **OpenMLS → WASM** — audited Rust core, but RN/Expo need a native bridge

  Implement in `packages/secure-chat-crypto` behind the existing `SecureChatCrypto` interface
  (a new opt-in subpath so the heavy core isn't pulled in by default). The mock stays on
  `./testing` for tests in this repo and in the server's integration suite.

- [ ] **Key storage (IndexedDB).** Persist device identity + per-group MLS state via
  `exportGroupState`/`importGroupState`. Handle Safari/`clear browsing data` eviction gracefully
  (warn user before state is unrecoverable).

- [ ] **KeyPackage replenishment loop.** Publish a batch on device registration; top up on the
  `secure:key-packages-low` socket signal and via the `/key-packages/count` polling endpoint.

- [ ] **Handshake processing.** On connect, pull `GET /devices/:id/handshakes?since=<lastSeq>`
  then live via `secure:welcome` / `secure:handshake`; process Welcomes/Commits in `seq` order;
  buffer application messages whose epoch the client hasn't reached yet.

- [ ] **Passphrase backup UX.** `exportBackup` → `PUT /key-backup` on a schedule; restore on a
  new browser via `GET /key-backup` → `importBackup`. **Enforce a strong KDF** (argon2id,
  conservative params) + a passphrase-strength meter — the server holds the ciphertext blob, so
  a weak passphrase is offline-brute-forceable on DB exfil.

- [ ] **Client-side ciphertext padding** to size buckets, to blunt traffic-shape fingerprinting.

- [ ] **Safety-number / key verification UI** (out-of-band fingerprint compare) for TOFU hardening.

---

## Phase 3 — Native + full multi-device

- [ ] **React Native + Expo.** If on OpenMLS: build the native Rust bridge (uniffi/JSI) + an Expo
  config plugin/dev client. If on ts-mls: mostly "ship the same JS." Use the hardware keystore
  (iOS Keychain / Android Keystore) for key material. The server schema is already multi-device-ready.

- [ ] **Full multi-device.** Multiple `secure_devices` per user as MLS leaves; a device-linking /
  provisioning flow (QR / verification code); cross-device history sync (reuse the passphrase-backup
  mechanism as the history-transfer channel); self-device management (list/revoke) UI.

---

## Future exploration — network-layer privacy (Tor / onion routing)

> **Status: exploratory, not committed.** Revisit after Phase 2 ships — Tor around a chat with no
> working crypto client buys little. Documented so the path and its anti-abuse implications aren't lost.

E2E hides content; it does nothing about **network metadata** (client IP, connection timing, traffic
volume). For a threat model that includes "don't reveal who is talking to this server from where,"
the complement to MLS is **onion routing**.

- [ ] **Serve the API as a Tor hidden service (`.onion`).** Clients reach the server over Tor, so the
  server never learns a real client IP. Mostly an ops concern (a `tor` sidecar); the app is
  transport-agnostic.

- [ ] **Client-side Tor transport** (native Tor, Orbot on Android, or Arti) for clients that opt in —
  independent of whether the server runs a hidden service.

- [ ] **socket.io over Tor.** Confirm long-lived realtime connections behave under Tor's added latency
  (reconnection/backoff, handshake timeouts).

- [ ] **Two ingresses, two rate-limit policies.** Clearnet keeps the IP-keyed limiter as-is; the `.onion`
  gets an **account-keyed + challenge policy** (proof-of-work or CAPTCHA on signup/login; email-keyed
  limits + confirmation gating for unauthenticated surfaces). Additive "onion mode," not a rearchitecture.

  The IP-keyed limiter (`lib/rate-limit.ts`) already uses a pluggable store (in-process / Redis) and
  keys on the real client IP via `RATE_LIMIT_TRUSTED_HOPS`. Behind `.onion`, swap the key to `sub`
  (token claim) for authenticated routes — strictly better than IP (an attacker can't escape it by
  switching networks). The unauthenticated surface (`/auth/*`) is the hard part: see above.

- [ ] **Pairs with ciphertext padding** (Phase 2) — onion routing hides endpoints; padding blunts
  traffic-shape fingerprinting. Together they close most of the metadata gap.

---

## Open decisions (carry-overs from Phase 1)

| # | Decision | Status |
|---|---|---|
| 1 | Channel committer strategy | **DECIDED:** MLS External Commits — a new space member self-adds, relayed by the blind DS. Rejected management-bot (it could decrypt). Schema is channel-ready. |
| 2 | Last-resort KeyPackage | **DEFERRED:** not in v1 (weakens forward secrecy). DS returns `409 key-packages-exhausted`. Revisit if depletion bites. |
| 3 | Epoch validation leniency | **ACCEPTED:** DS only sanity-bounds (`<= currentEpoch + EPOCH_WINDOW`) and linearizes commits optimistically. Clients enforce drop/replay/reorder via MLS generation counters — verify the chosen core does this. |
| 4 | Metadata leakage | **ACCEPTED** (Signal-server model). `secure_conversations.name` is the one deliberate plaintext concession — prefer `null`, carry display name in an E2EE group-info message. Network metadata (IP, timing) is not addressed by E2E. |
| 5 | `secure_handshake_receipts` per-device ack table | **DEFERRED:** Phase 1 is cursor-only. Add only if server-side handshake GC needs it. |

---

*Source: `agora-server/CHAT_TODO.md` (retired 2026-06-16). Server Phase 1 complete.*
