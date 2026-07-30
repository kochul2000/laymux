import { describe, expect, it } from "vitest";
import {
  TERMINAL_OUTPUT_PULL_WATCHDOG_PERIOD_MS,
  TerminalOutputPullWatchdogCadence,
} from "./terminal-output-pull-watchdog";

describe("TerminalOutputPullWatchdogCadence", () => {
  it("gives queued output a full period after a moderately delayed tick", () => {
    const cadence = new TerminalOutputPullWatchdogCadence(0);

    expect(cadence.shouldPoll(TERMINAL_OUTPUT_PULL_WATCHDOG_PERIOD_MS)).toBe(true);
    expect(cadence.shouldPoll(2_600)).toBe(false);
    expect(cadence.shouldPoll(3_000)).toBe(false);
    expect(cadence.shouldPoll(3_599)).toBe(false);
    expect(cadence.shouldPoll(3_600)).toBe(true);
    expect(cadence.shouldPoll(4_600)).toBe(true);
  });

  it("caps delayed-event grace at a three-period poll interval", () => {
    const cadence = new TerminalOutputPullWatchdogCadence(0);

    expect(cadence.shouldPoll(2_100)).toBe(false);
    expect(cadence.shouldPoll(2_999)).toBe(false);
    expect(cadence.shouldPoll(3_000)).toBe(true);

    const alreadyPastBound = new TerminalOutputPullWatchdogCadence(0);
    expect(alreadyPastBound.shouldPoll(3_001)).toBe(true);
  });

  it("forces the next callback after the server reports a pending direct event", () => {
    const cadence = new TerminalOutputPullWatchdogCadence(0);

    expect(cadence.shouldPoll(1_000)).toBe(true);
    expect(cadence.shouldPoll(2_600)).toBe(false);
    cadence.requireNextPoll();
    expect(cadence.shouldPoll(2_700)).toBe(true);
    expect(cadence.shouldPoll(3_700)).toBe(true);
  });
});
