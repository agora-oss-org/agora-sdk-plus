# Agora Social Graph — SDK Integration Guide

> **Audience:** the `@agora-sdk/social` package team.
> **Canonical types:** `@agora-server/contract` → `social.ts` (Apache-2.0, SDK depends on it).
> **Design reference (internal):** `agora-server/docs/AGORA-SOCIAL.md` (the full philosophy corpus).

---

## Overview — the Garden 🌷

Agora's social graph is **not a product feature, it's a commons**: the graph is pointed back at the
community for the community's health, not mined to target, rank, or sell members. This shapes
everything about the API and how you should render it.

Three member-facing lenses, each a zoom level on the same underlying graph:

| Lens | Path | What it shows | Privacy tier |
|---|---|---|---|
| ☀️ **Weather** | `GET /social/weather` | One aggregate warmth scalar for the whole community | Aggregate — safe to publish broadly |
| ✨ **Constellation** | `GET /social/constellation` | Anonymous cluster blobs — the shape of the community | k-anonymous — no names, no member lists |
| 🏡 **Neighborhood** | `GET /social/neighborhood` | The caller's own named ties, with their dyadic brightness | Self-view only — auth required, your ties only |

All three require `Authorization: Bearer <accessToken>`. All three are feature-gated (see
[Graceful degradation](#graceful-degradation)).

---

## 1. Community Weather — `GET /v7/:projectId/social/weather`

One scalar: the aggregate warmth of the project. The only place friction shows publicly — as a dip
in the collective climate, never as a per-person signal.

### Response — `SocialWeather`

```ts
interface SocialWeather {
  value: number | null;   // mean S_p in [0, 1], 2dp. null = no interaction data yet
  band:  WeatherBand;     // bucketed label (see § Rendering)
  trend: number | null;   // value(now) − value(7d ago), 3dp. null = insufficient history
  asOf:  string;          // ISO 8601, server-computed ~1h cache
}

type WeatherBand = "quiet" | "stormy" | "overcast" | "fine" | "sunny";
```

**`band` semantics:**
- `"quiet"` is the **no-data sentinel** — `value === null`, community is brand new. Render as a gentle
  neutral, not a warning.
- `"stormy"` through `"sunny"` are real warmth readings from low to high. `"stormy"` means low
  warmth (collective friction/distance), not danger or abuse — render with the same calm visual
  language as every other band.

**`trend` rendering:**
- Positive → community is warming. Negative → cooling. Magnitude rarely exceeds 0.1 in practice.
- Render as a subtle directional cue (a soft arrow, color shift) — never alarming text.

### Error codes

| Status | Code | Meaning |
|---|---|---|
| 400 | `social/weather-disabled` | Feature disabled for this project |
| 503 | `social/graph-unavailable` | Neo4j not configured (server env) |

---

## 2. Constellation — `GET /v7/:projectId/social/constellation`

The anonymous **shape** of the community: cluster blobs with a size bucket and warmth tint. No
names, no ids, no member lists. Materialized on a slow seasonal cadence (roughly every 6 weeks per
project) — never per-request.

### Response — `SocialConstellation`

```ts
interface SocialConstellation {
  blobs:  ConstellationBlob[];       // shuffled — no stable order or identity across epochs
  asOf:   string | null;             // ISO 8601 of the materialized snapshot, or null if not yet computed
  method: "louvain" | "space" | null; // which clustering produced this snapshot (transparency)
}

interface ConstellationBlob {
  size:   BlobSizeBucket;  // coarse count bucket — exact member count is never revealed
  warmth: WeatherBand;     // tint using the same band scale as Weather (warmth-only — no friction here)
}

type BlobSizeBucket = "5–9" | "10–19" | "20–49" | "50–99" | "100+";
```

**`asOf === null`** means the community is new and no snapshot exists yet — render as "still forming"
(an empty/nebula state), not an error.

### Rendering rules (privacy-critical — see § Privacy Constraints)

- **Re-randomize layout on every render.** Blobs carry no stable identity — position must not be
  consistent across loads or the user can track changes to a specific cluster over time.
- **Size the blobs by bucket, not exact count.** `"10–19"` → draw a medium blob. Never infer or
  display an exact member count.
- **Tint by warmth band only.** Use the same warm-palette mapping as Weather. Friction **never**
  renders as blob color, size, or structure — blobs are warmth-only by construction.
- Clusters below k=5 are suppressed server-side; you will never receive them.

### Error codes

| Status | Code | Meaning |
|---|---|---|
| 400 | `social/constellation-disabled` | Feature disabled for this project |
| 503 | `social/graph-unavailable` | Neo4j not configured |

---

## 3. Neighborhood — `GET /v7/:projectId/social/neighborhood`

The most personal lens: the caller's own named ties, each with its **dyadic brightness** — *your
connection's warmth*, never the friend's global score. Self-view only; no one else can request
another user's neighborhood.

### Query params

| Param | Values | Default |
|---|---|---|
| `includeInteractions` | `true` \| `false` | project default (`neighborhoodIncludeInteractions`, typically `false`) |

When `false` (the default), only deliberate ties appear: follows and mutual connections. When `true`,
recent interaction-only pairs also appear (people you've replied to but don't follow). The response
always echoes the **effective** value so your UI can reflect the actual state of the toggle.

### Response — `SocialNeighborhood`

```ts
interface SocialNeighborhood {
  ties:                 NeighborhoodTie[];  // sorted brightest-first
  includesInteractions: boolean;            // the effective value of the toggle for this response
  asOf:                 string;             // ISO 8601, computed live (no server cache)
}

interface NeighborhoodTie {
  userId:    string;            // the friend's profile id
  username:  string | null;
  name:      string | null;
  avatar:    string | null;
  brightness: number;           // dyadic B(me, them) in [0.15, 1.0], 2dp
  tieKinds:  NeighborhoodTieKind[];  // what makes them a tie
}

type NeighborhoodTieKind = "follow" | "connection" | "interaction";
```

**`brightness` — the most important field:**
- Range is `[0.15, 1.0]`. **0.15 is the floor** — all ties, no matter how fraught, sit at or above
  it. This is intentional: `dim ≠ "bad person"`. Dim means "bring care here" — it is
  indistinguishable from a brand-new tie or a quietly drifting one.
- Render as visual warmth (glow intensity, saturation, node size) — never as a number, label, or
  comparison to other ties' brightnesses.
- Sorted brightest-first by the server; you can render in this order.

**`tieKinds` — relationship hints:**
- `"follow"` — you follow them (or they follow you; direction not exposed).
- `"connection"` — a mutual connection (both follow each other or an explicit connection event).
- `"interaction"` — only visible when `includesInteractions=true`; these are people you've recently
  interacted with (replied, reacted) but don't have a deliberate tie with.
- A pair whose **only** relationship is friction (reports/blocks) never appears. Friction dims ties,
  it doesn't create them.

### Error codes

| Status | Code | Meaning |
|---|---|---|
| 400 | `social/neighborhood-disabled` | Feature disabled for this project |
| 503 | `social/graph-unavailable` | Neo4j not configured |

---

## 4. Transparency endpoint — `GET /v7/:projectId/social/transparency`

Returns the project's resolved social config in a member-safe form: which features are enabled,
decay half-lives, k-floor, and whether interactions are included by default. Useful for showing
members what factors shape their Neighborhood and Weather. Requires auth.

```ts
// Response shape (subset — see ResolvedSocialConfig in @agora-server/contract/social.ts)
{
  graphEnabled:                  boolean;
  weatherEnabled:                boolean;
  neighborhoodEnabled:           boolean;
  constellationEnabled:          boolean;
  neighborhoodIncludeInteractions: boolean;
  warmthHalfLifeDays:            number;
  frictionHalfLifeDays:          number;
  constellationKFloor:           number;
}
```

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

**Key rule:** do not use red for low-warmth bands. Red signals danger/warning; low warmth means
"could use more connection," not "something is wrong." Keep the whole palette in the calm,
ambient register.

### Brightness → visual weight (Neighborhood)

`brightness` is a continuous value in `[0.15, 1.0]`. Map it to visual properties, not text:

| Brightness | Visual rendering |
|---|---|
| 0.85–1.0 | Full glow — warm, bright, close; perhaps slightly larger node |
| 0.50–0.84 | Normal warmth — comfortably lit |
| 0.25–0.49 | Softly dim — cooling, drifting |
| 0.15–0.24 | At the floor — the "bring care here" / quiet-new state |

**Never show a brightness number to the member.** It is a rendering input, not a score.
The floor (0.15) and a brand-new tie both sit in the last row — that is intentional. They are
visually indistinguishable, and that is correct: "quiet" and "friction" read the same on purpose.

### Constellation blob layout

- **No fixed positions.** Re-randomize on each render. A canvas/SVG with random initial placement
  + a gentle force simulation (just collision + gravity) works well. No blob should have a stable
  home between page loads.
- **Scale blob radius to size bucket** — use the midpoint of the bucket as a rough guide
  (`"5–9"` → small, `"10–19"` → medium, …, `"100+"` → large). Never label an exact count.
- **Tint by warmth band.** Use the same palette as Weather. All blobs use warm tones — never a
  "cold/friction" tint, because friction is excluded from Constellation by design.
- **"Still forming" empty state.** When `asOf === null`, show a wispy nebula or gentle particle
  field — not an error state and not an empty list.

### Suggested component names

Following the package naming convention (`@agora-sdk/social`):

| Component | Purpose |
|---|---|
| `<CommunityWeather />` | Weather band + optional trend indicator |
| `<Constellation />` | Blob canvas — randomized, tinted |
| `<Neighborhood />` | Named-ties list/graph — brightness-based glow |
| `<SocialTransparency />` | How-it-works disclosure, reads from the transparency endpoint |

---

## 6. Privacy constraints (the SDK must enforce these)

These are not suggestions — they follow from the design's ethical commitments. Violating them
could expose members of vulnerable communities (trans, queer, sex-worker, recovery) to harm.

### What you must NEVER render

| Never render | Why |
|---|---|
| A person's **global warmth score (`S_p`)** in any public/list view | `S_p` is an aggregate fed to Weather math only; exposing it per-person is a targeting vector |
| **Friction as visible structure** — a red/dark edge, a flag, a "tension" indicator between two named people | Friction quarantine: re-identifying a "red edge" from a known incident is trivial. Friction only **dims** an existing Neighborhood tie (below `brightness`, handled server-side) |
| **Exact cluster sizes** from the Constellation | The size bucket is the privacy protection; an exact count plus warmth narrows de-anonymization |
| **Blob identity across loads** — the same blob in the same place every load | Stable layout leaks time-series changes to specific clusters. Re-randomize every render |
| A **comparison score between two members** ("Alice is warmer than Bob") | The Neighborhood is self-view only; the dyadic brightness is your tie, not a ranking of friends |
| Any social graph data for **users in a different project** | All social endpoints are scoped by `:projectId` at the server; the SDK must respect this boundary |

### What the Neighborhood is (and is not)

The Neighborhood is a **self-view** — the caller sees only their own ties and dyadic brightnesses.
It is not visible to anyone else, and the SDK must never expose one user's Neighborhood to another.
Do not cache Neighborhood data across sign-outs or user switches.

### The asymmetry principle

Every rendering ambiguity must resolve toward **kindness**. A dim tie = "needs care," never
"bad person." A low-warmth community = "could use more warmth," never "toxic community." The
visual language should always invite care, never assign blame.

### Sprout state (newcomers)

A member with few or no interactions will appear at or near the floor brightness in a neighbor's
Neighborhood. Render this as a **hopeful glow** — a fresh/new visual treatment — not a lonely-grey
absence. New ≠ lonely ≠ deficient. The sprout treatment is time-limited and should be warm-toned.

---

## 7. Graceful degradation

The social graph is optional and env-gated on the server (`NEO4J_URI`). Per-project feature flags
control each surface independently.

| Condition | Server returns | Recommended client behavior |
|---|---|---|
| Neo4j not configured | `503 social/graph-unavailable` | Hide the surface entirely — do not show an error state to members |
| Feature disabled in project config | `400 social/<surface>-disabled` | Hide that surface's entry point (tab, nav item, widget) |
| Constellation not yet materialized | `200` with `asOf: null` | Render "still forming" / nebula state |
| Weather with no data | `200` with `value: null`, `band: "quiet"` | Render the quiet/forming state |

Check the transparency endpoint (`GET /social/transparency`) at app init to know which surfaces
are enabled before rendering nav entries.

---

## 8. TypeScript types quick-reference

All types are exported from `@agora-server/contract` (the SDK depends on it). Import:

```ts
import type {
  SocialWeather,
  SocialNeighborhood,
  SocialConstellation,
  NeighborhoodTie,
  NeighborhoodTieKind,
  ConstellationBlob,
  WeatherBand,
  BlobSizeBucket,
  ResolvedSocialConfig,
} from "@agora-server/contract";
```

The `WEATHER_BANDS`, `NEIGHBORHOOD_TIE_KINDS`, and `BLOB_SIZE_BUCKETS` const arrays are also
exported if you need to iterate or validate at runtime.

---

## 9. Package layout (proposed)

Following the agora-sdk-plus convention (`packages/<feature>/{core,react-js,...}`):

```
packages/social/core         @agora-sdk/social-core         typed API clients + hooks (platform-agnostic)
packages/social/react-js     @agora-sdk/social-react-js     React components + renderers (web)
packages/social/react-native @agora-sdk/social-react-native RN components
packages/social/expo         @agora-sdk/social-expo         Expo variant
```

`social-core` owns the fetch logic, response shaping, and feature-gate helpers. Platform packages
own the visual components. No crypto is involved — this is purely data + rendering.

---

*Source: `agora-server/packages/contract/src/social.ts` (types) ·
`agora-server/apps/api/src/routes/social.ts` (endpoint signatures) ·
`agora-server/docs/AGORA-SOCIAL.md` (design corpus). Last updated: 2026-06-16.*
