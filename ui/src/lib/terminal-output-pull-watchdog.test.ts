import { describe, expect, it } from "vitest";
import {
  TERMINAL_OUTPUT_PULL_WATCHDOG_PERIOD_MS,
  TerminalOutputPullWatchdogCadence,
} from "./terminal-output-pull-watchdog";

describe("TerminalOutputPullWatchdogCadence", () => {
  it("defers one moderately delayed tick, then forces the next poll", () => {
    const cadence = new TerminalOutputPullWatchdogCadence(0);

    expect(cadence.shouldPoll(TERMINAL_OUTPUT_PULL_WATCHDOG_PERIOD_MS)).toBe(true);
    expect(cadence.shouldPoll(2_600)).toBe(false);
    expect(cadence.shouldPoll(4_200)).toBe(true);
    expect(cadence.shouldPoll(5_200)).toBe(true);
  });

  it("polls immediately when deferral would consume the receipt deadline margin", () => {
    const cadence = new TerminalOutputPullWatchdogCadence(0);

    expect(cadence.shouldPoll(2_100)).toBe(true);
    expect(cadence.shouldPoll(4_100)).toBe(true);
  });
});
