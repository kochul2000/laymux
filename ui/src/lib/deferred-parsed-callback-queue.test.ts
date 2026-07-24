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
    complete?.();

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
});
