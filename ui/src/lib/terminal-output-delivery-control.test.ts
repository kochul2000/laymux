import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalOutputControlOperationRegistry } from "./terminal-output-control-registry";
import {
  TerminalOutputDeliveryControlSender,
  type TerminalOutputDeliveryControlRequest,
} from "./terminal-output-delivery-control";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const receipt = (
  overrides: Partial<TerminalOutputDeliveryControlRequest["identity"]> = {},
): TerminalOutputDeliveryControlRequest => ({
  identity: {
    kind: "receipt",
    terminalId: "terminal-1",
    generation: 7,
    leaseToken: "lease-7",
    envelopeId: 41,
    grantId: null,
    ...overrides,
  },
  payload: { seqEnd: 64 },
});

const hold = (): TerminalOutputDeliveryControlRequest => ({
  identity: {
    kind: "hold",
    terminalId: "terminal-1",
    generation: 7,
    leaseToken: "lease-7",
    envelopeId: 42,
    grantId: "grant-1",
  },
  payload: { frameStartSeq: 8 },
});

const close = (): TerminalOutputDeliveryControlRequest => ({
  identity: {
    kind: "close",
    terminalId: "terminal-1",
    generation: 7,
    leaseToken: "lease-7",
    envelopeId: 43,
    grantId: "grant-1",
  },
  payload: { closeSeq: 512, reason: "completed" },
});

function sender(
  options: {
    registry?: TerminalOutputControlOperationRegistry;
    invoke?: (request: Readonly<TerminalOutputDeliveryControlRequest>) => Promise<boolean>;
    isCurrent?: (request: Readonly<TerminalOutputDeliveryControlRequest>) => boolean;
    timeoutMs?: number;
    maxTimedOutOrphans?: number;
    terminalId?: string;
  } = {},
) {
  const registry = options.registry ?? new TerminalOutputControlOperationRegistry(6, 6);
  const scope = registry.mount(options.terminalId ?? "terminal-1");
  const invoke = vi.fn(options.invoke ?? (() => Promise.resolve(true)));
  const target = new TerminalOutputDeliveryControlSender({
    scope,
    invoke,
    isCurrent: options.isCurrent ?? (() => true),
    timeoutMs: options.timeoutMs,
    maxTimedOutOrphans: options.maxTimedOutOrphans,
  });
  return { registry, scope, invoke, target };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("TerminalOutputDeliveryControlSender", () => {
  it("passes a frozen full receipt/hold/close identity and immutable payload in call order", async () => {
    const seen: Readonly<TerminalOutputDeliveryControlRequest>[] = [];
    const { target } = sender({
      invoke: async (request) => {
        seen.push(request);
        return true;
      },
    });
    const mutableReceipt = receipt();
    const first = target.send(mutableReceipt);
    mutableReceipt.identity.leaseToken = "mutated";
    if (mutableReceipt.identity.kind === "receipt") mutableReceipt.payload.seqEnd = 999;

    await expect(Promise.all([first, target.send(hold()), target.send(close())])).resolves.toEqual([
      expect.objectContaining({ kind: "accepted" }),
      expect.objectContaining({ kind: "accepted" }),
      expect.objectContaining({ kind: "accepted" }),
    ]);
    expect(seen.map(({ identity }) => identity.kind)).toEqual(["receipt", "hold", "close"]);
    expect(seen[0]).toEqual(receipt());
    expect(seen.every((request) => Object.isFrozen(request))).toBe(true);
    expect(seen.every((request) => Object.isFrozen(request.identity))).toBe(true);
    expect(seen.every((request) => Object.isFrozen(request.payload))).toBe(true);
  });

  it("deduplicates the same identity and payload while pending and after acceptance", async () => {
    const pending = deferred<boolean>();
    const { target, invoke } = sender({ invoke: () => pending.promise });
    const request = receipt();

    const first = target.send(request);
    const duplicate = target.send(receipt());
    expect(duplicate).toBe(first);
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledOnce();
    pending.resolve(true);
    await expect(first).resolves.toMatchObject({ kind: "accepted" });
    await expect(target.send(receipt())).resolves.toMatchObject({ kind: "accepted" });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("returns identity_conflict fail-stop for the same identity with another payload", async () => {
    const pending = deferred<boolean>();
    const { target, invoke } = sender({ invoke: () => pending.promise });
    const first = target.send(receipt());
    await Promise.resolve();
    const conflict = receipt();
    if (conflict.identity.kind === "receipt") conflict.payload.seqEnd = 65;

    await expect(target.send(conflict)).resolves.toMatchObject({
      kind: "fail-stop",
      reason: "identity_conflict",
    });
    pending.resolve(true);
    await expect(first).resolves.toMatchObject({
      kind: "fail-stop",
      reason: "identity_conflict",
    });
    expect(invoke).toHaveBeenCalledOnce();
    await expect(target.send(close())).resolves.toMatchObject({
      kind: "fail-stop",
      reason: "identity_conflict",
    });
  });

  it("retries only the exact immutable request after a 5-second invoke timeout", async () => {
    vi.useFakeTimers();
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    const calls: Readonly<TerminalOutputDeliveryControlRequest>[] = [];
    const { target, scope } = sender({
      invoke: (request) => {
        calls.push(request);
        return calls.length === 1 ? first.promise : second.promise;
      },
    });
    const result = target.send(hold());
    await Promise.resolve();
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(scope.outstanding("hold")).toBe(2);
    second.resolve(true);
    await expect(result).resolves.toMatchObject({ kind: "accepted" });
    expect(scope.outstanding("hold")).toBe(1);

    first.reject(new Error("late stale rejection"));
    await Promise.resolve();
    await Promise.resolve();
    expect(scope.outstanding("hold")).toBe(0);
    await expect(result).resolves.toMatchObject({ kind: "accepted" });
  });

  it("waits in shared delivery FIFO without starting the bridge call", async () => {
    const registry = new TerminalOutputControlOperationRegistry(1, 1);
    const blockerScope = registry.mount("blocker");
    const blocker = blockerScope.tryStart("receipt");
    const { target, invoke } = sender({ registry });

    const result = target.send(receipt());
    await Promise.resolve();
    expect(invoke).not.toHaveBeenCalled();
    blocker?.settle();
    await expect(result).resolves.toMatchObject({ kind: "accepted" });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("waits when another terminal fills capacity with a healthy in-flight control", async () => {
    const registry = new TerminalOutputControlOperationRegistry(6, 1);
    const blockerScope = registry.mount("other-terminal");
    const blocker = blockerScope.tryStart("receipt");
    const { target, invoke, scope } = sender({ registry, maxTimedOutOrphans: 1 });

    const result = target.send(receipt());
    await Promise.resolve();

    expect(invoke).not.toHaveBeenCalled();
    expect(scope.globalOutstanding("receipt")).toBe(1);
    expect(scope.globalTimedOut("receipt")).toBe(0);

    blocker?.settle();
    await expect(result).resolves.toMatchObject({ kind: "accepted" });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("fail-stops when another terminal fills the WebView timed-out orphan cap", async () => {
    // Keep spare operation capacity so this proves the orphan gate itself,
    // rather than an incidental capacity rejection, blocks the new call.
    const registry = new TerminalOutputControlOperationRegistry(6, 6);
    const blockerScope = registry.mount("other-terminal");
    const blocker = blockerScope.tryStart("receipt");
    blocker?.markTimedOut();
    const { target, invoke, scope } = sender({ registry, maxTimedOutOrphans: 1 });

    const result = target.send(receipt());

    await expect(result).resolves.toMatchObject({
      kind: "fail-stop",
      reason: "control_orphan_cap",
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(scope.localOutstanding("receipt")).toBe(0);
    expect(scope.globalOutstanding("receipt")).toBe(1);
    expect(scope.globalTimedOut("receipt")).toBe(1);

    blocker?.settle();
    expect(scope.globalOutstanding("receipt")).toBe(0);
    expect(scope.globalTimedOut("receipt")).toBe(0);
    await expect(result).resolves.toMatchObject({ reason: "control_orphan_cap" });
  });

  it("finishes stale from capacity wait when the surface/token is no longer current", async () => {
    const registry = new TerminalOutputControlOperationRegistry(1, 1);
    const blocker = registry.mount("blocker").tryStart("receipt");
    let current = true;
    const { target, invoke } = sender({ registry, isCurrent: () => current });
    const result = target.send(receipt());
    await Promise.resolve();

    current = false;
    blocker?.settle();
    await expect(result).resolves.toMatchObject({ kind: "stale" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("absorbs a resolved old-token completion without accepting it", async () => {
    const pending = deferred<boolean>();
    let current = true;
    const { target } = sender({ invoke: () => pending.promise, isCurrent: () => current });
    const result = target.send(receipt());
    current = false;
    pending.resolve(true);

    await expect(result).resolves.toMatchObject({ kind: "stale" });
  });

  it("returns a bounded control_orphan_cap fail-stop for permanently pending calls", async () => {
    vi.useFakeTimers();
    const pending: Array<ReturnType<typeof deferred<boolean>>> = [];
    const { target, invoke, scope } = sender({
      timeoutMs: 10,
      maxTimedOutOrphans: 2,
      invoke: () => {
        const operation = deferred<boolean>();
        pending.push(operation);
        return operation.promise;
      },
    });
    const result = target.send(close());

    await vi.advanceTimersByTimeAsync(20);
    await expect(result).resolves.toMatchObject({
      kind: "fail-stop",
      reason: "control_orphan_cap",
    });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(scope.outstanding("close")).toBe(2);

    pending[0].resolve(true);
    pending[1].reject(new Error("late permanent rejection"));
    await Promise.resolve();
    await Promise.resolve();
    expect(scope.outstanding("close")).toBe(0);
    await expect(result).resolves.toMatchObject({ reason: "control_orphan_cap" });
  });

  it("wakes every FIFO waiter when cross-terminal timeouts reach the orphan cap", async () => {
    vi.useFakeTimers();
    const registry = new TerminalOutputControlOperationRegistry(6, 6);
    const pending: Array<ReturnType<typeof deferred<boolean>>> = [];
    const outcomes: Array<{ kind: string; reason?: string }> = [];
    const results = Array.from({ length: 8 }, (_, index) => {
      const terminalId = `terminal-${index + 1}`;
      const { target } = sender({
        registry,
        terminalId,
        timeoutMs: 10,
        maxTimedOutOrphans: 6,
        invoke: () => {
          const operation = deferred<boolean>();
          pending.push(operation);
          return operation.promise;
        },
      });
      const result = target.send(receipt({ terminalId }));
      void result.then((outcome) => outcomes.push(outcome));
      return result;
    });

    await vi.advanceTimersByTimeAsync(10);
    await Promise.resolve();
    await Promise.resolve();

    expect(pending).toHaveLength(6);
    expect(outcomes).toHaveLength(8);
    expect(outcomes).toEqual(
      expect.arrayContaining(
        Array.from({ length: 8 }, () =>
          expect.objectContaining({ kind: "fail-stop", reason: "control_orphan_cap" }),
        ),
      ),
    );

    for (const operation of pending) operation.resolve(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(registry.globalOutstanding("receipt")).toBe(0);
    await expect(Promise.all(results)).resolves.toHaveLength(8);
  });

  it("returns ordinary rejection and lets an explicit same-request retry call again", async () => {
    const error = new Error("temporary bridge rejection");
    let attempt = 0;
    const { target, invoke } = sender({
      invoke: async () => {
        attempt += 1;
        if (attempt === 1) throw error;
        return true;
      },
    });

    await expect(target.send(receipt())).resolves.toEqual(
      expect.objectContaining({ kind: "rejected", error }),
    );
    await expect(target.send(receipt())).resolves.toMatchObject({ kind: "accepted" });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("disposes a capacity waiter as stale without reset/replay/reattach callbacks", async () => {
    const registry = new TerminalOutputControlOperationRegistry(1, 1);
    const blocker = registry.mount("blocker").tryStart("receipt");
    const { target, invoke } = sender({ registry });
    const result = target.send(receipt());
    await Promise.resolve();

    target.dispose();
    await expect(result).resolves.toMatchObject({ kind: "stale" });
    blocker?.settle();
    expect(invoke).not.toHaveBeenCalled();
  });
});
