import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  registerAtlasRebuilder,
  unregisterAtlasRebuilder,
  notifyTextureAtlasCleared,
  noteTerminalRendered,
  __resetAtlasRebuildersForTest,
} from "./webgl-atlas-rebuild";

/** Let the queued microtask run. */
const flushMicrotasks = () => Promise.resolve();

/** Animation-frame callbacks the module queued, drained by `advanceFrame()`. */
let frameCallbacks: FrameRequestCallback[] = [];

/** Run what the browser would run at the start of the next frame. */
function advanceFrame(): void {
  const due = frameCallbacks;
  frameCallbacks = [];
  for (const callback of due) callback(0);
}

describe("webgl-atlas-rebuild (issue #571)", () => {
  beforeEach(() => {
    frameCallbacks = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      frameCallbacks.push(callback),
    );
    __resetAtlasRebuildersForTest();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("rebuilds again for a clear that arrives in a later frame", async () => {
    const rebuild = vi.fn();
    registerAtlasRebuilder("t-1", rebuild);

    notifyTextureAtlasCleared("t-other", true);
    await flushMicrotasks();
    advanceFrame();
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

  // -- issue #573: the fan-out must cost O(N), not O(N²) --

  it("asks each terminal at most once per frame across separate passes (issue #573)", async () => {
    const ids = ["t-0", "t-1", "t-2", "t-3", "t-4", "t-5"];
    const rebuilds = ids.map((id) => {
      const rebuild = vi.fn();
      registerAtlasRebuilder(id, rebuild);
      return rebuild;
    });

    // A workspace returning from display:none: every pane's ResizeObserver
    // callback clears the atlas in its own task, so each one opens its own
    // pass. Before #573 that was N passes × N rebuilds.
    for (const id of ids) {
      notifyTextureAtlasCleared(id, true);
      await flushMicrotasks();
    }

    for (const rebuild of rebuilds) {
      expect(rebuild.mock.calls.length).toBeLessThanOrEqual(1);
    }
    const total = rebuilds.reduce((sum, rebuild) => sum + rebuild.mock.calls.length, 0);
    expect(total).toBe(ids.length);
  });

  it("asks a terminal again once it has rendered into the fresh atlas (issue #573)", async () => {
    const rebuild = vi.fn();
    registerAtlasRebuilder("t-1", rebuild);

    notifyTextureAtlasCleared("t-other", true);
    await flushMicrotasks();
    // The rebuild left an empty render model, which is why a second clear in
    // the same frame is a no-op for this terminal. A render refills that model
    // with coordinates into the current atlas, so the next clear does reach it.
    noteTerminalRendered("t-1");
    notifyTextureAtlasCleared("t-other", true);
    await flushMicrotasks();

    expect(rebuild).toHaveBeenCalledTimes(2);
  });

  it("asks a re-registered terminal again within the same frame (issue #573)", async () => {
    const first = vi.fn();
    registerAtlasRebuilder("t-1", first);
    notifyTextureAtlasCleared("t-other", true);
    await flushMicrotasks();

    // A profile switch disposes the xterm instance and builds a new one under
    // the same instance id. The new terminal has its own model, so what the
    // previous one did this frame says nothing about it.
    const second = vi.fn();
    registerAtlasRebuilder("t-1", second);
    notifyTextureAtlasCleared("t-other", true);
    await flushMicrotasks();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("asks a terminal that threw again in the same frame (issue #573)", async () => {
    // A throwing rebuild answered nothing, so it must not be counted as done
    // for this frame.
    const throwing = vi.fn(() => {
      throw new Error("rebuild failed");
    });
    registerAtlasRebuilder("t-throwing", throwing);

    notifyTextureAtlasCleared("t-other", true);
    await flushMicrotasks();
    notifyTextureAtlasCleared("t-other", true);
    await flushMicrotasks();

    expect(throwing).toHaveBeenCalledTimes(2);
  });

  it("falls back to per-pass rebuilds without a frame clock (issue #573)", async () => {
    // Non-browser hosts have no requestAnimationFrame to expire the frame set
    // with; skipping would then be permanent, so the coordinator must not skip
    // at all there.
    vi.stubGlobal("requestAnimationFrame", undefined);
    const rebuild = vi.fn();
    registerAtlasRebuilder("t-1", rebuild);

    notifyTextureAtlasCleared("t-other", true);
    await flushMicrotasks();
    notifyTextureAtlasCleared("t-other", true);
    await flushMicrotasks();

    expect(rebuild).toHaveBeenCalledTimes(2);
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
