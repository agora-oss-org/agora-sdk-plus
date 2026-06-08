// Post-build packaging guard for OUR emitted dist. Catches the two defects `tsc` can't see and that
// only surface when Node actually loads a package — so a broken dist can never be published again.
//
// The two defects (both real, both hit us):
//   1. Extensionless relative imports in ESM output. `tsc` never rewrites specifiers, so a source
//      `from "./x"` emits `from "./x"` — invalid for Node's ESM resolver, which needs `from "./x.js"`.
//   2. CJS output mis-typed as ESM. Each package is `"type": "module"`, so Node reads every `.js` as
//      ESM — including `dist/cjs/*.js` — unless a `dist/cjs/package.json` marks that tree commonjs.
//
// Strategy:
//   • STATIC lint of every package's `dist/esm/**/*.js` for extensionless relative specifiers, plus a
//     check that `dist/cjs/package.json` exists and is `{"type":"commonjs"}`. Deterministic and free
//     of peer-dependency execution — so it verifies what WE control across all packages.
//   • RUNTIME load (ESM + CJS) of the dependency-free `crypto` package as a real smoke test. The
//     other packages depend on `@agora-sdk/core`, which is itself broken upstream the same way
//     (type:module + no exports map + extensionless imports), so loading them would fail on THAT, not
//     on our build — hence static-only for those until the upstream package is fixed.
//
// Run AFTER `build-all`. Wired into CI and the publish workflow.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const pkgsDir = fileURLToPath(new URL("../packages/secure-chat", import.meta.url));

// `from "…"`, `import("…")`, bare `import "…"`, and `require("…")` — capturing only relative targets.
const SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'](\.[^"']*)["']/g;
const HAS_EXTENSION = /\.(?:js|cjs|mjs|json|node)$/;

/** All `*.js` files under `dir`, recursively. */
function jsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...jsFiles(full));
    else if (name.endsWith(".js")) out.push(full);
  }
  return out;
}

const problems = [];

for (const dir of readdirSync(pkgsDir)) {
  const base = join(pkgsDir, dir);
  const pkgPath = join(base, "package.json");
  if (!existsSync(pkgPath)) continue;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (pkg.private) continue;

  // 1. ESM specifiers must carry an extension.
  const esmDir = join(base, "dist", "esm");
  if (!existsSync(esmDir)) {
    problems.push(`${pkg.name}: no dist/esm — run \`pnpm run build-all\` first`);
  } else {
    for (const file of jsFiles(esmDir)) {
      const src = readFileSync(file, "utf8");
      for (const [, spec] of src.matchAll(SPECIFIER)) {
        if (!HAS_EXTENSION.test(spec)) {
          problems.push(`${pkg.name}: extensionless ESM import "${spec}" in ${file.slice(base.length + 1)}`);
        }
      }
    }
  }

  // 2. CJS tree must be marked commonjs (the package root is type:module) — but only for packages
  //    that actually ship a CJS build. ESM-only packages (e.g. react-js, which depends on the ESM-only
  //    ts-mls core + bundler-only @agora-sdk/core) declare an ESM `main` and have no dist/cjs.
  const esmOnly = typeof pkg.main === "string" && !pkg.main.includes("/cjs/");
  if (!esmOnly) {
    const cjsMarker = join(base, "dist", "cjs", "package.json");
    if (!existsSync(cjsMarker)) {
      problems.push(`${pkg.name}: missing dist/cjs/package.json (CJS type marker)`);
    } else {
      const type = JSON.parse(readFileSync(cjsMarker, "utf8")).type;
      if (type !== "commonjs") {
        problems.push(`${pkg.name}: dist/cjs/package.json type is "${type}", expected "commonjs"`);
      }
    }
  }
}

// 3. Real load of the dependency-free crypto package (ESM + CJS) — proof, not just lint.
const cryptoEsm = join(pkgsDir, "crypto", "dist", "esm", "testing.js");
const cryptoCjs = join(pkgsDir, "crypto", "dist", "cjs", "testing.js");
try {
  const m = await import(pathToFileURL(cryptoEsm).href);
  if (!m.MockSecureChatCrypto) problems.push("crypto ESM: MockSecureChatCrypto not exported");
} catch (err) {
  problems.push(`crypto ESM load: ${err.code ?? ""} ${err.message.split("\n")[0]}`);
}
try {
  const m = require(cryptoCjs);
  if (!m.MockSecureChatCrypto) problems.push("crypto CJS: MockSecureChatCrypto not exported");
} catch (err) {
  problems.push(`crypto CJS load: ${err.code ?? ""} ${err.message.split("\n")[0]}`);
}

if (problems.length) {
  console.error(`✗ verify-dist: ${problems.length} packaging problem(s):\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

console.log("✓ verify-dist: ESM specifiers extensioned, CJS marked commonjs, crypto loads (ESM + CJS).");
