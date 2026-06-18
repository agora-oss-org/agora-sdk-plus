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
// @agora-sdk/core ships with "type":"module" but its ESM build uses extensionless relative imports
// that Node's strict ESM resolver cannot find, and its `main` points to CJS (which itself fails
// because the package is marked "type":"module"). We alias the package to a minimal in-repo stub
// that exports only the two symbols this SDK actually uses (`getApiBaseUrl`, `getSocketUrl`).
// Tests always override the URLs via props so the stubs are never actually called.

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
      // Stub out @agora-sdk/core — its published ESM build uses extensionless relative imports that
      // Node's strict ESM resolver rejects, and its CJS build fails in an ESM context. The stub's
      // placeholder URLs are safe because resolution is lazy: getApiBaseUrl / getSocketUrl only run
      // inside the axios request interceptor and socket.io connect(), neither of which fires in
      // these unit tests (no request is made, no socket opened).
      "@agora-sdk/core": fromHere("test-support/agora-sdk-core-stub.ts"),
    },
  },
});
