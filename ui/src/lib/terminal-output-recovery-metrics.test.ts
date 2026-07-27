import { beforeEach, describe, expect, it } from "vitest";
import {
  recordTerminalOutputRecovery,
  resetTerminalOutputRecoveryCounters,
  terminalOutputRecoveryCounters,
} from "./terminal-output-recovery-metrics";

describe("terminalOutputRecoveryCounters", () => {
  beforeEach(() => resetTerminalOutputRecoveryCounters());

  const zeros = {
    gap: 0,
    repair: 0,
    ringEscalation: 0,
    geometryEscalation: 0,
    nestedGap: 0,
    repairFailure: 0,
    malformedDelta: 0,
    attachFailure: 0,
  };

  it("counts each recovery trigger separately per terminal", () => {
    recordTerminalOutputRecovery("t1", "gap");
    recordTerminalOutputRecovery("t1", "gap");
    recordTerminalOutputRecovery("t1", "repair");
    recordTerminalOutputRecovery("t2", "ringEscalation");

    expect(terminalOutputRecoveryCounters("t1")).toEqual({ ...zeros, gap: 2, repair: 1 });
    expect(terminalOutputRecoveryCounters("t2").ringEscalation).toBe(1);
  });

  // ADR-0072 hangs a revisit condition on `ringEscalation` alone, so the buckets
  // that share its "escalated to a full reattach" outcome must stay distinct.
  it.each(["nestedGap", "repairFailure", "geometryEscalation"] as const)(
    "keeps %s out of the ringEscalation bucket",
    (event) => {
      recordTerminalOutputRecovery("t1", event);

      expect(terminalOutputRecoveryCounters("t1")).toEqual({ ...zeros, [event]: 1 });
    },
  );

  it("reports zeros for a terminal that never recovered", () => {
    expect(terminalOutputRecoveryCounters("unknown")).toEqual(zeros);
  });

  it("returns snapshots that cannot mutate the stored counters", () => {
    const snapshot = recordTerminalOutputRecovery("t1", "gap");
    snapshot.gap = 99;

    expect(terminalOutputRecoveryCounters("t1").gap).toBe(1);
  });
});
