# Agora Social Graph — SDK Integration Guide

> **Audience:** consumers of the `@agora-sdk/social-*` packages, and anyone maintaining them.
> **Canonical types:** `@agora-server/contract` (Apache-2.0, `^0.12.1`) → `social.ts`. The SDK depends
> on it and re-exports the member-facing surface (see §8).
> **Design reference (internal):** `agora-server/docs/AGORA-SOCIAL.md` (the full philosophy corpus).
> **Implemented by:** `@agora-sdk/social-core` (transport + provider + hooks) and
> `@agora-sdk/social-react-js` (web components) — see §9.

---

## Overview — the Garden 🌷

Agora's social graph is **not a product feature, it's a commons**: the graph is pointed back at the
community for the community's health, not mined to target, rank, or sell members. This shapes
everything about the API and how you must render it.

Three member-facing lenses, each a zoom level on the same underlying graph:

| Lens | Path | Shows | Privacy tier | SDK hook | SDK component |
|---|---|---|---|---|---|
| ☀️ **Weather** | `GET /social/weather` | One aggregate warmth scalar for the whole community | Aggregate | `useSocialWeather` | `<CommunityWeather />` |
| ✨ **Constellation** | `GET /social/constellation` | Anonymous cluster blobs — the shape of the community | k-anonymous | `useSocialConstellation` | `<Constellation />` |
| 🏡 **Neighborhood** | `GET /social/neighborhood` | The caller's own named ties + their dyadic brightness | Self-view only | `useSocialNeighborhood` | `<Neighborhood />` |
| 🪟 **Transparency** | `GET /social/transparency` | Which lenses are on + the factors shaping them | Aggregate | `useSocialTransparency` | `<SocialTransparency />` |

All four require `Authorization: Bearer <accessToken>` and are feature-gated (see §7). In the SDK the
token, base URL, and project id are supplied once to `<SocialProvider>`, which also fetches the
transparency config on mount so every hook and component can self-gate.

```tsx
import { SocialProvider } from "@agora-sdk/social-core";
import { CommunityWeather, Constellation, Neighborhood } from "@agora-sdk/social-react-js";

<SocialProvider projectId={projectId} accessToken={accessToken}>
  <CommunityWeather />
  <Constellation />
  <Neighborhood showInteractionsToggle />
</SocialProvider>;
```

---

## 1. Community Weather — `GET /v7/:projectId/social/weather`

One scalar: the aggregate warmth of the project. The only place friction shows publicly — as a dip in
the collective climate, never as a per-person signal.

### Response — `SocialWeather`

```ts
interface SocialWeather {
  value: number | null;   // mean S_p in [0, 1], 2dp. null = no interaction data yet
  band:  WeatherBand;     // bucketed label (see §5)
  trend: number | null;   // value(now) − value(7d ago), 3dp. null = insufficient history
  asOf:  string;          // ISO 8601, server-computed ~1h cache
}

type WeatherBand = "quiet" | "stormy" | "overcast" | "fine" | "sunny";
```

**`band` semantics**

- `"quiet"` is the **no-data sentinel** — `value === null`, community is brand new. Render a gentle
  neutral, not a warning.
- `"stormy"` through `"sunny"` are real warmth readings low → high. `"stormy"` means low warmth
  (collective friction/distance), not danger or abuse — render with the same calm visual language as
  every other band.

**`trend` rendering** — positive → warming, negative → cooling (magnitude rarely exceeds 0.1). Render
a subtle directional cue (a soft arrow, a color shift) — never alarming text.

**SDK** — `useSocialWeather()` → `{ weather, loading, error, refresh }`; returns `weather: null` when
the lens is disabled (no request issued). `<CommunityWeather />` renders a band-tinted glowing orb +
trend cue, and `null` when disabled/loading. The raw `value` is never shown.

### Error codes

| Status | Code | Meaning |
|---|---|---|
| 400 | `social/weather-disabled` | Feature disabled for this project |
| 503 | `social/graph-unavailable` | Neo4j not configured (server env) |

---

## 2. Constellation — `GET /v7/:projectId/social/constellation`

The anonymous **shape** of the community: cluster blobs with a size bucket and warmth tint. No names,
no ids, no member lists. Materialized on a slow seasonal cadence (~every 6 weeks per project) — never
per-request.

### Response — `SocialConstellation`

```ts
interface SocialConstellation {
  blobs:  ConstellationBlob[];        // shuffled — no stable order or identity across epochs
  asOf:   string | null;              // ISO 8601 of the snapshot, or null if not yet computed
  method: "louvain" | "space" | null; // which clustering produced this snapshot (transparency)
}

interface ConstellationBlob {
  size:   BlobSizeBucket;  // coarse count bucket — exact member count is never revealed
  warmth: WeatherBand;     // tint on the same band scale as Weather (warmth-only — no friction)
}

type BlobSizeBucket = "5–9" | "10–19" | "20–49" | "50–99" | "100+";
```

`asOf === null` means the community is new and no snapshot exists yet — render "still forming" (a
nebula), not an error.

### Rendering rules (privacy-critical — see §6)

- **Re-randomize layout on every render.** Blobs carry no stable identity — position must not be
  consistent across loads or a viewer can track changes to a specific cluster over time.
- **Size by bucket, not exact count.** `"10–19"` → a medium blob. Never infer or display an exact count.
- **Tint by warmth band only.** Same warm palette as Weather. Friction never renders as blob color,
  size, or structure — blobs are warmth-only by construction.
- Clusters below k=5 are suppressed server-side; you will never receive them.

**SDK** — `useSocialConstellation()` → `{ constellation, loading, error, refresh }`.
`<Constellation width height />` lays the blobs out with a synchronous **d3-force** pass (collision +
center gravity) over fresh random seeds **every mount / whenever the blob set changes**, renders them
as glowing SVG circles sized by bucket, and shows a nebula when `asOf === null`.

### Error codes

| Status | Code | Meaning |
|---|---|---|
| 400 | `social/constellation-disabled` | Feature disabled for this project |
| 503 | `social/graph-unavailable` | Neo4j not configured |

---

## 3. Neighborhood — `GET /v7/:projectId/social/neighborhood`

The most personal lens: the caller's own named ties, each with its **dyadic brightness** — *your
connection's warmth*, never the friend's global score. Self-view only; no one else can request another
user's neighborhood.

### Query params

| Param | Values | Default |
|---|---|---|
| `includeInteractions` | `true` \| `false` | project default (`neighborhoodIncludeInteractions`, typically `false`) |

When `false` (the default), only deliberate ties appear: follows and mutual connections. When `true`,
recent interaction-only pairs also appear (people you've replied to but don't follow). The response
always echoes the **effective** value so your UI can reflect the actual toggle state.

### Response — `SocialNeighborhood`

```ts
interface SocialNeighborhood {
  ties:                 NeighborhoodTie[];  // sorted brightest-first
  includesInteractions: boolean;            // the effective toggle value for this response
  asOf:                 string;             // ISO 8601, computed live (no server cache)
}

interface NeighborhoodTie {
  userId:     string;            // the friend's profile id
  username:   string | null;
  name:       string | null;
  avatar:     string | null;
  brightness: number;            // dyadic B(me, them) in [0.15, 1.0], 2dp
  tieKinds:   NeighborhoodTieKind[];  // what makes them a tie
}

type NeighborhoodTieKind = "follow" | "connection" | "interaction";
```

**`brightness` — the most important field**

- Range `[0.15, 1.0]`. **0.15 is the floor** — every tie sits at or above it. Intentional: `dim ≠ "bad
  person"`. Dim means "bring care here" — indistinguishable from a brand-new or quietly drifting tie.
- Render as visual warmth (glow, saturation, node size) — **never** as a number, label, or comparison
  to other ties.
- Sorted brightest-first by the server; render in that order.

**`tieKinds`** — `"follow"` (you follow them, or vice-versa; direction not exposed), `"connection"` (a
mutual connection), `"interaction"` (only when `includesInteractions=true`). A pair whose **only**
relationship is friction never appears — friction dims ties, it doesn't create them.

**SDK** — `useSocialNeighborhood()` → `{ neighborhood, loading, error, includeInteractions,
setIncludeInteractions }`; it seeds the toggle from the project default, re-fetches on flip, and syncs
to the server's echoed value. Ties live in component state only and clear on a project/user switch —
never cached across sign-outs. `<Neighborhood showInteractionsToggle />` renders brightness as a
glow/scale treatment (warm "sprout" halo at the floor) and never shows the number.

### Error codes

| Status | Code | Meaning |
|---|---|---|
| 400 | `social/neighborhood-disabled` | Feature disabled for this project |
| 503 | `social/graph-unavailable` | Neo4j not configured |

---

## 4. Transparency — `GET /v7/:projectId/social/transparency`

Returns the project's resolved social config in a member-safe form: which lenses are enabled, decay
half-lives, the k-floor, and whether interactions are included by default. Useful for showing members
the factors that shape their Neighborhood and Weather, and for deciding which nav entries to render.

```ts
// Subset the SDK consumes — full shape is ResolvedSocialConfig in @agora-server/contract/social.ts
interface ResolvedSocialConfig {
  graphEnabled:                    boolean;
  weatherEnabled:                  boolean;
  constellationEnabled:            boolean;
  neighborhoodEnabled:             boolean;
  neighborhoodIncludeInteractions: boolean;
  constellationKFloor:             number;
  warmthHalfLifeDays:              number;
  frictionHalfLifeDays:            number;
  // …plus a privacyTier + corporate-tier analytics flags the member-facing SDK does not use.
}
```

**SDK** — `<SocialProvider>` fetches this once on mount and stores it in context; `useSocialTransparency()`
→ `{ config, loading, error }` reads it without a second request. `<SocialTransparency />` renders a
member-facing "how it works" panel from it.

---

## 5. Rendering guide

### Weather band → color palette

The visual language should feel like **sky/climate**, never like a score or rating.

| Band | Meaning | Suggested palette |
|---|---|---|
| `"quiet"` | No data yet — new community | Soft neutral grey-blue, wispy, "forming" |
| `"stormy"` | Low warmth | Muted slate-blue or steel, overcast |
| `"overcast"` | Below average | Cool grey, soft |
| `"fine"` | Above average | Warm amber-gold |
| `"sunny"` | High warmth | Bright golden-yellow, glowing |

**Key rule:** do not use red for low-warmth bands. Red signals danger/warning; low warmth means "could
use more connection," not "something is wrong." Keep the whole palette in the calm, ambient register.

### Brightness → visual weight (Neighborhood)

`brightness` is continuous in `[0.15, 1.0]`. Map it to visual properties, not text:

| Brightness | Visual rendering |
|---|---|
| 0.85–1.0 | Full glow — warm, bright, close; perhaps a slightly larger node |
| 0.50–0.84 | Normal warmth — comfortably lit |
| 0.25–0.49 | Softly dim — cooling, drifting |
| 0.15–0.24 | At the floor — the "bring care here" / quiet-new state |

**Never show a brightness number.** It is a rendering input, not a score. The floor (0.15) and a
brand-new tie both sit in the last row — visually indistinguishable, and that is correct: "quiet" and
"friction" read the same on purpose.

### Constellation blob layout

- **No fixed positions.** Re-randomize on each render — random initial placement + a gentle force
  simulation (collision + gravity). No blob should have a stable home between page loads.
- **Scale blob radius to size bucket** (`"5–9"` → small … `"100+"` → large). Never label an exact count.
- **Tint by warmth band** with the same palette as Weather. All blobs use warm tones — never a
  cold/friction tint (friction is excluded from Constellation by design).
- **"Still forming" empty state** when `asOf === null` — a wispy nebula, not an error and not an empty list.

### Component names

| Component | Purpose |
|---|---|
| `<CommunityWeather />` | Weather band + optional trend indicator |
| `<Constellation />` | Blob canvas — randomized, tinted |
| `<Neighborhood />` | Named-ties list/graph — brightness-based glow |
| `<SocialTransparency />` | How-it-works disclosure, reads the transparency endpoint |

> `@agora-sdk/social-react-js` ships all four for the web, plus the shared climate palette
> (`bandColors`, `brightnessTreatment`) so host apps can match the warmth vocabulary in their own chrome.

---

## 6. Privacy constraints (the SDK enforces these)

These are not suggestions — they follow from the design's ethical commitments. Violating them could
expose members of vulnerable communities (trans, queer, sex-worker, recovery) to harm. The SDK enforces
each one in its components and covers them with unit tests.

### What you must NEVER render

| Never render | Why |
|---|---|
| A person's **global warmth score (`S_p`)** in any public/list view | `S_p` feeds Weather math only; exposing it per-person is a targeting vector |
| **Friction as visible structure** — a red/dark edge, a flag, a "tension" indicator between two named people | Re-identifying a "red edge" from a known incident is trivial. Friction only **dims** an existing tie (handled server-side, below `brightness`) |
| **Exact cluster sizes** from the Constellation | The size bucket is the protection; an exact count + warmth narrows de-anonymization |
| **Blob identity across loads** — the same blob in the same place every load | Stable layout leaks time-series changes to specific clusters. Re-randomize every render |
| A **comparison score between two members** ("Alice is warmer than Bob") | The Neighborhood is self-view only; dyadic brightness is your tie, not a ranking |
| Any social graph data for **users in a different project** | All endpoints are scoped by `:projectId` server-side; the SDK respects this boundary |

### What the Neighborhood is (and is not)

A **self-view** — the caller sees only their own ties and dyadic brightnesses. It is never visible to
anyone else, and must never be cached across sign-outs or user switches.

### The asymmetry principle

Every rendering ambiguity must resolve toward **kindness**. A dim tie = "needs care," never "bad
person." A low-warmth community = "could use more warmth," never "toxic community." The visual language
should always invite care, never assign blame.

### Sprout state (newcomers)

A member with few or no interactions appears at or near the floor brightness in a neighbor's
Neighborhood. Render this as a **hopeful glow** — a fresh/new, warm-toned treatment — not a lonely-grey
absence. New ≠ lonely ≠ deficient.

---

## 7. Graceful degradation

The social graph is optional and env-gated on the server (`NEO4J_URI`); per-project feature flags
control each surface independently.

| Condition | Server returns | Client behavior |
|---|---|---|
| Neo4j not configured | `503 social/graph-unavailable` | Hide the surface — never show members an error |
| Feature disabled in project config | `400 social/<surface>-disabled` | Hide that surface's entry point |
| Constellation not yet materialized | `200` with `asOf: null` | Render "still forming" / nebula |
| Weather with no data | `200` with `value: null`, `band: "quiet"` | Render the quiet/forming state |

**SDK behavior** — the transport throws a typed `SocialApiError` carrying the HTTP `status` + machine
`code`. The provider treats a `503 social/graph-unavailable` on the transparency fetch as an
all-disabled config (every surface hides). The lens hooks **fail soft**: a degradation error
(`social/graph-unavailable` or any `social/<surface>-disabled`, classified by the exported
`isSocialDegradation(err)`) clears the surface's data and is **not** surfaced via `error` — so a lens
toggled off or a graph that drops mid-session simply disappears rather than erroring at members. Real
failures still propagate through `error`.

---

## 8. TypeScript types quick-reference

All types are owned by `@agora-server/contract` (`^0.12.1`) and re-exported by `@agora-sdk/social-core`,
so import them from either:

```ts
import type {
  SocialWeather, WeatherBand,
  SocialConstellation, ConstellationBlob, BlobSizeBucket,
  SocialNeighborhood, NeighborhoodTie, NeighborhoodTieKind,
  ResolvedSocialConfig,
} from "@agora-sdk/social-core";
```

The `WEATHER_BANDS`, `NEIGHBORHOOD_TIE_KINDS`, and `BLOB_SIZE_BUCKETS` runtime const arrays are also
exported from `@agora-sdk/social-core` if you need to iterate or validate.

---

## 9. Package layout (implemented)

```
packages/social/core         @agora-sdk/social-core         REST client + provider + feature-gated hooks   ✅ shipped
packages/social/react-js     @agora-sdk/social-react-js     web components + renderers (d3-force, palette)  ✅ shipped
packages/social/react-native @agora-sdk/social-react-native re-exports core hooks                           ⏳ stub (see §10)
packages/social/expo         @agora-sdk/social-expo         re-exports core hooks                           ⏳ stub (see §10)
```

- **`social-core`** owns the typed `SocialRestClient`, the `SocialProvider` (auto-fetches transparency),
  the four `useSocial*` hooks, and the `SocialApiError` / `isSocialDegradation` degradation surface.
  Platform-agnostic; no crypto, persistence, or realtime — social data is public/server-side.
- **`social-react-js`** owns the web visual components and the shared climate palette.
- **`social-react-native` / `social-expo`** currently re-export the core hooks, so the **data** works in
  a native app today; the **native visual components** are the next phase (§10).

---

## 10. Next phase — native visual components

The React Native and Expo packages ship the core hooks today (data + feature-gating work natively), but
not yet the native renderings of the four lenses. The next phase implements them so a native app gets
the same drop-in components the web has:

- `<CommunityWeather />`, `<Constellation />`, `<Neighborhood />`, `<SocialTransparency />` for
  React Native — built on RN primitives (`Animated` + `react-native-svg` for the blob field;
  brightness-as-glow via shadow/elevation props), consuming the same `useSocial*` hooks.
- The Expo package wires the same components against Expo's environment.

Both must uphold the **identical** §6 privacy invariants and the §5 palette/brightness mapping (no
brightness numbers, no exact counts, re-randomized blobs, warmth-only tints, sprout state). No server
or `social-core` changes are expected — this is purely additive rendering on top of the existing hooks.

---

*Source: `agora-server/packages/contract/src/social.ts` (types) ·
`agora-server/apps/api/src/routes/social.ts` (endpoint signatures) ·
`agora-server/docs/AGORA-SOCIAL.md` (design corpus). Implemented by `agora-sdk-plus/packages/social/*`.*
