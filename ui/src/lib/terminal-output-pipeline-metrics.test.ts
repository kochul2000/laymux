import { beforeEach, describe, expect, it } from "vitest";
import {
  allTerminalOutputPipelineCounters,
  forgetTerminalOutputPipelineCounters,
  recordTerminalOutputPipeline,
  resetTerminalOutputPipelineCounters,
  terminalOutputPipelineCounters,
} from "./terminal-output-pipeline-metrics";

describe("terminalOutputPipelineCounters", () => {
  beforeEach(() => resetTerminalOutputPipelineCounters());

  it("starts every counter at zero for an unknown terminal", () => {
    const counters = terminalOutputPipelineCounters("nobody");
    expect(counters.deltaEvents).toBe(0);
    expect(counters.attachReplayBytes).toBe(0);
    expect(counters.writeRequests).toBe(0);
    expect(counters.xtermParseMaxMs).toBe(0);
    expect(Object.values(counters).every((value) => value === 0)).toBe(true);
  });

  it("accumulates totals per terminal", () => {
    recordTerminalOutputPipeline("t1", "deltaEvents");
    recordTerminalOutputPipeline("t1", "deltaEvents");
    recordTerminalOutputPipeline("t1", "deltaBytes", 4096);
    recordTerminalOutputPipeline("t2", "xtermWrites");

    expect(terminalOutputPipelineCounters("t1").deltaEvents).toBe(2);
    expect(terminalOutputPipelineCounters("t1").deltaBytes).toBe(4096);
    expect(terminalOutputPipelineCounters("t1").xtermWrites).toBe(0);
    expect(terminalOutputPipelineCounters("t2").xtermWrites).toBe(1);
  });

  it("keeps high-water marks instead of summing them", () => {
    recordTerminalOutputPipeline("t1", "writeQueueMaxDepth", 3);
    recordTerminalOutputPipeline("t1", "writeQueueMaxBytes", 4096);
    recordTerminalOutputPipeline("t1", "writeQueueMaxBytes", 2048);
    recordTerminalOutputPipeline("t1", "writeBatchMaxParts", 12);
    recordTerminalOutputPipeline("t1", "writeSubmitMaxMs", 4.5);
    recordTerminalOutputPipeline("t1", "xtermParseMaxMs", 18);
    recordTerminalOutputPipeline("t1", "xtermParseMaxMs", 7);
    recordTerminalOutputPipeline("t1", "fitDeferredMaxMs", 900);
    recordTerminalOutputPipeline("t1", "fitDeferredMaxMs", 120);

    const counters = terminalOutputPipelineCounters("t1");
    expect(counters.writeQueueMaxDepth).toBe(3);
    expect(counters.writeQueueMaxBytes).toBe(4096);
    expect(counters.writeBatchMaxParts).toBe(12);
    expect(counters.writeSubmitMaxMs).toBe(4.5);
    expect(counters.xtermParseMaxMs).toBe(18);
    expect(counters.fitDeferredMaxMs).toBe(900);
  });

  it("snapshots every terminal for the diagnostics report", () => {
    recordTerminalOutputPipeline("t1", "fits", 3);
    recordTerminalOutputPipeline("t2", "atlasRebuilds");

    const all = allTerminalOutputPipelineCounters();
    expect(Object.keys(all).sort()).toEqual(["t1", "t2"]);
    expect(all.t1.fits).toBe(3);
    expect(all.t2.atlasRebuilds).toBe(1);
  });

  it("returns copies so a reader cannot mutate the live totals", () => {
    recordTerminalOutputPipeline("t1", "fits");
    const snapshot = terminalOutputPipelineCounters("t1");
    snapshot.fits = 999;
    expect(terminalOutputPipelineCounters("t1").fits).toBe(1);
  });

  it("drops a terminal whose backend session is gone", () => {
    recordTerminalOutputPipeline("t1", "deltaEvents");
    forgetTerminalOutputPipelineCounters("t1");
    expect(allTerminalOutputPipelineCounters()).toEqual({});
    // Idempotent: pane-teardown paths remove several panes per gesture.
    forgetTerminalOutputPipelineCounters("t1");
  });
});
