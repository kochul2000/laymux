import { describe, it, expect } from "vitest";
import { normalizeSleepPreventionAxes, shouldInhibitSleep } from "./sleep-prevention";

describe("shouldInhibitSleep", () => {
  it("lets the machine sleep when neither axis asks otherwise", () => {
    expect(shouldInhibitSleep({ keepAwake: false, keepAwakeWhenBusy: false }, false)).toBe(false);
    expect(shouldInhibitSleep({ keepAwake: false, keepAwakeWhenBusy: false }, true)).toBe(false);
  });

  it("honors the manual switch regardless of what the terminals are doing", () => {
    expect(shouldInhibitSleep({ keepAwake: true, keepAwakeWhenBusy: false }, false)).toBe(true);
    expect(shouldInhibitSleep({ keepAwake: true, keepAwakeWhenBusy: false }, true)).toBe(true);
  });

  it("follows the terminals when only the policy is on", () => {
    expect(shouldInhibitSleep({ keepAwake: false, keepAwakeWhenBusy: true }, false)).toBe(false);
    expect(shouldInhibitSleep({ keepAwake: false, keepAwakeWhenBusy: true }, true)).toBe(true);
  });

  it("keeps the manual switch effective while the policy is idle", () => {
    // The axes are independent: the policy going quiet must not undo a manual
    // "keep awake" the user turned on for this session (ADR-0116).
    expect(shouldInhibitSleep({ keepAwake: true, keepAwakeWhenBusy: true }, false)).toBe(true);
  });
});

describe("normalizeSleepPreventionAxes", () => {
  it("keeps booleans", () => {
    expect(normalizeSleepPreventionAxes({ keepAwake: true, keepAwakeWhenBusy: false })).toEqual({
      keepAwake: true,
      keepAwakeWhenBusy: false,
    });
  });

  it("treats a hand-edited non-boolean as off rather than truthy", () => {
    // A settings.json holding "true" or 1 must not reach the OS call as an
    // acquire the user never asked for.
    expect(normalizeSleepPreventionAxes({ keepAwake: "true", keepAwakeWhenBusy: 1 })).toEqual({
      keepAwake: false,
      keepAwakeWhenBusy: false,
    });
  });

  it("fills in missing and non-object input with the defaults", () => {
    expect(normalizeSleepPreventionAxes({})).toEqual({
      keepAwake: false,
      keepAwakeWhenBusy: false,
    });
    expect(normalizeSleepPreventionAxes(undefined)).toEqual({
      keepAwake: false,
      keepAwakeWhenBusy: false,
    });
    expect(normalizeSleepPreventionAxes("whenBusy")).toEqual({
      keepAwake: false,
      keepAwakeWhenBusy: false,
    });
  });
});
