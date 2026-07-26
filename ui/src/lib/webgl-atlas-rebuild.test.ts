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

    notifyTextureAtlasCleared("t-clearer", true);
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

    // The skip is only claimed for a sole reporter; with two, both go through
    // the pass rather than resting on an argument about the second wipe landing
    // on an already-empty atlas.
    notifyTextureAtlasCleared("t-first", true);
    notifyTextureAtlasCleared("t-second", true);
    await flushMicrotasks();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("does not rebuild before the flush", () => {
    const rebuild = vi.fn();
    registerAtlasRebuilder("t-1", rebuild);

    notifyTextureAtlasCleared("t-other", true);

    expect(rebuild).not.toHaveBeenCalled();
  });

  it("coalesces a burst of clears in one task into a single pass", async () => {
    const rebuild = vi.fn();
    registerAtlasRebuilder("t-1", rebuild);

    // Clears that land in the same task share one pass. (Panes returning from
    // display:none do NOT — each TerminalView has its own ResizeObserver and a
    // microtask checkpoint runs between callbacks. This covers the same-task
    // case only.)
    notifyTextureAtlasCleared("t-a", true);
    notifyTextureAtlasCleared("t-b", true);
    notifyTextureAtlasCleared("t-c", true);
    await flushMicrotasks();

    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it("rebuilds again for a clear that arrives after the previous flush", async () => {
    const rebuild = vi.fn();
    registerAtlasRebuilder("t-1", rebuild);

    notifyTextureAtlasCleared("t-other", true);
    await flushMicrotasks();
    notifyTextureAtlasCleared("t-other", true);
    await flushMicrotasks();

    expect(rebuild).toHaveBeenCalledTimes(2);
  });

  it("does not carry a reporter over into the next flush", async () => {
    const rebuild = vi.fn();
    registerAtlasRebuilder("t-1", rebuild);

    // First pass skips t-1 as the sole reporter; the second pass has a different
    // reporter, so t-1 must be rebuilt.
    notifyTextureAtlasCleared("t-1", true);
    await flushMicrotasks();
    notifyTextureAtlasCleared("t-other", true);
    await flushMicrotasks();

    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it("drops an unregistered terminal", async () => {
    const gone = vi.fn();
    const alive = vi.fn();
    registerAtlasRebuilder("t-gone", gone);
    registerAtlasRebuilder("t-alive", alive);
    unregisterAtlasRebuilder("t-gone");

    notifyTextureAtlasCleared("t-other", true);
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

    notifyTextureAtlasCleared("t-other", true);
    await flushMicrotasks();

    expect(after).toHaveBeenCalledTimes(1);
  });

  it("rebuilds a reporter whose own rebuild failed", async () => {
    const failed = vi.fn();
    registerAtlasRebuilder("t-failed", failed);

    // The atlas wipe may already have landed while this terminal's model was
    // not cleared, so it is stale like everyone else — skipping it would leave
    // the reporter itself broken.
    notifyTextureAtlasCleared("t-failed", false);
    await flushMicrotasks();

    expect(failed).toHaveBeenCalledTimes(1);
  });

  it("ignores a report raised from inside the pass", async () => {
    // A rebuild callback re-arming the microtask would starve the event loop.
    const reentrant = vi.fn(() => notifyTextureAtlasCleared("t-reentrant", true));
    registerAtlasRebuilder("t-reentrant", reentrant);

    notifyTextureAtlasCleared("t-other", true);
    await flushMicrotasks();
    await flushMicrotasks();

    expect(reentrant).toHaveBeenCalledTimes(1);
  });

  it("does not run a pass that has no report left", async () => {
    const rebuild = vi.fn();

    // A reset between the notify and the microtask disarms the pass; the orphan
    // flush must not rebuild whatever registered in the meantime.
    notifyTextureAtlasCleared("t-gone", true);
    __resetAtlasRebuildersForTest();
    registerAtlasRebuilder("t-new", rebuild);
    await flushMicrotasks();

    expect(rebuild).not.toHaveBeenCalled();
  });

  it("keeps iterating past an entry removed during the flush", async () => {
    const order: string[] = [];
    // `t-a` unregisters `t-b` while the pass is walking the map. Iterating a
    // snapshot is what keeps `t-b` (and anything after it) from being dropped
    // mid-pass.
    registerAtlasRebuilder("t-a", () => {
      order.push("a");
      unregisterAtlasRebuilder("t-b");
    });
    registerAtlasRebuilder("t-b", () => order.push("b"));

    notifyTextureAtlasCleared("t-reporter", true);
    await flushMicrotasks();

    expect(order).toEqual(["a", "b"]);
  });
});
