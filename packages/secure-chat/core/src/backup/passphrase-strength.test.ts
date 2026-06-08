import { describe, it, expect } from "vitest";
import { estimatePassphraseStrength } from "./passphrase-strength.js";

describe("estimatePassphraseStrength", () => {
  it("scores empty / trivial passphrases as weakest", () => {
    expect(estimatePassphraseStrength("").score).toBe(0);
    expect(estimatePassphraseStrength("abc").score).toBe(0);
  });

  it("penalizes common passwords regardless of shape", () => {
    const r = estimatePassphraseStrength("password");
    expect(r.score).toBeLessThanOrEqual(1);
    expect(r.warning).toBeTruthy();
  });

  it("rewards a long, multi-class passphrase", () => {
    const r = estimatePassphraseStrength("correct-Horse9-Battery!staple");
    expect(r.score).toBeGreaterThanOrEqual(3);
    expect(r.label).toBeTruthy();
  });

  it("is (weakly) monotonic: adding length + classes does not lower the score", () => {
    const a = estimatePassphraseStrength("abcdefgh").score;
    const b = estimatePassphraseStrength("abcdefgh12").score;
    const c = estimatePassphraseStrength("Abcdefgh12!xyz").score;
    expect(b).toBeGreaterThanOrEqual(a);
    expect(c).toBeGreaterThanOrEqual(b);
  });

  it("returns a score in 0..4 and a non-empty label", () => {
    for (const pw of ["", "x", "hunter2", "a longish but lowercase only phrase", "Tr0ub4dour&3xtra-Long!"]) {
      const r = estimatePassphraseStrength(pw);
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(4);
      expect(r.label.length).toBeGreaterThan(0);
    }
  });
});
