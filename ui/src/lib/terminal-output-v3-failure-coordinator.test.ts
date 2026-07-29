import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  normalizeTerminalOutputSurfaceFailStopReason,
  TerminalOutputV3FailureCoordinator,
} from "./terminal-output-v3-failure-coordinator";

const report = vi.fn<() => Promise<boolean>>();

describe("TerminalOutputV3FailureCoordinator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    report.mockResolvedValue(true);
  });

  it("normalizes only an actual orphan-cap failure to the narrow command reason", () => {
    expect(normalizeTerminalOutputSurfaceFailStopReason("control:close:control_orphan_cap")).toBe(
      "control_orphan_cap",
    );
    expect(normalizeTerminalOutputSurfaceFailStopReason("not_control_orphan_cap")).toBe(
      "surface_unavailable",
    );
    expect(normalizeTerminalOutputSurfaceFailStopReason("receipt_timeout")).toBe(
      "surface_unavailable",
    );
  });

  it("publishes one pending local failure after identity binding", async () => {
    report.mockRejectedValueOnce(new Error("bridge down"));
    const coordinator = new TerminalOutputV3FailureCoordinator("term-1", report);
    coordinator.reportLocal("control:receipt:control_orphan_cap");
    expect(report).not.toHaveBeenCalled();

    expect(coordinator.bindIdentity(7, "lease-7")).toBeUndefined();
    coordinator.disposeSurface();
    await Promise.resolve();

    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith("term-1", 7, "lease-7", "control_orphan_cap");
  });

  it("filters stale backend events and prevents a current event echo", () => {
    const coordinator = new TerminalOutputV3FailureCoordinator("term-1", report);
    coordinator.receiveBackend({
      terminalId: "term-1",
      generation: 6,
      leaseToken: "lease-6",
      reason: "emit_failure",
    });
    expect(coordinator.bindIdentity(7, "lease-7")).toBeUndefined();
    expect(
      coordinator.receiveBackend({
        terminalId: "term-1",
        generation: 7,
        leaseToken: "lease-7",
        reason: "parsed_progress_expired",
      }),
    ).toBe("backend:parsed_progress_expired");

    coordinator.disposeSurface();
    expect(report).not.toHaveBeenCalled();
  });

  it("rejects a same-generation backend failure from a different lease", () => {
    const coordinator = new TerminalOutputV3FailureCoordinator("term-1", report);
    expect(coordinator.bindIdentity(7, "lease-7")).toBeUndefined();

    expect(
      coordinator.receiveBackend({
        terminalId: "term-1",
        generation: 7,
        leaseToken: "lease-old",
        reason: "receipt_timeout",
      }),
    ).toBeUndefined();
    expect(report).not.toHaveBeenCalled();
  });

  it("accepts a current generation pre-attach failure without a lease token", () => {
    const coordinator = new TerminalOutputV3FailureCoordinator("term-1", report);
    coordinator.receiveBackend({
      terminalId: "term-1",
      generation: 7,
      leaseToken: null,
      reason: "parsed_progress_expired",
    });

    expect(coordinator.bindIdentity(7, "lease-7")).toBe("backend:parsed_progress_expired");
    coordinator.disposeSurface();
    expect(report).not.toHaveBeenCalled();
  });

  it("discards a stale pre-attach failure when a newer generation attaches", () => {
    const coordinator = new TerminalOutputV3FailureCoordinator("term-1", report);
    coordinator.receiveBackend({
      terminalId: "term-1",
      generation: 6,
      leaseToken: null,
      reason: "parsed_progress_expired",
    });

    expect(coordinator.bindIdentity(7, "lease-7")).toBeUndefined();
  });

  it("uses a typed failed attach as the current SoT and never echoes it", () => {
    const coordinator = new TerminalOutputV3FailureCoordinator("term-1", report);
    coordinator.receiveBackend({
      terminalId: "term-1",
      generation: 6,
      leaseToken: null,
      reason: "stale_failure",
    });

    expect(
      coordinator.bindFailedAttach({
        kind: "failStopped",
        terminalId: "term-1",
        generation: 7,
        reason: "continuation_expired",
      }),
    ).toBe("backend:continuation_expired");
    coordinator.disposeSurface();
    expect(report).not.toHaveBeenCalled();
  });
});
