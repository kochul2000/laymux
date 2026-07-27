import { beforeEach, describe, expect, it } from "vitest";
import {
  recordTerminalOutputRecovery,
  resetTerminalOutputRecoveryCounters,
  terminalOutputRecoveryCounters,
} from "./terminal-output-recovery-metrics";

describe("terminalOutputRecoveryCounters", () => {
  beforeEach(() => resetTerminalOutputRecoveryCounters());

  it("counts each recovery trigger separately per terminal", () => {
    recordTerminalOutputRecovery("t1", "gap");
    recordTerminalOutputRecovery("t1", "gap");
    recordTerminalOutputRecovery("t1", "repair");
    recordTerminalOutputRecovery("t2", "ringEscalation");

    expect(terminalOutputRecoveryCounters("t1")).toEqual({
      gap: 2,
      repair: 1,
      ringEscalation: 0,
      geometryEscalation: 0,
      malformedDelta: 0,
      attachFailure: 0,
    });
    expect(terminalOutputRecoveryCounters("t2").ringEscalation).toBe(1);
  });

  it("reports zeros for a terminal that never recovered", () => {
    expect(terminalOutputRecoveryCounters("unknown")).toEqual({
      gap: 0,
      repair: 0,
      ringEscalation: 0,
      geometryEscalation: 0,
      malformedDelta: 0,
      attachFailure: 0,
    });
  });

  it("returns snapshots that cannot mutate the stored counters", () => {
    const snapshot = recordTerminalOutputRecovery("t1", "gap");
    snapshot.gap = 99;

    expect(terminalOutputRecoveryCounters("t1").gap).toBe(1);
  });
});
