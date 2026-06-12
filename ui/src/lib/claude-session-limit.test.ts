import { describe, it, expect } from "vitest";
import {
  detectClaudeSessionLimitFromOutput,
  computeSessionLimitResumeAt,
} from "./claude-session-limit";

describe("detectClaudeSessionLimitFromOutput", () => {
  it("detects the canonical session limit banner with timezone", () => {
    const text = "⎿  You've hit your session limit · resets 1:50pm (Asia/Seoul)\r\n";
    const d = detectClaudeSessionLimitFromOutput(text);
    expect(d).toBeDefined();
    expect(d?.hour).toBe(13);
    expect(d?.minute).toBe(50);
    expect(d?.timeZone).toBe("Asia/Seoul");
    expect(d?.key).toBe("13:50|Asia/Seoul");
  });

  it("detects am times and maps 12am/12pm correctly", () => {
    expect(
      detectClaudeSessionLimitFromOutput("You've hit your session limit · resets 9:05am (UTC)"),
    ).toMatchObject({ hour: 9, minute: 5 });
    expect(
      detectClaudeSessionLimitFromOutput("You've hit your session limit · resets 12:00am (UTC)"),
    ).toMatchObject({ hour: 0, minute: 0 });
    expect(
      detectClaudeSessionLimitFromOutput("You've hit your session limit · resets 12:30pm (UTC)"),
    ).toMatchObject({ hour: 12, minute: 30 });
  });

  it("detects times without minutes (e.g. resets 7pm)", () => {
    const d = detectClaudeSessionLimitFromOutput(
      "You've hit your session limit · resets 7pm (Asia/Seoul)",
    );
    expect(d).toMatchObject({ hour: 19, minute: 0 });
  });

  it("detects banner without timezone (falls back to local)", () => {
    const d = detectClaudeSessionLimitFromOutput("You've hit your session limit · resets 1:50pm");
    expect(d).toBeDefined();
    expect(d?.timeZone).toBeUndefined();
    expect(d?.key).toBe("13:50|local");
  });

  it("detects the curly-apostrophe and usage-limit variants", () => {
    expect(
      detectClaudeSessionLimitFromOutput("You’ve hit your session limit · resets 2pm (UTC)"),
    ).toBeDefined();
    expect(
      detectClaudeSessionLimitFromOutput("You've hit your usage limit · resets 2pm (UTC)"),
    ).toBeDefined();
  });

  it("survives ANSI escapes interleaved in the banner", () => {
    const text =
      "\x1b[38;5;246m⎿  You've hit your session limit\x1b[m · \x1b[1mresets 1:50pm (Asia/Seoul)\x1b[m";
    const d = detectClaudeSessionLimitFromOutput(text);
    expect(d).toMatchObject({ hour: 13, minute: 50, timeZone: "Asia/Seoul" });
  });

  it("uses the last banner when several are present", () => {
    const text =
      "You've hit your session limit · resets 1:50pm (Asia/Seoul)\n" +
      "You've hit your session limit · resets 3:10pm (Asia/Seoul)\n";
    expect(detectClaudeSessionLimitFromOutput(text)).toMatchObject({ hour: 15, minute: 10 });
  });

  it("returns undefined for unrelated output", () => {
    expect(detectClaudeSessionLimitFromOutput("normal terminal output")).toBeUndefined();
    expect(detectClaudeSessionLimitFromOutput("resets 1:50pm (Asia/Seoul)")).toBeUndefined();
    expect(
      detectClaudeSessionLimitFromOutput("You've hit your session limit but no time"),
    ).toBeUndefined();
  });
});

describe("computeSessionLimitResumeAt", () => {
  // 2026-06-12T03:00:00Z == 2026-06-12 12:00 KST (Asia/Seoul, UTC+9, no DST)
  const NOW = Date.UTC(2026, 5, 12, 3, 0, 0);

  it("computes the next reset instant in the given timezone plus delay", () => {
    const d = detectClaudeSessionLimitFromOutput(
      "You've hit your session limit · resets 1:50pm (Asia/Seoul)",
    )!;
    // 13:50 KST == 04:50 UTC, +60s delay
    expect(computeSessionLimitResumeAt(d, NOW, 60)).toBe(Date.UTC(2026, 5, 12, 4, 51, 0));
  });

  it("rolls over to the next day when the reset time already passed", () => {
    const d = detectClaudeSessionLimitFromOutput(
      "You've hit your session limit · resets 10:00am (Asia/Seoul)",
    )!;
    // 10:00 KST already passed at 12:00 KST → tomorrow 10:00 KST == 01:00 UTC
    expect(computeSessionLimitResumeAt(d, NOW, 60)).toBe(Date.UTC(2026, 5, 13, 1, 1, 0));
  });

  it("treats a reset within the recent-past grace window as already reset", () => {
    const d = detectClaudeSessionLimitFromOutput(
      "You've hit your session limit · resets 11:55am (Asia/Seoul)",
    )!;
    // 11:55 KST was 5 minutes ago → resume = max(reset + delay, now) = now (delay 60s already elapsed)
    expect(computeSessionLimitResumeAt(d, NOW, 60)).toBe(NOW);
    // With a longer delay the remaining part still applies: 11:55 + 600s = 12:05 KST
    expect(computeSessionLimitResumeAt(d, NOW, 600)).toBe(Date.UTC(2026, 5, 12, 3, 5, 0));
  });

  it("falls back to local time when the timezone is missing or invalid", () => {
    const now = Date.now();
    const future = new Date(now + 2 * 60 * 60 * 1000); // +2h, same day or rollover both fine
    const hour24 = future.getHours();
    const d = {
      hour: hour24,
      minute: future.getMinutes(),
      timeZone: undefined,
      key: `${hour24}:${future.getMinutes()}|local`,
    };
    const resumeAt = computeSessionLimitResumeAt(d, now, 60);
    const resetAt = new Date(resumeAt - 60_000);
    expect(resumeAt).toBeGreaterThan(now);
    expect(resetAt.getHours()).toBe(hour24);
    expect(resetAt.getMinutes()).toBe(future.getMinutes());

    const invalid = { ...d, timeZone: "Not/AZone" };
    expect(computeSessionLimitResumeAt(invalid, now, 60)).toBe(resumeAt);
  });

  it("never returns an instant in the past", () => {
    const d = detectClaudeSessionLimitFromOutput(
      "You've hit your session limit · resets 11:59am (Asia/Seoul)",
    )!;
    expect(computeSessionLimitResumeAt(d, NOW, 0)).toBe(NOW);
  });
});
