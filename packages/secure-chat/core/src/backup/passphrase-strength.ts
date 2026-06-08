// Passphrase-strength estimator for backup UX.
//
// Why this exists (CLAUDE.md #1 + spec §16.5): the blind server stores the passphrase-encrypted
// backup blob, so a weak passphrase is offline-brute-forceable on a DB exfil. The real argon2id KDF
// raises the cost per guess, but it can't rescue a guessable passphrase — so we nudge the user toward
// a strong one at entry time. This is a deliberately small, dependency-free heuristic (length +
// character-class diversity + a common-password penalty), NOT a substitute for zxcvbn-grade entropy
// estimation. It runs purely client-side and never logs or transmits the passphrase.

/** The outcome of {@link estimatePassphraseStrength}: a coarse 0–4 score plus display copy. */
export interface PassphraseStrength {
  /** 0 (weakest) … 4 (strongest) — for a 5-segment meter. */
  score: 0 | 1 | 2 | 3 | 4;
  /** A short human label for the score (e.g. "Weak", "Strong"). */
  label: string;
  /** A specific reason the passphrase is weak, when applicable (e.g. a common password). */
  warning?: string;
}

const LABELS = ["Very weak", "Weak", "Fair", "Strong", "Very strong"] as const;

// A tiny set of the most-guessed passwords/substrings. Not exhaustive — a guardrail against the
// obvious, not a real dictionary check.
const COMMON = [
  "password", "passw0rd", "12345", "123456", "qwerty", "letmein", "admin", "welcome",
  "iloveyou", "abc123", "hunter2", "monkey", "dragon", "trustno1", "secret",
];

/**
 * Estimate the strength of a backup passphrase for a strength meter.
 *
 * @param passphrase - The candidate passphrase (never logged or sent anywhere).
 * @returns A {@link PassphraseStrength} with a 0–4 score, a label, and an optional warning.
 *
 * @example
 * ```ts
 * const { score, label, warning } = estimatePassphraseStrength(input);
 * // render a 5-segment meter from `score`, show `warning` if present.
 * ```
 */
export function estimatePassphraseStrength(passphrase: string): PassphraseStrength {
  const pw = passphrase ?? "";
  if (pw.length === 0) return { score: 0, label: LABELS[0] };

  const lower = pw.toLowerCase();
  const hitsCommon = COMMON.some((c) => lower.includes(c));

  // Character-class diversity.
  let classes = 0;
  if (/[a-z]/.test(pw)) classes++;
  if (/[A-Z]/.test(pw)) classes++;
  if (/[0-9]/.test(pw)) classes++;
  if (/[^a-zA-Z0-9]/.test(pw)) classes++;

  // Length is the dominant factor (passphrases >> complex-but-short passwords).
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (pw.length >= 16) score++;
  // Diversity adds at most one step, and only once there's some length.
  if (classes >= 3 && pw.length >= 8) score++;

  // A short, single-class passphrase never rates above "weak".
  if (pw.length < 8 || classes <= 1) score = Math.min(score, 1);

  // A recognizably common password is capped hard regardless of shape.
  if (hitsCommon) score = Math.min(score, 1);

  const clamped = Math.max(0, Math.min(4, score)) as PassphraseStrength["score"];
  return {
    score: clamped,
    label: LABELS[clamped],
    warning: hitsCommon
      ? "This looks like a common password — choose something less guessable."
      : clamped <= 1
        ? "Use a longer passphrase (4+ random words) with mixed character types."
        : undefined,
  };
}
