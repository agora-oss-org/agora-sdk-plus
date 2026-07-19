# @agora-sdk/public-read-react-js

A drop-in, **read-only** Agora comment thread that anyone can read — no account, no token, and **no
Agora SDK installed** on the host page. Built for the case the auth wall otherwise blocks: a blog,
marketing page, or third-party site embedding a conversation for the open internet.

Tokenless by construction. The transport config has no credential field at all, so no code path can
attach one — which matters, because the server answers `/public/*` with a wildcard
`Access-Control-Allow-Origin` and never credentials, and a credentialed cross-origin request would
fail CORS preflight.

## Install

```bash
# No @agora-sdk/* dependency — this package stands alone.
# You supply the API base URL and project id directly.
npm install @agora-sdk/public-read-react-js
```

## Usage

```tsx
import { PublicReadProvider, PublicComments } from "@agora-sdk/public-read-react-js";

export function BlogComments() {
  return (
    <PublicReadProvider
      projectId="11111111-1111-1111-1111-111111111111"
      baseUrl="https://api.example.com/v7"
    >
      {/* Address the anchor by your own key — the entity uuid is generated per install. */}
      <PublicComments foreignId="homepage-comments" />
    </PublicReadProvider>
  );
}
```

Need the data without the chrome? `usePublicEntity`, `usePublicCommentThread`, and
`usePublicComments` are re-exported from `@agora-sdk/public-read-core`.

## Full guide

See [`PUBLIC-READ.md`](./PUBLIC-READ.md), shipped with this package — it covers the addressing
two-step, the auth swap, caching and takedown, and the rules about what you must never render.
