import { describe, expect, it, vi } from "vitest";
import {
  boundedTerminalOutputControlBackoff,
  recoverTerminalOutputControl,
  settleTerminalOutputControl,
  terminalOutputControlMayRetry,
} from "./terminal-output-control-watchdog";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("settleTerminalOutputControl", () => {
  it("times out a pending control IPC and absorbs its orphan completion", async () => {
    vi.useFakeTimers();
    try {
      const pending = deferred<string>();
      const outcome = settleTerminalOutputControl(pending.promise, 5_000);

      await vi.advanceTimersByTimeAsync(5_000);
      await expect(outcome).resolves.toEqual({ kind: "timeout" });

      pending.resolve("stale lease");
      await Promise.resolve();
      await Promise.resolve();
      await expect(outcome).resolves.toEqual({ kind: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an ordinary rejection distinct from a watchdog timeout", async () => {
    const error = new Error("bridge rejected");
    await expect(settleTerminalOutputControl(Promise.reject(error), 5_000)).resolves.toEqual({
      kind: "rejected",
      error,
    });
  });

  it("absorbs an orphan rejection that arrives after timeout", async () => {
    vi.useFakeTimers();
    try {
      const pending = deferred<string>();
      const outcome = settleTerminalOutputControl(pending.promise, 5_000);

      await vi.advanceTimersByTimeAsync(5_000);
      await expect(outcome).resolves.toEqual({ kind: "timeout" });
      pending.reject(new Error("late bridge rejection"));
      await Promise.resolve();
      await Promise.resolve();

      await expect(outcome).resolves.toEqual({ kind: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps exponential timeout recovery backoff", () => {
    expect([0, 1, 2, 3, 4, 5, 20].map(boundedTerminalOutputControlBackoff)).toEqual([
      0, 50, 100, 200, 400, 800, 1_000,
    ]);
    expect([1, 5, 6, 7, 20].map(terminalOutputControlMayRetry)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  it("publishes epoch replacement before best-effort diagnostics and absorbs sabotage", () => {
    const order: string[] = [];

    expect(() =>
      recoverTerminalOutputControl(
        () => order.push("replace"),
        () => {
          order.push("diagnose");
          throw new Error("patched console or counter");
        },
      ),
    ).not.toThrow();
    expect(order).toEqual(["replace", "diagnose"]);
  });
});
