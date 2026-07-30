import { beforeEach, describe, expect, it } from "vitest";
import {
  allTerminalInputDeliveryCounters,
  beginTerminalInputDelivery,
  forgetTerminalInputDeliveryCounters,
  resetTerminalInputDeliveryCounters,
  settleTerminalInputDelivery,
  terminalInputDeliveryCounters,
} from "./terminal-input-delivery-metrics";

describe("terminal input delivery metrics", () => {
  beforeEach(resetTerminalInputDeliveryCounters);

  it("keeps payload-free attempt, success, and rejection totals per terminal", () => {
    const first = beginTerminalInputDelivery("t1", 3);
    settleTerminalInputDelivery(first, "succeeded");
    const second = beginTerminalInputDelivery("t1", 2);
    settleTerminalInputDelivery(second, "failed");

    expect(terminalInputDeliveryCounters("t1")).toEqual({
      attempts: 2,
      succeeded: 1,
      failed: 1,
      attemptedBytes: 5,
      succeededBytes: 3,
      failedBytes: 2,
    });
    expect(allTerminalInputDeliveryCounters()).toEqual({
      t1: terminalInputDeliveryCounters("t1"),
    });
  });

  it("forgets totals with the terminal session and returns snapshots", () => {
    beginTerminalInputDelivery("t1", 1);
    const snapshot = terminalInputDeliveryCounters("t1");
    snapshot.attempts = 99;
    expect(terminalInputDeliveryCounters("t1").attempts).toBe(1);

    forgetTerminalInputDeliveryCounters("t1");
    expect(allTerminalInputDeliveryCounters()).toEqual({});
  });

  it("does not recreate a closed or replacement session from a late completion", () => {
    const closedAttempt = beginTerminalInputDelivery("t1", 1);
    forgetTerminalInputDeliveryCounters("t1");
    expect(settleTerminalInputDelivery(closedAttempt, "failed")).toBe(false);
    expect(allTerminalInputDeliveryCounters()).toEqual({});

    const currentAttempt = beginTerminalInputDelivery("t1", 2);
    expect(settleTerminalInputDelivery(closedAttempt, "succeeded")).toBe(false);
    expect(settleTerminalInputDelivery(currentAttempt, "succeeded")).toBe(true);
    expect(terminalInputDeliveryCounters("t1")).toEqual({
      attempts: 1,
      succeeded: 1,
      failed: 0,
      attemptedBytes: 2,
      succeededBytes: 2,
      failedBytes: 0,
    });
  });

  it("settles each attempt at most once", () => {
    const attempt = beginTerminalInputDelivery("t1", 1);
    expect(settleTerminalInputDelivery(attempt, "succeeded")).toBe(true);
    expect(settleTerminalInputDelivery(attempt, "failed")).toBe(false);
    expect(terminalInputDeliveryCounters("t1")).toEqual({
      attempts: 1,
      succeeded: 1,
      failed: 0,
      attemptedBytes: 1,
      succeededBytes: 1,
      failedBytes: 0,
    });
  });
});
