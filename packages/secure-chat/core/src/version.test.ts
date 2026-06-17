// The whole value of an exported VERSION is that it's CORRECT, so the test that matters is the
// drift guard: VERSION must equal this package's package.json version (the generator keeps them in
// lockstep). A semver-shape check guards against an empty/garbage value.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { VERSION } from "./version.js";

describe("VERSION", () => {
  it("is a semver string", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/);
  });

  it("matches this package's package.json version (no drift)", () => {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "../package.json");
    const { version } = JSON.parse(readFileSync(pkgPath, "utf8"));
    expect(VERSION).toBe(version);
  });
});
