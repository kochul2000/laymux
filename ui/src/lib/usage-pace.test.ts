import { describe, expect, it } from "vitest";
import {
  PACE_TOLERANCE_POINTS,
  SESSION_WINDOW_MS,
  WEEK_WINDOW_MS,
  elapsedPercent,
  formatTimeUntil,
  paceVerdict,
  resolveResetInstant,
  sessionElapsedPercent,
  weekElapsedPercent,
} from "./usage-pace";

/** Local-time helper so assertions read as wall-clock, matching the parser. */
function at(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

describe("resolveResetInstant", () => {
  it("rolls a time-only reset forward to today when it is still ahead", () => {
    const now = at(2026, 3, 2, 15, 0);
    expect(resolveResetInstant("7pm (Asia/Seoul)", SESSION_WINDOW_MS, now)).toEqual(
      at(2026, 3, 2, 19),
    );
  });

  it("rolls a time-only reset to tomorrow once it has passed", () => {
    const now = at(2026, 3, 2, 20, 0);
    expect(resolveResetInstant("7pm", SESSION_WINDOW_MS, now)).toEqual(at(2026, 3, 3, 19));
  });

  it("reads minutes and meridiem", () => {
    const now = at(2026, 3, 2, 1, 0);
    expect(resolveResetInstant("11:59am", SESSION_WINDOW_MS, now)).toEqual(at(2026, 3, 2, 11, 59));
  });

  it("handles the 12am/12pm edges", () => {
    const now = at(2026, 3, 2, 5, 0);
    expect(resolveResetInstant("12pm", SESSION_WINDOW_MS, now)).toEqual(at(2026, 3, 2, 12));
    expect(resolveResetInstant("12am", SESSION_WINDOW_MS, now)).toEqual(at(2026, 3, 3, 0));
  });

  it("reads a dated weekly reset", () => {
    const now = at(2026, 3, 2, 9, 0);
    expect(resolveResetInstant("Mar 6, 11:59am (Asia/Seoul)", WEEK_WINDOW_MS, now)).toEqual(
      at(2026, 3, 6, 11, 59),
    );
  });

  it("keeps a dated reset that is inside the current window even when past", () => {
    // Reset was yesterday but the weekly window still covers it; bumping a year
    // ahead here would put the window start 11 months in the future.
    const now = at(2026, 3, 7, 9, 0);
    expect(resolveResetInstant("Mar 6, 11:59am", WEEK_WINDOW_MS, now)).toEqual(
      at(2026, 3, 6, 11, 59),
    );
  });

  it("rolls a dated reset to next year across the December boundary", () => {
    const now = at(2026, 12, 30, 9, 0);
    expect(resolveResetInstant("Jan 2, 12pm", WEEK_WINDOW_MS, now)).toEqual(at(2027, 1, 2, 12));
  });

  it("returns null for text it cannot read", () => {
    const now = at(2026, 3, 2, 9, 0);
    expect(resolveResetInstant("sometime soon", SESSION_WINDOW_MS, now)).toBeNull();
    expect(resolveResetInstant("Xyz 6, 11:59am", WEEK_WINDOW_MS, now)).toBeNull();
    expect(resolveResetInstant("", SESSION_WINDOW_MS, now)).toBeNull();
  });

  it("reads a Grok weekday reset as the next that weekday", () => {
    // Wednesday 15:00 → next Monday 9am, not the Monday that already passed.
    const now = at(2026, 3, 4, 15, 0);
    expect(resolveResetInstant("Mon 9am", WEEK_WINDOW_MS, now)).toEqual(at(2026, 3, 9, 9));
  });

  it("keeps a Grok weekday reset later today", () => {
    const now = at(2026, 3, 2, 8, 0);
    expect(resolveResetInstant("Mon 9am", WEEK_WINDOW_MS, now)).toEqual(at(2026, 3, 2, 9));
  });

  it("rolls a Grok weekday reset to next week once that time has passed", () => {
    const now = at(2026, 3, 2, 10, 0);
    expect(resolveResetInstant("Mon 9am", WEEK_WINDOW_MS, now)).toEqual(at(2026, 3, 9, 9));
  });

  it("reads a Grok dated 24-hour reset", () => {
    const now = at(2026, 8, 18, 12, 0);
    expect(resolveResetInstant("August 20, 16:13", WEEK_WINDOW_MS, now)).toEqual(
      at(2026, 8, 20, 16, 13),
    );
  });

  it("reads a Grok midnight 24-hour reset", () => {
    const now = at(2026, 5, 25, 12, 0);
    expect(resolveResetInstant("May 29, 00:00", WEEK_WINDOW_MS, now)).toEqual(at(2026, 5, 29, 0));
  });
});

describe("elapsedPercent", () => {
  it("is zero at the start of the window and near full just before reset", () => {
    // Session window ends at 7pm, so it began at 2pm.
    expect(sessionElapsedPercent("7pm", at(2026, 3, 2, 14, 0))).toBe(0);
    expect(sessionElapsedPercent("7pm", at(2026, 3, 2, 16, 30))).toBe(50);
    expect(sessionElapsedPercent("7pm", at(2026, 3, 2, 18, 59))).toBe(100);
  });

  it("measures the weekly window from its reset instant", () => {
    // Window ends Mar 6 12pm, so it began Feb 27 12pm.
    expect(weekElapsedPercent("Mar 6, 12pm", at(2026, 2, 27, 12, 0))).toBe(0);
    expect(weekElapsedPercent("Mar 6, 12pm", at(2026, 3, 3, 0, 0))).toBe(50);
  });

  it("measures a Grok weekly window from a 24-hour dated reset", () => {
    // Window ends Aug 20 16:13, so it began Aug 13 16:13.
    expect(weekElapsedPercent("August 20, 16:13", at(2026, 8, 13, 16, 13))).toBe(0);
    expect(weekElapsedPercent("August 20, 16:13", at(2026, 8, 17, 4, 13))).toBe(50);
  });

  it("measures a Grok weekly window from a weekday reset", () => {
    // Next reset Mon 9am on Wed 15:00 → window began last Monday 9am.
    expect(weekElapsedPercent("Mon 9am", at(2026, 3, 4, 15, 0))).toBe(32);
  });

  it("clamps to 0-100", () => {
    const percent = elapsedPercent("7pm", SESSION_WINDOW_MS, at(2026, 3, 2, 19, 0));
    expect(percent).toBeGreaterThanOrEqual(0);
    expect(percent).toBeLessThanOrEqual(100);
  });

  it("returns null without a reset string", () => {
    expect(sessionElapsedPercent(null)).toBeNull();
    expect(sessionElapsedPercent(undefined)).toBeNull();
    expect(weekElapsedPercent("")).toBeNull();
  });
});

describe("paceVerdict", () => {
  it("flags usage running ahead of the clock", () => {
    expect(paceVerdict(40, 20)).toBe("ahead");
  });

  it("calls a small gap on track in both directions", () => {
    expect(paceVerdict(20 + PACE_TOLERANCE_POINTS, 20)).toBe("onTrack");
    expect(paceVerdict(20 - PACE_TOLERANCE_POINTS, 20)).toBe("onTrack");
  });

  it("flags under-use as behind", () => {
    expect(paceVerdict(5, 60)).toBe("behind");
  });

  it("is unknown when either number is missing", () => {
    // Never guess: a missing number must not read as "on track".
    expect(paceVerdict(null, 20)).toBe("unknown");
    expect(paceVerdict(20, null)).toBe("unknown");
    expect(paceVerdict(undefined, undefined)).toBe("unknown");
  });

  it("treats zero as a real number, not a missing one", () => {
    expect(paceVerdict(0, 50)).toBe("behind");
    expect(paceVerdict(50, 0)).toBe("ahead");
  });
});

describe("formatTimeUntil", () => {
  it("formats hours and minutes", () => {
    expect(formatTimeUntil("7pm", SESSION_WINDOW_MS, at(2026, 3, 2, 16, 46))).toBe("2h 14m");
  });

  it("formats minutes alone under an hour", () => {
    expect(formatTimeUntil("7pm", SESSION_WINDOW_MS, at(2026, 3, 2, 18, 30))).toBe("30m");
  });

  it("formats days and hours for weekly windows", () => {
    expect(formatTimeUntil("Mar 6, 12pm", WEEK_WINDOW_MS, at(2026, 3, 4, 9, 0))).toBe("2d 3h");
  });

  it("returns null when there is nothing to count down", () => {
    expect(formatTimeUntil(null, SESSION_WINDOW_MS)).toBeNull();
    expect(formatTimeUntil("not a time", SESSION_WINDOW_MS)).toBeNull();
  });
});
