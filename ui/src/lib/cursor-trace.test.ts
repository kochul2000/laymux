import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CURSOR_TRACE_STORAGE_KEY,
  createCursorTracer,
  isCursorTraceEnabled,
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

  it("ignores non-'1' storage values", () => {
    expect(isCursorTraceEnabled({ storage: makeStorage("true") })).toBe(false);
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
