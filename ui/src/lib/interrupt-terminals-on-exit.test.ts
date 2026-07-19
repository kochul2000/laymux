import { describe, it, expect, vi } from "vitest";
import {
  CTRL_C,
  INTERRUPT_ROUND_INTERVAL_MS,
  exitInterruptBudgetMs,
  resolveExitInterrupt,
  runInterruptTerminals,
  type ResolvedExitInterrupt,
} from "./interrupt-terminals-on-exit";

describe("resolveExitInterrupt", () => {
  it("defaults to disabled with conservative timing", () => {
    expect(resolveExitInterrupt(undefined)).toEqual({
      enabled: false,
      rounds: 3,
      settleMs: 700,
    });
  });

  it("clamps rounds to 1..=10 and settle to 0..=10000", () => {
    expect(
      resolveExitInterrupt({ interruptTerminals: true, interruptRounds: 0, settleMs: -50 }),
    ).toEqual({
      enabled: true,
      rounds: 1,
      settleMs: 0,
    });
    expect(
      resolveExitInterrupt({ interruptTerminals: true, interruptRounds: 999, settleMs: 999999 }),
    ).toEqual({ enabled: true, rounds: 10, settleMs: 10000 });
  });
});

describe("exitInterruptBudgetMs", () => {
  it("is zero when disabled", () => {
    expect(
      exitInterruptBudgetMs({ interruptTerminals: false, interruptRounds: 5, settleMs: 500 }),
    ).toBe(0);
  });

  it("sums round spacing and settle when enabled", () => {
    expect(
      exitInterruptBudgetMs({ interruptTerminals: true, interruptRounds: 3, settleMs: 700 }),
    ).toBe(3 * INTERRUPT_ROUND_INTERVAL_MS + 700);
  });
});

describe("runInterruptTerminals", () => {
  const enabled = (over: Partial<ResolvedExitInterrupt> = {}): ResolvedExitInterrupt => ({
    enabled: true,
    rounds: 3,
    settleMs: 700,
    ...over,
  });

  it("does nothing when disabled", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const count = await runInterruptTerminals({
      config: { enabled: false, rounds: 3, settleMs: 700 },
      getTerminalIds: () => ["a", "b"],
      write,
      sleep,
    });
    expect(count).toBe(0);
    expect(write).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does nothing when there are no terminals", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const count = await runInterruptTerminals({
      config: enabled(),
      getTerminalIds: () => [],
      write,
      sleep,
    });
    expect(count).toBe(0);
    expect(write).not.toHaveBeenCalled();
  });

  it("sends Ctrl+C to every unique terminal once per round, then settles", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const count = await runInterruptTerminals({
      config: enabled({ rounds: 2, settleMs: 500 }),
      getTerminalIds: () => ["a", "b", "a"], // duplicate collapses
      write,
      sleep,
    });

    expect(count).toBe(2);
    // 2 rounds x 2 terminals = 4 writes, all ETX
    expect(write).toHaveBeenCalledTimes(4);
    expect(write.mock.calls.every(([, data]) => data === CTRL_C)).toBe(true);
    expect(write).toHaveBeenCalledWith("a", CTRL_C);
    expect(write).toHaveBeenCalledWith("b", CTRL_C);

    // sleeps: 1 inter-round gap + 1 settle
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, INTERRUPT_ROUND_INTERVAL_MS);
    expect(sleep).toHaveBeenNthCalledWith(2, 500);
  });

  it("skips the settle sleep when settleMs is 0", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);
    await runInterruptTerminals({
      config: enabled({ rounds: 1, settleMs: 0 }),
      getTerminalIds: () => ["a"],
      write,
      sleep,
    });
    // rounds=1 -> no inter-round gap, settleMs=0 -> no settle
    expect(sleep).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("keeps interrupting other terminals when one write fails", async () => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(new Error("terminal gone"))
      .mockResolvedValue(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const count = await runInterruptTerminals({
      config: enabled({ rounds: 1, settleMs: 0 }),
      getTerminalIds: () => ["a", "b"],
      write,
      sleep,
    });
    expect(count).toBe(2);
    expect(write).toHaveBeenCalledTimes(2);
  });
});
