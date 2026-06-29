# @agora-sdk/secure-chat-react-js

Web (browser) build of Agora **secure chat** — the client side of end-to-end-encrypted messaging
(MLS / [RFC 9420](https://www.rfc-editor.org/rfc/rfc9420)). The Agora server stays a **blind delivery
service** (it relays opaque base64 blobs and never sees plaintext); all crypto lives here, behind a
swappable `SecureChatCrypto` seam. This package wires the real **ts-mls** crypto core + IndexedDB
group-state persistence. **ESM-only** (it depends on the ESM-only ts-mls core).

## Install

```bash
pnpm add @agora-sdk/secure-chat-react-js
# standalone — no @agora-sdk/core required; you pass baseUrl + accessToken in
```

```tsx
import {
  SecureChatProvider,
  createWebSecureChatCrypto,
  createIndexedDBStore,
} from "@agora-sdk/secure-chat-react-js";

const crypto = useMemo(() => createWebSecureChatCrypto(), []); // memoize — a fresh instance churns the device
const store = useMemo(() => createIndexedDBStore(), []);

<SecureChatProvider
  projectId={projectId}
  baseUrl={baseUrl}          // e.g. https://api.example.com/v7
  accessToken={accessToken}
  crypto={crypto}
  store={store}
>
  {/* useSecureConversations(), useSecureMessages(), … */}
</SecureChatProvider>;
```

## Full guide

The complete guide — packages, getting started, optional encryption-at-rest, and the opt-in
foundation e2e — ships with this package as [`SECURE-CHAT.md`](./SECURE-CHAT.md) and lives in the repo
at [`docs/SECURE-CHAT.md`](https://github.com/agora-oss-org/agora-sdk-plus/blob/main/docs/SECURE-CHAT.md).
