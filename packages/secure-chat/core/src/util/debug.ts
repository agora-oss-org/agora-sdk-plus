// debug — dev-only trace/debug logging for secure-chat's sync internals.
//
// THIS IS A DEVELOPMENT AID, NOT PRODUCTION OBSERVABILITY. It is OFF by default and every call
// short-circuits on a single boolean check the instant logging is disabled, so a shipped build with
// debug off does nothing and costs nothing — no message is formatted, no data is touched, nothing
// reaches the console. Because it only ever runs while a developer has explicitly switched it on, it
// deliberately logs RAW data (epochs, ids, cursors, decoded handshake shapes, counts, even payload
// bodies) next to a plain-English message, so the blind-server handshake / catch-up / decrypt flow is
// legible while iterating.
//
// It makes NO redaction guarantees and is NOT safe to leave on in a real deployment: when enabled it
// can and will print plaintext-adjacent material. Keep it off in production (the default). The
// engineering-standards rule in CLAUDE.md §1 ("never log plaintext/keys") is about what the SHIPPED,
// always-on code path may emit — this opt-in, off-by-default dev switch is the explicit escape hatch
// for diagnosing the sync machinery on a developer's own machine.

/** Severity of a {@link SecureChatDebugLogger} line. `trace` is the noisiest (full payloads). */
export type SecureChatDebugLevel = "trace" | "debug";

/** Numeric ordering so a configured minimum level can filter out quieter lines. */
const LEVEL_RANK: Record<SecureChatDebugLevel, number> = { trace: 10, debug: 20 };

/**
 * Read the initial on/off state from the environment so a developer can enable logging without a code
 * change — `globalThis.__AGORA_SECURE_CHAT_DEBUG__ = true` (any runtime) or the
 * `AGORA_SECURE_CHAT_DEBUG` env var (Node; `""`/`"0"`/`"false"` count as off). Wrapped in try/catch so
 * a locked-down environment that throws on `process`/`globalThis` access can never break import.
 */
function resolveInitialEnabled(): boolean {
  try {
    const flag = (globalThis as { __AGORA_SECURE_CHAT_DEBUG__?: unknown }).__AGORA_SECURE_CHAT_DEBUG__;
    if (typeof flag === "boolean") return flag;
    if (typeof process !== "undefined" && process.env) {
      const v = process.env.AGORA_SECURE_CHAT_DEBUG;
      if (v != null) return v !== "" && v !== "0" && v !== "false";
    }
  } catch {
    // Inaccessible global/process — treat as off.
  }
  return false;
}

// Module-level switch shared by every logger this module hands out. A single flag (not per-logger
// state) so one `setSecureChatDebug(true)` lights up the whole SDK at once.
let enabled = resolveInitialEnabled();
let minLevel: SecureChatDebugLevel = "trace";

/**
 * Turn secure-chat dev logging on or off at runtime (overrides the env default). Off is the default;
 * leave it off in production.
 *
 * @param on - `true` to emit logs, `false` to silence every logger (back to the zero-cost no-op).
 * @param level - Minimum level to emit when on: `"trace"` (default) shows everything; `"debug"` mutes
 *   the noisier full-payload `trace` lines.
 *
 * @example
 * ```ts
 * import { setSecureChatDebug } from "@agora-sdk/secure-chat-core";
 * setSecureChatDebug(true);          // everything, while debugging a sync issue
 * setSecureChatDebug(true, "debug"); // status lines only, no raw payload dumps
 * setSecureChatDebug(false);         // back to silent
 * ```
 */
export function setSecureChatDebug(on: boolean, level: SecureChatDebugLevel = "trace"): void {
  enabled = on;
  minLevel = level;
}

/**
 * Whether secure-chat dev logging is currently emitting.
 *
 * @returns `true` if logs are on. Useful to guard building an expensive debug-only payload so the work
 *   is skipped when logging is off.
 */
export function isSecureChatDebugEnabled(): boolean {
  return enabled;
}

/**
 * A namespaced dev logger. Both methods take a human-readable message and an optional raw data blob
 * that is printed verbatim (objects expand in the console). Every call is a no-op when logging is off.
 */
export interface SecureChatDebugLogger {
  /** Noisiest level — full payloads, decoded shapes, per-item detail. */
  trace(message: string, data?: unknown): void;
  /** Status-line level — what happened, with summarizing scalars (ids, counts, seq, status). */
  debug(message: string, data?: unknown): void;
}

/**
 * Create a logger tagged with a subsystem name (e.g. `"handshakes"`, `"rest"`, `"messages"`). Lines
 * print as `[secure-chat:<namespace>] <level> <message>` followed by the data blob, so output is easy
 * to grep and filter by subsystem.
 *
 * @param namespace - Short subsystem tag included in every line from this logger.
 * @returns A {@link SecureChatDebugLogger}; its calls are no-ops while logging is disabled.
 *
 * @example
 * ```ts
 * const log = createDebugLogger("handshakes");
 * log.debug("catch-up start", { deviceId, fromCursor });
 * log.trace("dispatch handshake", handshake);
 * ```
 */
export function createDebugLogger(namespace: string): SecureChatDebugLogger {
  const tag = `[secure-chat:${namespace}]`;
  const emit = (level: SecureChatDebugLevel, message: string, data?: unknown): void => {
    // The hot path: one boolean + one integer compare, then bail. Nothing below runs when off.
    if (!enabled || LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;
    const line = `${tag} ${level} ${message}`;
    // Use console.debug (not console.trace, which would attach a noisy stack to every line).
    if (data === undefined) console.debug(line);
    else console.debug(line, data);
  };
  return {
    trace: (message, data) => emit("trace", message, data),
    debug: (message, data) => emit("debug", message, data),
  };
}
