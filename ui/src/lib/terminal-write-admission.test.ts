import { describe, expect, it, vi } from "vitest";
import { attemptTerminalWrite } from "./terminal-write-admission";

describe("attemptTerminalWrite", () => {
  it("keeps an accepted byte outcome when post-admission metrics throw", () => {
    let parsed = 0;
    let callback: (() => void) | undefined;
    const discard = vi.fn();
    const restore = vi.fn();

    const result = attemptTerminalWrite({
      write: () => {
        callback = () => {
          parsed += 1;
        };
      },
      isBackpressure: () => false,
      onAccepted: () => {
        throw new Error("metric sabotage");
      },
      restoreBackpressure: restore,
      onBackpressure: vi.fn(),
      onRejectedWarning: vi.fn(),
      onDiscard: discard,
    });

    expect(result).toBe(true);
    expect(discard).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    callback?.();
    expect(parsed).toBe(1);
  });

  it("restores the exact rejected batch before fallible warning and metrics", () => {
    const order: string[] = [];
    const batch = { data: new Uint8Array([1, 2, 3]) };
    const restored: unknown[] = [];

    const result = attemptTerminalWrite({
      write: () => {
        throw new Error("write data discarded, use flow control");
      },
      isBackpressure: () => true,
      onAccepted: vi.fn(),
      restoreBackpressure: () => {
        order.push("restore");
        restored.push(batch);
      },
      onRejectedWarning: () => {
        order.push("warning");
        throw new Error("console sabotage");
      },
      onBackpressure: () => {
        order.push("metric");
        throw new Error("metric sabotage");
      },
      onDiscard: vi.fn(),
    });

    expect(result).toBe(false);
    expect(restored).toEqual([batch]);
    expect(order).toEqual(["restore", "warning", "metric"]);
  });
});
