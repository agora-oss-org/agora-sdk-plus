// Tests for the dev-only debug logger: the contract that matters is "silent and zero-work when off,
// faithful raw output when on". A leaky default (logging in prod) would be the bug, so the off path is
// asserted hardest.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDebugLogger,
  isSecureChatDebugEnabled,
  setSecureChatDebug,
} from "./debug.js";

describe("debug logger", () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spy = vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    setSecureChatDebug(false); // restore the default so other tests stay silent
    spy.mockRestore();
  });

  it("is off by default and emits nothing", () => {
    const log = createDebugLogger("test");
    expect(isSecureChatDebugEnabled()).toBe(false);
    log.debug("should not print", { secret: "x" });
    log.trace("should not print", { secret: "x" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("emits a tagged, leveled line with the raw data once enabled", () => {
    setSecureChatDebug(true);
    const log = createDebugLogger("handshakes");
    const data = { seq: "42", kind: "welcome" };
    log.debug("catch-up page", data);
    expect(spy).toHaveBeenCalledTimes(1);
    const [line, payload] = spy.mock.calls[0];
    expect(line).toBe("[secure-chat:handshakes] debug catch-up page");
    expect(payload).toBe(data); // passed through verbatim, not copied/redacted
  });

  it("omits the data argument when none is given", () => {
    setSecureChatDebug(true);
    createDebugLogger("rest").debug("no data");
    expect(spy).toHaveBeenCalledWith("[secure-chat:rest] debug no data");
  });

  it("level=debug mutes trace lines but keeps debug lines", () => {
    setSecureChatDebug(true, "debug");
    const log = createDebugLogger("messages");
    log.trace("noisy payload dump", { big: true });
    log.debug("status line");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe("[secure-chat:messages] debug status line");
  });

  it("level=trace (default when on) emits both levels", () => {
    setSecureChatDebug(true);
    const log = createDebugLogger("messages");
    log.trace("a");
    log.debug("b");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("goes fully silent again after setSecureChatDebug(false)", () => {
    setSecureChatDebug(true);
    setSecureChatDebug(false);
    createDebugLogger("test").debug("silent");
    expect(isSecureChatDebugEnabled()).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
