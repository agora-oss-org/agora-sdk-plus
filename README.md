# Agora SDK Plus 🌸

Additive, **Agora-only** SDK features that build on top of
[`@agora-sdk/*`](https://github.com/jenova-marie/agora-sdk) — capabilities with **no upstream
[Replyke](https://github.com/replyke/monorepo) counterpart**, kept out of the `@agora-sdk/*` fork so
that fork stays a tiny, documented divergence from upstream.

Everything here is original work, designed to drop into an Agora/Replyke app and reuse its config.
The features are independent — adopt only the ones you need.

---

## ✨ Features

Each feature is its own package group with a dedicated guide. Start there:

| | Feature | What it provides | Guide |
|---|---|---|---|
| 🔐 | **Secure Chat** | The client side of Agora's end-to-end-encrypted messaging (MLS / RFC 9420). The server stays *blind*; all crypto lives here behind a swappable seam. | [`docs/SECURE-CHAT.md`](docs/SECURE-CHAT.md) |
| 🌷 | **Social Graph** | The community-as-a-commons lenses — Weather, Constellation, Neighborhood, Transparency — designed to be rendered with care rather than mined. | [`docs/SOCIAL-GRAPH.md`](docs/SOCIAL-GRAPH.md) |
| 🔑 | **Auth ergonomics** | Black-box OAuth for web/MPA apps: a callback gated on real persistence, a first-class auth-ready signal, a logout that reliably ends the session, and stale-session self-heal. | [`docs/AUTH.md`](docs/AUTH.md) |

> 🌿 **On independence.** Secure Chat and Social are fully **standalone** — they take everything they
> need (`baseUrl`, access token) as explicit inputs and have *no* code dependency on the SDK. **Auth
> ergonomics** is the sole exception: it peer-depends on `@agora-sdk/react-js` because its purpose is
> to coordinate with the SDK's own auth session. See [`CLAUDE.md`](CLAUDE.md) for the scoped-exception
> rationale.

## 📦 Packages

Each feature group mirrors the SDK's **core + platform** shape for consistency:

```
secure-chat   @agora-sdk/secure-chat-{crypto,core,react-js,react-native,expo}
social        @agora-sdk/social-{core,react-js,react-native,expo}
auth          @agora-sdk/auth-react-js   (web only)
```

Per-package roles are documented in each feature's guide above; the package graph and seams are drawn
in [`ARCHITECTURE.md`](ARCHITECTURE.md). 🗺️

## 🛠️ Develop

```bash
pnpm install
pnpm run build-all     # all feature packages, in dependency order (dual ESM + CJS; some web pkgs are ESM-only)
pnpm run typecheck
pnpm test              # unit suite (vitest) — fully mocked, no server required
```

See [`docs/TESTING.md`](docs/TESTING.md) for the full picture — the three layers (unit / jsdom /
e2e), what each needs, and the env vars that gate the opt-in **e2e** flow. Those require a running
[agora-server](https://github.com/jenova-marie/agora-server) and are skipped by default, so `pnpm test`
and CI stay server-free.

## 🧩 How this fits together

- **[agora-server](https://github.com/jenova-marie/agora-server)** — the API: the blind MLS Delivery
  Service plus the social graph endpoints. Owns the wire contract (`@agora-server/contract`).
- **[agora-sdk](https://github.com/jenova-marie/agora-sdk)** — the Replyke fork; a sibling SDK an app
  runs alongside these features.
- **agora-sdk-plus** (this repo) — the additive client layer: crypto, transport, hooks, and React
  components.

Further reading: [`CLAUDE.md`](CLAUDE.md) (architecture prose), [`ARCHITECTURE.md`](ARCHITECTURE.md)
(diagrams), and [`STATUS.md`](STATUS.md) (current state). 📖

## 💛 License

[Apache-2.0](LICENSE). Original Agora work; not affiliated with Replyke.
