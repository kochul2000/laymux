import { describe, it, expect } from "vitest";
import {
  cycleSleepPreventionMode,
  normalizeSleepPreventionMode,
  shouldInhibitSleep,
  type SleepPreventionMode,
} from "./sleep-prevention";

describe("shouldInhibitSleep", () => {
  it("never inhibits when off, busy or not", () => {
    expect(shouldInhibitSleep("off", false)).toBe(false);
    expect(shouldInhibitSleep("off", true)).toBe(false);
  });

  it("always inhibits when always, even with every terminal idle", () => {
    expect(shouldInhibitSleep("always", false)).toBe(true);
    expect(shouldInhibitSleep("always", true)).toBe(true);
  });

  it("follows the busy state when whenBusy", () => {
    expect(shouldInhibitSleep("whenBusy", false)).toBe(false);
    expect(shouldInhibitSleep("whenBusy", true)).toBe(true);
  });
});

describe("cycleSleepPreventionMode", () => {
  it("walks off → always → whenBusy → off", () => {
    expect(cycleSleepPreventionMode("off")).toBe("always");
    expect(cycleSleepPreventionMode("always")).toBe("whenBusy");
    expect(cycleSleepPreventionMode("whenBusy")).toBe("off");
  });

  it("restarts the cycle from an unknown mode instead of getting stuck", () => {
    expect(cycleSleepPreventionMode("nonsense" as SleepPreventionMode)).toBe("off");
  });
});

describe("normalizeSleepPreventionMode", () => {
  it("keeps known modes", () => {
    expect(normalizeSleepPreventionMode("whenBusy")).toBe("whenBusy");
  });

  it("falls back to off for anything else", () => {
    expect(normalizeSleepPreventionMode("Always")).toBe("off");
    expect(normalizeSleepPreventionMode(undefined)).toBe("off");
    expect(normalizeSleepPreventionMode(7)).toBe("off");
  });
});
