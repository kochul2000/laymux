import { describe, expect, it } from "vitest";
import {
  decideTerminalOutputReplacement,
  terminalOutputSurfaceAvailability,
  type TerminalOutputSurfaceLifecycle,
} from "./terminal-output-surface-lifecycle";

function lifecycle(
  overrides: Partial<TerminalOutputSurfaceLifecycle> = {},
): TerminalOutputSurfaceLifecycle {
  return {
    generation: 7,
    leaseToken: "lease-7",
    attachEpoch: 3,
    visible: { alive: true, ready: true, generation: 7, leaseToken: "lease-7" },
    checkpoint: { alive: true, ready: true, generation: 7, leaseToken: "lease-7" },
    disposed: false,
    failStoppedReason: null,
    stabilizerHolding: false,
    capacityWaiting: false,
    ...overrides,
  };
}

describe("terminal output surface lifecycle", () => {
  it.each([
    ["ordinary", {}],
    ["stabilizer hold", { stabilizerHolding: true }],
    ["capacity wait", { capacityWaiting: true }],
    ["both bounded waits", { stabilizerHolding: true, capacityWaiting: true }],
  ])("keeps a live parser pair healthy during %s", (_name, overrides) => {
    expect(terminalOutputSurfaceAvailability(lifecycle(overrides))).toEqual({
      kind: "healthy",
      backpressured: Boolean(
        (overrides as Partial<TerminalOutputSurfaceLifecycle>).stabilizerHolding ||
        (overrides as Partial<TerminalOutputSurfaceLifecycle>).capacityWaiting,
      ),
    });
  });

  it.each([
    ["disposed", { disposed: true }],
    ["visible parser dead", { visible: { alive: false, ready: false } }],
    ["checkpoint parser dead", { checkpoint: { alive: false, ready: false } }],
    [
      "stale visible token",
      {
        visible: { alive: true, ready: true, generation: 7, leaseToken: "old-lease" },
      },
    ],
    [
      "stale checkpoint generation",
      {
        checkpoint: { alive: true, ready: true, generation: 6, leaseToken: "lease-7" },
      },
    ],
  ])("marks %s unavailable", (_name, overrides) => {
    expect(terminalOutputSurfaceAvailability(lifecycle(overrides))).toMatchObject({
      kind: "unavailable",
    });
  });

  it("makes an explicit delivery fail-stop authoritative", () => {
    expect(
      terminalOutputSurfaceAvailability(lifecycle({ failStoppedReason: "continuation_expired" })),
    ).toEqual({ kind: "unavailable", reason: "continuation_expired" });
  });

  it("blocks destructive replacement while a healthy continuation grant is active", () => {
    expect(decideTerminalOutputReplacement(lifecycle(), true)).toBe("wait-for-grant-close");
    expect(decideTerminalOutputReplacement(lifecycle(), false)).toBe("allow");
  });

  it("fails stopped instead of resetting an unavailable surface with an active grant", () => {
    expect(decideTerminalOutputReplacement(lifecycle({ disposed: true }), true)).toBe("fail-stop");
  });
});
