import { beforeEach, describe, expect, it } from "vitest";
import {
  allTerminalOutputV3Diagnostics,
  forgetTerminalOutputV3Diagnostics,
  recordTerminalOutputV3Diagnostics,
  resetTerminalOutputV3DiagnosticsForTest,
} from "./terminal-output-v3-diagnostics";

describe("terminal output v3 diagnostics", () => {
  beforeEach(resetTerminalOutputV3DiagnosticsForTest);

  it("reports lease identity and bounded frontiers without payload bytes", () => {
    recordTerminalOutputV3Diagnostics("terminal-1", {
      state: "fail-stopped",
      reason: "control:receipt:stale",
      generation: 7,
      leaseToken: "lease-7",
      attachEpoch: 4,
      snapshotSeq: 10,
      admittedSeq: 18,
      parsedSeq: 14,
      nextEnvelopeId: 9,
      activeGrantId: null,
      repairCount: 2,
      lastRepairReason: "event-gap:exact",
    });

    const report = allTerminalOutputV3Diagnostics();
    expect(report["terminal-1"]).toMatchObject({
      state: "fail-stopped",
      generation: 7,
      leaseToken: "lease-7",
      admittedSeq: 18,
      parsedSeq: 14,
    });
    expect(JSON.stringify(report)).not.toContain("data");
  });

  it("returns copies and forgets unmounted terminals", () => {
    recordTerminalOutputV3Diagnostics("terminal-1", {
      state: "active",
      reason: null,
      generation: 1,
      leaseToken: "lease-1",
      attachEpoch: 1,
      snapshotSeq: 0,
      admittedSeq: 0,
      parsedSeq: 0,
      nextEnvelopeId: 1,
      activeGrantId: null,
      repairCount: 0,
      lastRepairReason: null,
    });
    const first = allTerminalOutputV3Diagnostics();
    first["terminal-1"].reason = "mutated";
    expect(allTerminalOutputV3Diagnostics()["terminal-1"].reason).toBeNull();

    forgetTerminalOutputV3Diagnostics("terminal-1");
    expect(allTerminalOutputV3Diagnostics()).toEqual({});
  });
});
