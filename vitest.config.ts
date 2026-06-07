// Vitest harness for the workspace.
//
// One root config drives every package's co-located `*.test.ts(x)`. Default environment is `node`;
// tests that exercise React hooks/providers opt into jsdom per-file with a
// `// @vitest-environment jsdom` pragma (install jsdom when the first such test lands).
//
// The aliases point the workspace crypto package at its SOURCE, so tests can import the public
// `@agora-sdk/secure-chat-crypto` / `…/testing` entries (e.g. inject `MockSecureChatCrypto`) without
// first building `dist/`. More-specific subpath alias is listed first so it wins over the bare one.

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
      "@agora-sdk/secure-chat-crypto": fromHere("packages/secure-chat/crypto/src/index.ts"),
    },
  },
});
