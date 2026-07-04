# @agora-sdk/social-react-js

Web (browser) components for the **Agora social graph** — the community-as-a-commons lenses, rendered
with care rather than mined. Ships `<CommunityWeather />`, `<Constellation />` (d3-force),
`<Neighborhood />`, and `<SocialTransparency />`, plus the shared climate palette. Re-exports
[`@agora-sdk/social-core`](https://www.npmjs.com/package/@agora-sdk/social-core) (transport + provider
+ feature-gated hooks). Pure data — no crypto, no realtime.

## Install

```bash
pnpm add @agora-sdk/social-react-js
# standalone — you pass baseUrl + accessToken + projectId in
```

```tsx
import { SocialProvider } from "@agora-sdk/social-core";
import { CommunityWeather, Constellation, Neighborhood } from "@agora-sdk/social-react-js";

<SocialProvider projectId={projectId} accessToken={accessToken} baseUrl="https://your-api.example.com/v7">
  <CommunityWeather />
  <Constellation />
  <Neighborhood showInteractionsToggle />
</SocialProvider>;
```

`<SocialProvider>` fetches the transparency config on mount so every hook and component **self-gates**
— a disabled lens renders nothing rather than calling its endpoint.

## Full guide

The complete lens-by-lens integration guide — responses, the privacy-critical rendering rules, and
graceful degradation — ships with this package as [`SOCIAL-GRAPH.md`](./SOCIAL-GRAPH.md) and lives in
the repo at
[`docs/SOCIAL-GRAPH.md`](https://github.com/agora-oss-org/agora-sdk-plus/blob/main/docs/SOCIAL-GRAPH.md).
