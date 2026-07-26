import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  registerAtlasRebuilder,
  unregisterAtlasRebuilder,
  notifyTextureAtlasCleared,
  __resetAtlasRebuildersForTest,
} from "./webgl-atlas-rebuild";

/** Let the queued microtask run. */
const flushMicrotasks = () => Promise.resolve();

describe("webgl-atlas-rebuild (issue #571)", () => {
  beforeEach(() => {
    __resetAtlasRebuildersForTest();
  });

  it("rebuilds every other terminal when one clears the shared atlas", async () => {
    const clearer = vi.fn();
    const bystanderA = vi.fn();
    const bystanderB = vi.fn();
    registerAtlasRebuilder("t-clearer", clearer);
    registerAtlasRebuilder("t-a", bystanderA);
    registerAtlasRebuilder("t-b", bystanderB);

    notifyTextureAtlasCleared("t-clearer");
    await flushMicrotasks();

    // The bystanders are the point: xterm re-syncs only the model of the
    // terminal that called clearTextureAtlas().
    expect(bystanderA).toHaveBeenCalledTimes(1);
    expect(bystanderB).toHaveBeenCalledTimes(1);
    // The sole reporter already rebuilt itself before reporting.
    expect(clearer).not.toHaveBeenCalled();
  });

  it("rebuilds the reporters too when more than one clears in the same task", async () => {
    const first = vi.fn();
    const second = vi.fn();
    registerAtlasRebuilder("t-first", first);
    registerAtlasRebuilder("t-second", second);

    // `t-first` rebuilt itself before `t-second` wiped the atlas again, so it is
    // stale despite having reported.
    notifyTextureAtlasCleared("t-first");
    notifyTextureAtlasCleared("t-second");
    await flushMicrotasks();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("does not rebuild before the flush", () => {
    const rebuild = vi.fn();
    registerAtlasRebuilder("t-1", rebuild);

    notifyTextureAtlasCleared("t-other");

    expect(rebuild).not.toHaveBeenCalled();
  });

  it("coalesces a burst of clears in one task into a single pass", async () => {
    const rebuild = vi.fn();
    registerAtlasRebuilder("t-1", rebuild);

    // A workspace returning from display:none rebuilds every pane in it from a
    // single ResizeObserver callback — one pass must cover all of them.
    notifyTextureAtlasCleared("t-a");
    notifyTextureAtlasCleared("t-b");
    notifyTextureAtlasCleared("t-c");
    await flushMicrotasks();

    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it("rebuilds again for a clear that arrives after the previous flush", async () => {
    const rebuild = vi.fn();
    registerAtlasRebuilder("t-1", rebuild);

    notifyTextureAtlasCleared("t-other");
    await flushMicrotasks();
    notifyTextureAtlasCleared("t-other");
    await flushMicrotasks();

    expect(rebuild).toHaveBeenCalledTimes(2);
  });

  it("does not carry a reporter over into the next flush", async () => {
    const rebuild = vi.fn();
    registerAtlasRebuilder("t-1", rebuild);

    // First pass skips t-1 as the sole reporter; the second pass has a different
    // reporter, so t-1 must be rebuilt.
    notifyTextureAtlasCleared("t-1");
    await flushMicrotasks();
    notifyTextureAtlasCleared("t-other");
    await flushMicrotasks();

    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it("drops an unregistered terminal", async () => {
    const gone = vi.fn();
    const alive = vi.fn();
    registerAtlasRebuilder("t-gone", gone);
    registerAtlasRebuilder("t-alive", alive);
    unregisterAtlasRebuilder("t-gone");

    notifyTextureAtlasCleared("t-other");
    await flushMicrotasks();

    expect(gone).not.toHaveBeenCalled();
    expect(alive).toHaveBeenCalledTimes(1);
  });

  it("keeps rebuilding the rest when one terminal throws", async () => {
    const throwing = vi.fn(() => {
      throw new Error("disposed between notify and flush");
    });
    const after = vi.fn();
    registerAtlasRebuilder("t-throwing", throwing);
    registerAtlasRebuilder("t-after", after);

    notifyTextureAtlasCleared("t-other");
    await flushMicrotasks();

    expect(after).toHaveBeenCalledTimes(1);
  });

  it("tolerates a terminal unregistering itself during the flush", async () => {
    const other = vi.fn();
    registerAtlasRebuilder("t-self", () => unregisterAtlasRebuilder("t-other"));
    registerAtlasRebuilder("t-other", other);

    notifyTextureAtlasCleared("t-reporter");
    await flushMicrotasks();

    // Iterating a snapshot keeps this from throwing; the removed entry may or
    // may not have run, but the pass must complete.
    expect(() => notifyTextureAtlasCleared("t-reporter")).not.toThrow();
  });
});
