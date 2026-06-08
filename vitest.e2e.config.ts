// Vitest config for the OPT-IN foundation-validation e2e (see e2e/secure-chat.e2e.ts).
//
// Deliberately separate from the unit config (vitest.config.ts): a different glob (`e2e/**/*.e2e.ts`,
// which the unit glob `packages/**/src/**` never matches) so `pnpm test` and CI stay server-free, and
// — crucially — NO `@agora-sdk/*` aliases. The unit config stubs `@agora-sdk/core` and aliases the
// crypto package to source; here we want the REAL transport, so the e2e imports the transport source
// directly by relative path (vite resolves the `.js` specifiers to `.ts`). Node env, no setup files.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["e2e/**/*.e2e.ts"],
    // A real socket connect + DB round-trip is slower than a unit test; give each room to settle.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
