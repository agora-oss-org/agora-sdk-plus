# Upstream fix needed: `@agora-sdk/core` is unloadable (ESM + CJS)

**Repo to fix:** [agora-sdk](https://github.com/jenova-marie/agora-sdk) (the Replyke fork) — **not this
repo.** This is a write-up of a packaging bug discovered while fixing the same class of bug here in
agora-sdk-plus (see [`CHANGELOG.md`](CHANGELOG.md) → _Fixed_, and `scripts/verify-dist.mjs`).

**Affected:** `@agora-sdk/core@1.2.2` (and almost certainly its siblings
`@agora-sdk/{react-js,react-native,expo}`, which share the build setup).

**Impact:** `@agora-sdk/core` cannot be loaded by **either** an ESM or a CommonJS consumer. Every app
and every downstream SDK that imports it breaks at runtime the moment it does so.

*(Historical note: this write-up originally flagged `secure-chat-core` as an affected downstream —
it used to fall back to `@agora-sdk/core`'s `getApiBaseUrl`/`getSocketUrl` runtime singletons. That
coupling was dropped — `secure-chat-core` and `social-core` are now standalone and take `baseUrl`
directly, with zero `@agora-sdk/core` dependency (see `CHANGELOG.md`) — so they're unaffected by this
bug today. The remaining consumer in this repo is `@agora-sdk/auth-react-js`, which peer-depends on
`@agora-sdk/react-js` and would be exposed to the same defect class if it exists in that sibling
package.)*

---

## Symptoms (reproduced against the published 1.2.2)

ESM consumer:

```
SyntaxError: The requested module '@agora-sdk/core' does not provide an export named 'getApiBaseUrl'
# or, loading its entry directly:
ReferenceError: exports is not defined in ES module scope
```

CommonJS consumer:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../@agora-sdk/core/dist/cjs/utils/handleError'
# (require() of the entry resolves into the CJS tree, which is then parsed as ESM)
```

Reproduce:

```bash
node --input-type=module -e "import('@agora-sdk/core').then(m=>console.log(Object.keys(m)))"
node -e "console.log(Object.keys(require('@agora-sdk/core')))"
```

## Root cause — three packaging defects

The published `package.json` is:

```jsonc
{
  "type": "module",                    // ← every .js in the package is ESM by default
  "main": "dist/cjs/index.js",         // ← CommonJS output
  "module": "dist/esm/index.js",       // ← IGNORED by Node (bundler-only hint)
  "types": "dist/esm/index.d.ts"
  // ← NO "exports" map
}
```

1. **No `exports` map.** Node does not read the `"module"` field. With only `main`, **both**
   `import` and `require` resolve to `dist/cjs/index.js`. So ESM consumers get the CommonJS build,
   and because the package is `"type": "module"` that file is parsed as ESM → `exports is not
   defined`. The ESM build in `dist/esm/` is never used by Node at all.

2. **Extensionless relative imports in the ESM output.** `tsc` never rewrites import specifiers, so
   `dist/esm/index.js` contains:

   ```js
   export { handleError } from "./utils/handleError";   // ← no .js
   ```

   Node's ESM resolver requires a full path (`"./utils/handleError.js"`). Even after fixing defect 1,
   the ESM build would still fail to resolve its own internal imports.

3. **No `dist/cjs/package.json` marking the CJS tree as CommonJS.** Because the package root is
   `"type": "module"`, Node treats `dist/cjs/*.js` as ESM too. The CJS build (`require(...)`,
   `exports.x = ...`) is therefore invalid when loaded.

## The fix

Mirror the exact fix already applied in agora-sdk-plus (it builds the same dual ESM/CJS shape):

### 1. Add an `exports` map (and keep `main`/`module`/`types` for legacy tooling)

```jsonc
{
  "type": "module",
  "main": "dist/cjs/index.js",
  "module": "dist/esm/index.js",
  "types": "dist/esm/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/esm/index.d.ts",
      "import": "./dist/esm/index.js",
      "require": "./dist/cjs/index.js"
    }
  }
}
```

If the package exposes subpath entries (e.g. `@agora-sdk/core/something`), add a key per subpath with
the same `types`/`import`/`require` trio.

### 2. Add `.js` extensions to every relative import/export in source

`tsc` preserves the specifier you write, so write the runtime extension in the `.ts` source:

```ts
export { handleError } from "./utils/handleError.js";          // file
export type * from "./types/index.js";                          // directory → /index.js
```

This compiles cleanly under both build configs (the ESM `bundler`/`nodenext` resolution and the CJS
`node` resolution both map `./x.js` → `./x.ts` at compile time) and emits the correct extension in
both `dist/esm` and `dist/cjs`. Directory imports must become `…/index.js`.

### 3. Emit a CommonJS type marker from `build:cjs`

```jsonc
"build:cjs": "tsc -p tsconfig.cjs.json && echo '{\"type\":\"commonjs\"}' > dist/cjs/package.json"
```

`rimraf dist` in the `build` script wipes it each time, so generating it in `build:cjs` keeps it in
sync. (`files: ["dist"]` already ships it.)

## Verify

```bash
pnpm run build
node --input-type=module -e "import('@agora-sdk/core').then(m=>console.log('ESM ok', Object.keys(m).length))"
node -e "console.log('CJS ok', Object.keys(require('@agora-sdk/core')).length)"
```

Both must print without error. Better: port `agora-sdk-plus`'s `scripts/verify-dist.mjs` into the
agora-sdk repo and run it after `build` in CI/publish, so this can never regress.

## Notes

- Apply the **same three changes to `@agora-sdk/react-js`, `@agora-sdk/react-native`, and
  `@agora-sdk/expo`** — they share this build setup and almost certainly the same defects.
- This is the identical bug class fixed in this repo; the working reference is the commit that adds
  `.js` extensions, the `build:cjs` CJS marker, and `scripts/verify-dist.mjs`.
- `@agora-sdk/secure-chat-core`, `@agora-sdk/social-core`, and their platform packages no longer depend
  on `@agora-sdk/core` (the `baseUrl`-required refactor removed the `getApiBaseUrl`/`getSocketUrl`
  fallback — see `CHANGELOG.md`), so they build, typecheck, **and load at runtime** regardless of this
  bug. `@agora-sdk/auth-react-js` is the one package here that still peer-depends on `@agora-sdk/react-js`
  (and transitively on this bug being fixed, if the same defects apply to that sibling package).
