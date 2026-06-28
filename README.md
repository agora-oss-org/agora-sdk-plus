# Agora SDK Plus 🌸

*A little home for the lovely extra things your Agora app deserves.* 💝

Agora SDK Plus is where **additive, Agora-only** features live — the capabilities that have **no
upstream [Replyke](https://github.com/replyke/monorepo) counterpart**, kept tucked safely out of the
[`@agora-sdk/*`](https://github.com/jenova-marie/agora-sdk) fork so that fork can stay a tiny,
documented little divergence from upstream. 🪶

Everything here is original work, designed to **drop into an Agora/Replyke app** and feel like it
always belonged. Pick the rooms you want; leave the rest. 🏡

---

## ✨ The features (pick a room)

Each feature is its own package group with a cozy guide of its own — start there:

| | Feature | What it gives you | Guide |
|---|---|---|---|
| 🔐 | **Secure Chat** | Client side of Agora's end-to-end-encrypted messaging (MLS / RFC 9420). The server stays *blind* — all crypto lives here behind a swappable seam. | [`docs/SECURE-CHAT.md`](docs/SECURE-CHAT.md) |
| 🌷 | **Social Graph** | The community-as-a-commons lenses — Weather, Constellation, Neighborhood, Transparency — rendered with care, never mined. | [`docs/SOCIAL.md`](docs/SOCIAL.md) |
| 🔑 | **Auth ergonomics** | Black-box OAuth for web/MPA apps: a callback that waits for real persistence, a clean auth-ready signal, a logout that *actually* logs out, and stale-session self-heal. | [`docs/AUTH.md`](docs/AUTH.md) |

> 🌿 **A note on independence.** Secure Chat and Social are fully **standalone** — they take everything
> they need (`baseUrl`, access token) as plain inputs and have *no* code dependency on the SDK. **Auth
> ergonomics** is the one gentle exception: it peer-depends on `@agora-sdk/react-js` because its whole
> job is coordinating with the SDK's own auth session. (More on that in [`CLAUDE.md`](CLAUDE.md).)

## 📦 The packages

Each feature group mirrors the SDK's **core + platform** shape so it all feels familiar:

```
secure-chat   @agora-sdk/secure-chat-{crypto,core,react-js,react-native,expo}
social        @agora-sdk/social-{core,react-js,react-native,expo}
auth          @agora-sdk/auth-react-js   (web only)
```

Full per-package roles live in each feature's guide above, and the package graph + seams are drawn out
in [`ARCHITECTURE.md`](ARCHITECTURE.md). 🗺️

## 🛠️ Develop

```bash
pnpm install
pnpm run build-all     # all feature packages, in dependency order (dual ESM + CJS; some web pkgs are ESM-only)
pnpm run typecheck
pnpm test              # unit suite (vitest) — fully mocked, no server needed 💚
```

Each feature's guide documents its own opt-in **e2e** flow (these need a running
[agora-server](https://github.com/jenova-marie/agora-server) and are skipped by default, so `pnpm test`
and CI stay server-free).

## 🧩 How this all fits together

- **[agora-server](https://github.com/jenova-marie/agora-server)** — the API: the blind MLS Delivery
  Service + the social graph endpoints. Owns the wire contract (`@agora-server/contract`).
- **[agora-sdk](https://github.com/jenova-marie/agora-sdk)** — the Replyke fork; a sibling SDK your app
  runs alongside these features.
- **agora-sdk-plus** (this repo, hi! 👋) — the additive client layer: crypto, transport, hooks, and
  React components.

For the deeper map: [`CLAUDE.md`](CLAUDE.md) (architecture prose), [`ARCHITECTURE.md`](ARCHITECTURE.md)
(diagrams), and [`STATUS.md`](STATUS.md) (current state). 📖

## 💛 License

[Apache-2.0](LICENSE). Original Agora work, made with care — not affiliated with Replyke.
