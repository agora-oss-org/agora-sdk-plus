// Opt-in local-fork link for @agora-sdk/react-js.
//
// By DEFAULT this is a no-op: the workspace resolves @agora-sdk/react-js from npm (the version in each
// package's deps), so the committed pnpm-lock.yaml is authoritative and `pnpm install --frozen-lockfile`
// on CI works — CI only checks out THIS repo, so it must never depend on a sibling path.
//
// A local `link:../agora-sdk/packages/react-js` override used to live (committed) in package.json's
// `pnpm.overrides`. That broke CI/publish: the linked path doesn't exist on the runner, so tsc failed
// with "Cannot find module '@agora-sdk/react-js'". It's replaced by this opt-in.
//
// To develop against the sibling fork instead of the npm release:
//     AGORA_SDK_LINK=1 pnpm install
// (only takes effect if ../agora-sdk/packages/react-js actually exists). This rewrites the lockfile to a
// link — do NOT commit that lockfile. Run a plain `pnpm install` to restore the npm-pinned lockfile
// before committing. Because it's gated on an env var, the default `pnpm install` (and CI) is unaffected.

const fs = require("fs");
const path = require("path");

const LOCAL = path.resolve(__dirname, "../agora-sdk/packages/react-js");
const linkLocal = process.env.AGORA_SDK_LINK === "1" && fs.existsSync(LOCAL);
const TARGET = "@agora-sdk/react-js";

function readPackage(pkg) {
  if (!linkLocal) return pkg; // default: leave the npm-pinned dependency untouched
  // Only the (dev)dependency is redirected to the sibling checkout. peerDependencies must stay a semver
  // range — pnpm rejects a `link:` spec there — and the peer is satisfied by the linked dep anyway.
  for (const field of ["dependencies", "devDependencies"]) {
    if (pkg[field] && pkg[field][TARGET]) {
      pkg[field][TARGET] = `link:${LOCAL}`;
    }
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
