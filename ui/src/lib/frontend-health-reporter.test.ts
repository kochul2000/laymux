import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportFrontendHealth } from "./tauri-api";
import {
  frontendBridgeCounters,
  resetFrontendHealthForTest,
  startFrontendHealthReporter,
} from "./frontend-health-reporter";

vi.mock("./tauri-api", () => ({
  reportFrontendHealth: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./terminal-output-pipeline-metrics", () => ({
  allTerminalOutputPipelineCounters: vi.fn(() => ({
    "terminal-1": { deltaEvents: 2 },
  })),
}));

vi.mock("./terminal-input-delivery-metrics", () => ({
  allTerminalInputDeliveryCounters: vi.fn(() => ({
    "terminal-1": { attempts: 2, failed: 1 },
  })),
}));

vi.mock("./terminal-output-v3-diagnostics", () => ({
  allTerminalOutputV3Diagnostics: vi.fn(() => ({
    "terminal-1": {
      state: "active",
      reason: null,
      generation: 7,
      leaseToken: "lease-7",
      attachEpoch: 2,
      snapshotSeq: 10,
      admittedSeq: 14,
      parsedSeq: 14,
      nextEnvelopeId: 4,
      activeGrantId: null,
      repairCount: 1,
      lastRepairReason: "watchdog:exact",
    },
  })),
  allTerminalOutputV3ControlTrace: vi.fn(() => ({
    "terminal-1": [{ kind: "hold", envelopeId: 4, grantId: "grant-1", seq: 12, envelopePass: 1 }],
  })),
}));

const START_MS = Date.UTC(2026, 6, 28, 0, 0, 0);

describe("startFrontendHealthReporter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    resetFrontendHealthForTest();
    vi.mocked(reportFrontendHealth).mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("probes every 250 ms, reports every second, and stops cleanly", async () => {
    const stop = startFrontendHealthReporter();

    await vi.advanceTimersByTimeAsync(249);
    expect(reportFrontendHealth).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(reportFrontendHealth).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(750);
    expect(reportFrontendHealth).toHaveBeenCalledTimes(1);
    expect(reportFrontendHealth).toHaveBeenLastCalledWith({
      sentAtMs: START_MS + 1_000,
      probeLagMs: 0,
      probeLagMaxMs: 0,
      stalls: 0,
      bridge: frontendBridgeCounters(),
      pipeline: { "terminal-1": { deltaEvents: 2 } },
      inputDelivery: { "terminal-1": { attempts: 2, failed: 1 } },
      terminalOutputV3: {
        "terminal-1": {
          state: "active",
          reason: null,
          generation: 7,
          leaseToken: "lease-7",
          attachEpoch: 2,
          snapshotSeq: 10,
          admittedSeq: 14,
          parsedSeq: 14,
          nextEnvelopeId: 4,
          activeGrantId: null,
          repairCount: 1,
          lastRepairReason: "watchdog:exact",
        },
      },
      terminalOutputV3ControlTrace: {
        "terminal-1": [
          { kind: "hold", envelopeId: 4, grantId: "grant-1", seq: 12, envelopePass: 1 },
        ],
      },
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(reportFrontendHealth).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reportFrontendHealth).toHaveBeenCalledTimes(2);
  });

  it("reports a delayed probe as a stall as soon as the main thread resumes", async () => {
    startFrontendHealthReporter();
    await vi.advanceTimersByTimeAsync(1_000);

    // Move wall time without running the scheduled timeout. The next 250 ms
    // callback therefore observes the main-thread pause as probe lateness.
    vi.setSystemTime(START_MS + 3_000);
    await vi.advanceTimersByTimeAsync(250);

    expect(reportFrontendHealth).toHaveBeenCalledTimes(2);
    const stalledReport = vi.mocked(reportFrontendHealth).mock.calls[1]?.[0];
    expect(stalledReport).toMatchObject({
      probeLagMs: 2_000,
      probeLagMaxMs: 2_000,
      stalls: 1,
    });
  });

  it("continues reporting after one invoke failure", async () => {
    vi.mocked(reportFrontendHealth)
      .mockRejectedValueOnce(new Error("temporary IPC failure"))
      .mockResolvedValue(undefined);
    startFrontendHealthReporter();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(reportFrontendHealth).toHaveBeenCalledTimes(1);

    // A rejected diagnostic push must retry on the next probe tick rather than
    // leave Rust serving a stale report for another full interval.
    await vi.advanceTimersByTimeAsync(250);
    expect(reportFrontendHealth).toHaveBeenCalledTimes(2);
  });
});
