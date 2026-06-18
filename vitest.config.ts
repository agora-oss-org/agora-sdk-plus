// Vitest harness for the workspace.
//
// One root config drives every package's co-located `*.test.ts(x)`. Default environment is `node`;
// tests that exercise React hooks/providers opt into jsdom per-file with a
// `// @vitest-environment jsdom` pragma (install jsdom when the first such test lands).
//
// The aliases point the workspace crypto package at its SOURCE, so tests can import the public
// `@agora-sdk/secure-chat-crypto` / `…/testing` entries (e.g. inject `MockSecureChatCrypto`) without
// first building `dist/`. More-specific subpath alias is listed first so it wins over the bare one.
//
// No @agora-sdk/core alias: neither secure-chat nor social depends on @agora-sdk/core any more (they
// take `baseUrl` directly), so there is nothing to stub.

import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const fromHere = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/**/src/**/*.test.{ts,tsx}"],
    alias: {
      "@agora-sdk/secure-chat-crypto/testing": fromHere(
        "packages/secure-chat/crypto/src/testing.ts"
      ),
      // The real ts-mls core subpath, so tests can exercise the web crypto factory
      // (`createWebSecureChatCrypto`, which imports it) without a build. Listed before the bare entry
      // so the more-specific subpath wins.
      "@agora-sdk/secure-chat-crypto/ts-mls": fromHere(
        "packages/secure-chat/crypto/src/ts-mls/index.ts"
      ),
      "@agora-sdk/secure-chat-crypto": fromHere("packages/secure-chat/crypto/src/index.ts"),
      // Alias the social workspace package to its SOURCE so social-react-js component tests can import
      // the public `@agora-sdk/social-core` entry (provider, hooks, transport, types) without a build.
      "@agora-sdk/social-core": fromHere("packages/social/core/src/index.ts"),
    },
  },
});
