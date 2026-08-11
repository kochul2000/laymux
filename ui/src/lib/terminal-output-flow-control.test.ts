import { describe, expect, it, vi } from "vitest";
import { TerminalOutputFlowAcknowledger } from "./terminal-output-flow-control";
import { TerminalOutputControlOperationRegistry } from "./terminal-output-control-registry";

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

  it("admits normal ACK capacity competitors in FIFO order without replacing their senders", async () => {
    const registry = new TerminalOutputControlOperationRegistry(1, 1);
    const occupiedScope = registry.mount("occupied");
    const occupied = occupiedScope.tryStart("ack");
    const firstScope = registry.mount("first");
    const secondScope = registry.mount("second");
    const firstAck = deferred<boolean>();
    const secondAck = deferred<boolean>();
    const firstSend = vi.fn().mockReturnValue(firstAck.promise);
    const secondSend = vi.fn().mockReturnValue(secondAck.promise);
    const first = new TerminalOutputFlowAcknowledger(0, firstSend, {
      tryStartOperation: () => firstScope.tryStart("ack"),
      onAdmissionBlocked: (resume: () => void) => firstScope.waitForCapacity("ack", resume),
    });
    const second = new TerminalOutputFlowAcknowledger(0, secondSend, {
      tryStartOperation: () => secondScope.tryStart("ack"),
      onAdmissionBlocked: (resume: () => void) => secondScope.waitForCapacity("ack", resume),
    });

    first.complete(0, 4);
    second.complete(0, 8);
    first.complete(4, 6);
    expect(firstSend).not.toHaveBeenCalled();
    expect(secondSend).not.toHaveBeenCalled();

    occupied?.settle();
    await vi.waitFor(() => expect(firstSend).toHaveBeenCalledWith(6));
    expect(secondSend).not.toHaveBeenCalled();

    firstAck.resolve(true);
    await vi.waitFor(() => expect(secondSend).toHaveBeenCalledWith(8));
    secondAck.resolve(true);
    await vi.waitFor(() => expect(registry.globalOutstanding("ack")).toBe(0));
  });

  it("returns an unused ACK reservation when its waiting sender is disposed", async () => {
    const registry = new TerminalOutputControlOperationRegistry(1, 1);
    const occupiedScope = registry.mount("occupied");
    const occupied = occupiedScope.tryStart("ack");
    const waitingScope = registry.mount("waiting");
    const send = vi.fn().mockResolvedValue(true);
    const acknowledger = new TerminalOutputFlowAcknowledger(0, send, {
      tryStartOperation: () => waitingScope.tryStart("ack"),
      onAdmissionBlocked: (resume) => waitingScope.waitForCapacity("ack", resume),
    });

    acknowledger.complete(0, 4);
    acknowledger.dispose();
    occupied?.settle();
    await Promise.resolve();

    expect(send).not.toHaveBeenCalled();
    expect(registry.globalOutstanding("ack")).toBe(0);
  });

  it("does not arm the ACK watchdog while waiting and rechecks a real orphan hard cap", async () => {
    vi.useFakeTimers();
    try {
      const registry = new TerminalOutputControlOperationRegistry(1, 1);
      const occupiedScope = registry.mount("occupied");
      const occupiedAck = deferred<boolean>();
      const occupiedTimeout = vi.fn();
      const occupied = new TerminalOutputFlowAcknowledger(
        0,
        vi.fn().mockReturnValue(occupiedAck.promise),
        {
          tryStartOperation: () => occupiedScope.tryStart("ack"),
          timeoutMs: 5,
          onTimeout: occupiedTimeout,
        },
      );
      const waitingScope = registry.mount("waiting");
      const send = vi.fn().mockResolvedValue(true);
      const onTimeout = vi.fn();
      const onOrphanCap = vi.fn();
      const acknowledger = new TerminalOutputFlowAcknowledger(0, send, {
        tryStartOperation: () => waitingScope.tryStart("ack"),
        onAdmissionBlocked: (resume) => {
          if (waitingScope.orphanCapacityExhausted("ack")) {
            onOrphanCap();
            acknowledger.dispose();
            return;
          }
          return waitingScope.waitForCapacityOrTimeout("ack", resume);
        },
        timeoutMs: 5,
        onTimeout,
      });

      occupied.complete(0, 4);
      acknowledger.complete(0, 4);
      await vi.advanceTimersByTimeAsync(4);
      expect(onTimeout).not.toHaveBeenCalled();
      expect(onOrphanCap).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(occupiedTimeout).toHaveBeenCalledOnce();
      expect(onOrphanCap).toHaveBeenCalledOnce();
      expect(send).not.toHaveBeenCalled();
      expect(occupiedScope.globalTimedOut("ack")).toBe(1);

      occupiedAck.resolve(true);
      await Promise.resolve();
      await Promise.resolve();
      expect(occupiedScope.globalTimedOut("ack")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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

  it("keeps the ordinary rejection retry alive when its diagnostics throw", async () => {
    vi.useFakeTimers();
    try {
      const send = vi
        .fn<(_: number) => Promise<boolean>>()
        .mockRejectedValueOnce(new Error("bridge busy"))
        .mockResolvedValue(true);
      const acknowledger = new TerminalOutputFlowAcknowledger(0, send, {
        retryMs: 25,
        onError: () => {
          throw new Error("patched console");
        },
      });

      acknowledger.complete(0, 4);
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(25);

      expect(send).toHaveBeenNthCalledWith(2, 4);
    } finally {
      vi.useRealTimers();
    }
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

  it("retires a permanently pending ACK exactly once and ignores its late completion", async () => {
    vi.useFakeTimers();
    try {
      const pending = deferred<boolean>();
      const send = vi.fn().mockReturnValue(pending.promise);
      const onTimeout = vi.fn();
      const onConfirmed = vi.fn();
      const scope = new TerminalOutputControlOperationRegistry(6).mount("terminal-1");
      const acknowledger = new TerminalOutputFlowAcknowledger(0, send, {
        timeoutMs: 5_000,
        onTimeout,
        tryStartOperation: () => scope.tryStart("ack"),
        onConfirmed,
      });

      acknowledger.complete(0, 4);
      expect(scope.outstanding("ack")).toBe(1);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(onTimeout).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(onTimeout).toHaveBeenCalledOnce();
      expect(scope.outstanding("ack")).toBe(1);
      expect(scope.localTimedOut("ack")).toBe(1);
      expect(scope.globalTimedOut("ack")).toBe(1);
      acknowledger.complete(4, 8);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(send).toHaveBeenCalledTimes(1);

      pending.resolve(true);
      await Promise.resolve();
      await Promise.resolve();
      expect(onConfirmed).not.toHaveBeenCalled();
      expect(onTimeout).toHaveBeenCalledOnce();
      expect(scope.outstanding("ack")).toBe(0);
      expect(scope.localTimedOut("ack")).toBe(0);
      expect(scope.globalTimedOut("ack")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries the same prefix in place after a timeout and absorbs the late completion", async () => {
    vi.useFakeTimers();
    try {
      const scope = new TerminalOutputControlOperationRegistry(6).mount("terminal-1");
      const first = deferred<boolean>();
      const send = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(true);
      const onTimeout = vi.fn();
      const onConfirmed = vi.fn();
      const acknowledger = new TerminalOutputFlowAcknowledger(0, send, {
        timeoutMs: 5_000,
        retryOnTimeout: true,
        onTimeout,
        onConfirmed,
        tryStartOperation: () => scope.tryStart("ack"),
      });

      acknowledger.complete(0, 4);
      expect(send).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(onTimeout).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(onTimeout).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenNthCalledWith(2, 4);
      expect(scope.localTimedOut("ack")).toBe(1);
      await Promise.resolve();
      await Promise.resolve();
      expect(onConfirmed).toHaveBeenCalledWith(4);

      first.resolve(true);
      await Promise.resolve();
      await Promise.resolve();
      expect(scope.outstanding("ack")).toBe(0);
      expect(scope.localTimedOut("ack")).toBe(0);

      await vi.advanceTimersByTimeAsync(20_000);
      expect(send).toHaveBeenCalledTimes(2);
      expect(onTimeout).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("folds progress parsed during a timed-out ACK into its in-place retry", async () => {
    vi.useFakeTimers();
    try {
      const first = deferred<boolean>();
      const send = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(true);
      const acknowledger = new TerminalOutputFlowAcknowledger(0, send, {
        timeoutMs: 5_000,
        retryOnTimeout: true,
      });

      acknowledger.complete(0, 4);
      acknowledger.complete(4, 12);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenLastCalledWith(4);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(send).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenLastCalledWith(12);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles a v3 waiter with the late acceptance of a timed-out ACK", async () => {
    vi.useFakeTimers();
    try {
      const first = deferred<boolean>();
      const second = deferred<boolean>();
      const send = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      const acknowledger = new TerminalOutputFlowAcknowledger(0, send, {
        timeoutMs: 5_000,
        retryOnTimeout: true,
      });
      const settled = vi.fn();

      void acknowledger.completeAndWait(0, 4).then(settled);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(send).toHaveBeenCalledTimes(2);
      expect(settled).not.toHaveBeenCalled();

      first.resolve(true);
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toHaveBeenCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the rejection retry owned by the current send when a stale ACK rejects late", async () => {
    vi.useFakeTimers();
    try {
      const first = deferred<boolean>();
      const second = deferred<boolean>();
      const send = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      const onError = vi.fn();
      const acknowledger = new TerminalOutputFlowAcknowledger(0, send, {
        timeoutMs: 5_000,
        retryMs: 25,
        retryOnTimeout: true,
        onError,
      });

      acknowledger.complete(0, 4);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(send).toHaveBeenCalledTimes(2);

      first.reject(new Error("late bridge failure"));
      await Promise.resolve();
      await Promise.resolve();
      expect(onError).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(100);
      expect(send).toHaveBeenCalledTimes(2);

      second.resolve(true);
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the replacement watchdog armed when a stale timed-out ACK settles", async () => {
    vi.useFakeTimers();
    try {
      const first = deferred<boolean>();
      const second = deferred<boolean>();
      const send = vi
        .fn<(_: number) => Promise<boolean>>()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise)
        .mockReturnValue(deferred<boolean>().promise);
      const onTimeout = vi.fn();
      const acknowledger = new TerminalOutputFlowAcknowledger(0, send, {
        timeoutMs: 5_000,
        retryOnTimeout: true,
        onTimeout,
      });

      acknowledger.complete(0, 4);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(send).toHaveBeenCalledTimes(2);

      // The stale settlement must not disarm the replacement's own watchdog.
      first.reject(new Error("late bridge failure"));
      await Promise.resolve();
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(onTimeout).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenCalledTimes(3);
      expect(send).toHaveBeenNthCalledWith(3, 4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retires the sender when a timed-out ACK later reports a lost lease", async () => {
    vi.useFakeTimers();
    try {
      const first = deferred<boolean>();
      const second = deferred<boolean>();
      const send = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      const onLeaseLost = vi.fn();
      const acknowledger = new TerminalOutputFlowAcknowledger(0, send, {
        timeoutMs: 5_000,
        retryOnTimeout: true,
        onLeaseLost,
      });

      acknowledger.complete(0, 4);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(send).toHaveBeenCalledTimes(2);

      first.resolve(false);
      await Promise.resolve();
      await Promise.resolve();
      expect(onLeaseLost).toHaveBeenCalledOnce();

      acknowledger.complete(4, 8);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands orphan-cap fail-stop to admission when in-place retries exhaust the budget", async () => {
    vi.useFakeTimers();
    try {
      const scope = new TerminalOutputControlOperationRegistry(2, 2).mount("terminal-1");
      const send = vi.fn(() => deferred<boolean>().promise);
      const onOrphanCap = vi.fn();
      const acknowledger = new TerminalOutputFlowAcknowledger(0, send, {
        timeoutMs: 5_000,
        retryOnTimeout: true,
        tryStartOperation: () => scope.tryStart("ack"),
        onAdmissionBlocked: (resume) => {
          if (scope.orphanCapacityExhausted("ack")) {
            onOrphanCap();
            acknowledger.dispose();
            return;
          }
          return scope.waitForCapacityOrTimeout("ack", resume);
        },
      });

      acknowledger.complete(0, 4);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(send).toHaveBeenCalledTimes(2);
      expect(onOrphanCap).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(send).toHaveBeenCalledTimes(2);
      expect(onOrphanCap).toHaveBeenCalledOnce();
      expect(scope.globalTimedOut("ack")).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks ACK bridge creation when real timed-out orphans fill the budget", async () => {
    const scope = new TerminalOutputControlOperationRegistry(6).mount("terminal-1");
    for (let index = 0; index < 6; index += 1) expect(scope.tryStart("ack")).toBeDefined();
    const send = vi.fn().mockResolvedValue(true);
    const onAdmissionBlocked = vi.fn();
    const acknowledger = new TerminalOutputFlowAcknowledger(0, send, {
      tryStartOperation: () => scope.tryStart("ack"),
      onAdmissionBlocked,
    });

    acknowledger.complete(0, 4);
    await Promise.resolve();

    expect(send).not.toHaveBeenCalled();
    expect(onAdmissionBlocked).toHaveBeenCalledOnce();
  });

  it("keeps a pre-timeout ACK charged after sender unmount until its Promise settles", async () => {
    const registry = new TerminalOutputControlOperationRegistry(1);
    const firstMount = registry.mount("terminal-1");
    const pending = deferred<boolean>();
    const send = vi.fn().mockReturnValue(pending.promise);
    const acknowledger = new TerminalOutputFlowAcknowledger(0, send, {
      tryStartOperation: () => firstMount.tryStart("ack"),
    });

    acknowledger.complete(0, 4);
    expect(firstMount.outstanding("ack")).toBe(1);
    acknowledger.dispose();
    firstMount.dispose();

    const remount = registry.mount("terminal-1");
    expect(remount.tryStart("ack")).toBeUndefined();
    pending.resolve(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(remount.outstanding("ack")).toBe(0);
  });

  it("reports a settled ACK so a caller can reset only the ACK-timeout backoff", async () => {
    const onConfirmed = vi.fn();
    const acknowledger = new TerminalOutputFlowAcknowledger(0, vi.fn().mockResolvedValue(true), {
      onConfirmed,
    });

    acknowledger.complete(0, 4);
    await vi.waitFor(() => expect(onConfirmed).toHaveBeenCalledWith(4));
  });

  it("settles a v3 waiter only after the backend confirms its parsed prefix", async () => {
    const first = deferred<boolean>();
    const send = vi.fn().mockReturnValue(first.promise);
    const acknowledger = new TerminalOutputFlowAcknowledger(0, send);
    const settled = vi.fn();

    void acknowledger.completeAndWait(0, 4).then(settled);
    await Promise.resolve();
    expect(send).toHaveBeenCalledWith(4);
    expect(settled).not.toHaveBeenCalled();

    first.resolve(true);
    await vi.waitFor(() => expect(settled).toHaveBeenCalledWith(true));
  });

  it("coalesces v3 waiters and resolves each at its backend-confirmed frontier", async () => {
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    const send = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const acknowledger = new TerminalOutputFlowAcknowledger(0, send);
    const firstSettled = vi.fn();
    const secondSettled = vi.fn();

    void acknowledger.completeAndWait(0, 4).then(firstSettled);
    void acknowledger.completeAndWait(4, 8).then(secondSettled);
    first.resolve(true);
    await vi.waitFor(() => expect(firstSettled).toHaveBeenCalledWith(true));
    expect(secondSettled).not.toHaveBeenCalled();
    expect(send).toHaveBeenLastCalledWith(8);

    second.resolve(true);
    await vi.waitFor(() => expect(secondSettled).toHaveBeenCalledWith(true));
  });

  it("fails pending v3 confirmation waiters when their lease owner is retired", async () => {
    const pending = deferred<boolean>();
    const acknowledger = new TerminalOutputFlowAcknowledger(
      0,
      vi.fn().mockReturnValue(pending.promise),
    );
    const settled = vi.fn();

    void acknowledger.completeAndWait(0, 4).then(settled);
    acknowledger.dispose();
    await Promise.resolve();
    expect(settled).toHaveBeenCalledWith(false);

    pending.resolve(true);
    await Promise.resolve();
    expect(settled).toHaveBeenCalledTimes(1);
  });
});
