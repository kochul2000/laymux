import { describe, expect, it, vi } from "vitest";
import { DeferredParsedCallbackQueue } from "./deferred-parsed-callback-queue";

describe("DeferredParsedCallbackQueue", () => {
  it("reports completion only after the drained xterm callback runs", () => {
    const queue = new DeferredParsedCallbackQueue();
    const parsed = vi.fn();
    const discarded = vi.fn();
    queue.push(parsed, discarded);

    const complete = queue.drain();
    expect(parsed).not.toHaveBeenCalled();
    complete?.onParsed();

    expect(parsed).toHaveBeenCalledOnce();
    expect(discarded).not.toHaveBeenCalled();
  });

  it("releases lifecycle waiters without reporting stale writes as parsed", () => {
    const queue = new DeferredParsedCallbackQueue();
    const parsed = vi.fn();
    const discarded = vi.fn();
    queue.push(parsed, discarded);

    queue.discard();

    expect(parsed).not.toHaveBeenCalled();
    expect(discarded).toHaveBeenCalledOnce();
    expect(queue.drain()).toBeUndefined();
  });

  it("preserves every discard callback after drain without reporting parsed", () => {
    const queue = new DeferredParsedCallbackQueue();
    const firstParsed = vi.fn();
    const secondParsed = vi.fn();
    const firstDiscarded = vi.fn();
    const secondDiscarded = vi.fn();
    queue.push(firstParsed, firstDiscarded);
    queue.push(secondParsed, secondDiscarded);

    const drained = queue.drain();
    drained?.onDiscard();
    drained?.onDiscard();
    drained?.onParsed();

    expect(firstParsed).not.toHaveBeenCalled();
    expect(secondParsed).not.toHaveBeenCalled();
    expect(firstDiscarded).toHaveBeenCalledOnce();
    expect(secondDiscarded).toHaveBeenCalledOnce();
  });

  it("preserves discard-only entries until the stabilized batch settles", () => {
    const queue = new DeferredParsedCallbackQueue();
    const firstDiscarded = vi.fn();
    const lastParsed = vi.fn();
    const lastDiscarded = vi.fn();
    queue.push(undefined, firstDiscarded);
    queue.push(lastParsed, lastDiscarded);

    const drained = queue.drain();
    drained?.onDiscard();
    drained?.onParsed();

    expect(firstDiscarded).toHaveBeenCalledOnce();
    expect(lastDiscarded).toHaveBeenCalledOnce();
    expect(lastParsed).not.toHaveBeenCalled();
  });

  it("snapshots immediate-prefix discard without consuming a successful held tail", () => {
    const queue = new DeferredParsedCallbackQueue();
    const parsed = vi.fn();
    const discarded = vi.fn();
    queue.push(parsed, discarded);

    const discardPrefix = queue.snapshotDiscard();
    expect(queue.drain()).toBeDefined();
    expect(parsed).not.toHaveBeenCalled();

    // Model the drained held-tail parse winning before a late prefix failure.
    const second = new DeferredParsedCallbackQueue();
    const secondParsed = vi.fn();
    const secondDiscarded = vi.fn();
    second.push(secondParsed, secondDiscarded);
    const lateDiscard = second.snapshotDiscard();
    second.drain()?.onParsed();
    lateDiscard?.();
    expect(secondParsed).toHaveBeenCalledOnce();
    expect(secondDiscarded).not.toHaveBeenCalled();

    discardPrefix?.();
    expect(discarded).toHaveBeenCalledOnce();
    expect(parsed).not.toHaveBeenCalled();
  });
});
