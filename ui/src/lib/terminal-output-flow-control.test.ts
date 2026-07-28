import { describe, expect, it, vi } from "vitest";
import { TerminalOutputFlowAcknowledger } from "./terminal-output-flow-control";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("TerminalOutputFlowAcknowledger", () => {
  it("never acknowledges past an out-of-order parsed range", async () => {
    const send = vi.fn().mockResolvedValue(true);
    const acknowledger = new TerminalOutputFlowAcknowledger(0, send);

    acknowledger.complete(4, 8);
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();

    acknowledger.complete(0, 4);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(8));
  });

  it("coalesces contiguous progress behind one in-flight IPC", async () => {
    const first = deferred<boolean>();
    const send = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(true);
    const acknowledger = new TerminalOutputFlowAcknowledger(0, send);

    acknowledger.complete(0, 4);
    acknowledger.complete(4, 8);
    acknowledger.complete(8, 12);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(4);

    first.resolve(true);
    await vi.waitFor(() => expect(send).toHaveBeenLastCalledWith(12));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("acknowledges only the intersection parsed by visible and checkpoint xterms", async () => {
    const visible = deferred<void>();
    const checkpoint = deferred<void>();
    const send = vi.fn().mockResolvedValue(true);
    const acknowledger = new TerminalOutputFlowAcknowledger(10, send);

    acknowledger.completeAfterBothParsed(10, 18, visible.promise, checkpoint.promise);
    visible.resolve();
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();

    checkpoint.resolve();
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(18));
  });

  it("retries the same contiguous prefix after a transient IPC failure", async () => {
    vi.useFakeTimers();
    const send = vi
      .fn<(_: number) => Promise<boolean>>()
      .mockRejectedValueOnce(new Error("bridge busy"))
      .mockResolvedValue(true);
    const onError = vi.fn();
    const acknowledger = new TerminalOutputFlowAcknowledger(0, send, {
      retryMs: 25,
      onError,
    });

    acknowledger.complete(0, 4);
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(25);
    expect(send).toHaveBeenNthCalledWith(2, 4);
    vi.useRealTimers();
  });

  it("drops stale completion and retry work after an attach epoch is disposed", async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockRejectedValue(new Error("bridge busy"));
    const acknowledger = new TerminalOutputFlowAcknowledger(0, send, { retryMs: 25 });

    acknowledger.complete(0, 4);
    await Promise.resolve();
    acknowledger.dispose();
    acknowledger.complete(4, 8);
    await vi.advanceTimersByTimeAsync(100);

    expect(send).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("drops a late two-model completion after its attach epoch is disposed", async () => {
    const visible = deferred<void>();
    const checkpoint = deferred<void>();
    const send = vi.fn().mockResolvedValue(true);
    const acknowledger = new TerminalOutputFlowAcknowledger(0, send);

    acknowledger.completeAfterBothParsed(0, 4, visible.promise, checkpoint.promise);
    acknowledger.dispose();
    visible.resolve();
    checkpoint.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(send).not.toHaveBeenCalled();
  });

  it("reports an active token rejected by the backend exactly once", async () => {
    const send = vi.fn().mockResolvedValue(false);
    const onLeaseLost = vi.fn();
    const acknowledger = new TerminalOutputFlowAcknowledger(0, send, { onLeaseLost });

    acknowledger.complete(0, 4);
    await vi.waitFor(() => expect(onLeaseLost).toHaveBeenCalledOnce());
    acknowledger.complete(4, 8);
    await Promise.resolve();

    expect(send).toHaveBeenCalledOnce();
    expect(onLeaseLost).toHaveBeenCalledOnce();
  });
});
