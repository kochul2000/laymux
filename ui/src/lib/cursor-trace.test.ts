import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CURSOR_TRACE_STORAGE_KEY,
  createCursorTracer,
  isCursorTraceEnabled,
  isTruthyFlag,
} from "./cursor-trace";

function makeStorage(initial?: string) {
  const store = new Map<string, string>();
  if (initial !== undefined) store.set(CURSOR_TRACE_STORAGE_KEY, initial);
  return {
    getItem: (k: string) => store.get(k) ?? null,
  };
}

describe("cursor-trace", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_LAYMUX_CURSOR_TRACE", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is disabled when neither build flag nor storage flag is set", () => {
    expect(isCursorTraceEnabled({ storage: makeStorage() })).toBe(false);
  });

  it("enables when localStorage flag is '1'", () => {
    expect(isCursorTraceEnabled({ storage: makeStorage("1") })).toBe(true);
  });

  it("accepts the same truthy values as the Rust env_flag_enabled", () => {
    for (const v of ["1", "true", "TRUE", "yes", "YES"]) {
      expect(isCursorTraceEnabled({ storage: makeStorage(v) })).toBe(true);
    }
  });

  it("treats falsy/unknown storage values as disabled", () => {
    for (const v of ["0", "false", "no", "", "yep", "TrUe"]) {
      expect(isCursorTraceEnabled({ storage: makeStorage(v) })).toBe(false);
    }
  });

  it("isTruthyFlag matches the documented ruleset", () => {
    expect(isTruthyFlag("1")).toBe(true);
    expect(isTruthyFlag("true")).toBe(true);
    expect(isTruthyFlag("TRUE")).toBe(true);
    expect(isTruthyFlag("yes")).toBe(true);
    expect(isTruthyFlag("YES")).toBe(true);
    expect(isTruthyFlag("0")).toBe(false);
    expect(isTruthyFlag("false")).toBe(false);
    expect(isTruthyFlag(null)).toBe(false);
    expect(isTruthyFlag(undefined)).toBe(false);
  });

  it("tracer is a no-op when disabled — does not call logger", () => {
    const log = vi.fn();
    const trace = createCursorTracer("term-1", {
      storage: makeStorage(),
      logger: { log },
    });
    trace("overlay-update", { cursorX: 5 });
    expect(log).not.toHaveBeenCalled();
  });

  it("tracer logs structured record when enabled", () => {
    const log = vi.fn();
    const trace = createCursorTracer("term-1", {
      storage: makeStorage("1"),
      logger: { log },
      now: () => "2026-04-13T00:00:00.000Z",
    });
    trace("overlay-update", { cursorX: 5 });
    expect(log).toHaveBeenCalledWith(
      "[cursor-trace][2026-04-13T00:00:00.000Z][term-1] overlay-update",
      { cursorX: 5 },
    );
  });

  it("handles storage access failures gracefully", () => {
    const throwingStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
    };
    expect(isCursorTraceEnabled({ storage: throwingStorage })).toBe(false);
  });
});
