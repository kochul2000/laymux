import { describe, expect, it, vi } from "vitest";
import { TerminalWriteFairScheduler } from "./terminal-write-fair-scheduler";

function createHarness() {
  const scheduled: Array<() => void> = [];
  const scheduler = new TerminalWriteFairScheduler((task) => {
    scheduled.push(task);
  });
  const runNextTask = () => {
    const task = scheduled.shift();
    expect(task).toBeDefined();
    task?.();
  };
  return { scheduler, scheduled, runNextTask };
}

describe("TerminalWriteFairScheduler", () => {
  it("admits one physical write at a time and rotates waiting panes", () => {
    const { scheduler, scheduled, runNextTask } = createHarness();
    const order: string[] = [];
    let releaseA: (() => void) | undefined;
    let releaseB: (() => void) | undefined;

    scheduler.request("pane-a", (release) => {
      order.push("a1");
      releaseA = release;
    });
    scheduler.request("pane-b", (release) => {
      order.push("b1");
      releaseB = release;
    });

    expect(order).toEqual(["a1"]);
    expect(scheduled).toHaveLength(0);

    scheduler.request("pane-a", (release) => {
      order.push("a2");
      release();
    });
    releaseA?.();
    expect(scheduled).toHaveLength(1);

    runNextTask();
    expect(order).toEqual(["a1", "b1"]);
    releaseB?.();
    runNextTask();
    expect(order).toEqual(["a1", "b1", "a2"]);
  });

  it("deduplicates a pane while its next turn is already queued", () => {
    const { scheduler, runNextTask } = createHarness();
    const run = vi.fn((release: () => void) => release());
    let releaseActive: (() => void) | undefined;

    scheduler.request("active", (release) => {
      releaseActive = release;
    });
    scheduler.request("pane-a", run);
    scheduler.request("pane-a", run);
    scheduler.request("pane-a", run);
    releaseActive?.();
    runNextTask();

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("cancels a mounted pane without stranding the global lease", () => {
    const { scheduler, scheduled, runNextTask } = createHarness();
    const order: string[] = [];
    let staleRelease: (() => void) | undefined;

    scheduler.request("pane-a", (release) => {
      order.push("a");
      staleRelease = release;
    });
    scheduler.request("pane-b", (release) => {
      order.push("b");
      release();
    });
    scheduler.cancel("pane-a");
    expect(scheduled).toHaveLength(1);
    staleRelease?.();
    expect(scheduled).toHaveLength(1);
    runNextTask();
    expect(order).toEqual(["a", "b"]);
  });

  it("can drop a queued retry without releasing an accepted active write", () => {
    const { scheduler, scheduled, runNextTask } = createHarness();
    const order: string[] = [];
    let releaseA: (() => void) | undefined;

    scheduler.request("pane-a", (release) => {
      order.push("a");
      releaseA = release;
    });
    scheduler.request("pane-b", (release) => {
      order.push("b");
      release();
    });
    scheduler.request("pane-a", (release) => {
      order.push("stale-a-retry");
      release();
    });

    scheduler.cancelPending("pane-a");
    expect(scheduled).toHaveLength(0);
    releaseA?.();
    runNextTask();
    expect(order).toEqual(["a", "b"]);
  });

  it("invalidates an empty scheduled turn so a later idle pane runs immediately", () => {
    const { scheduler, scheduled, runNextTask } = createHarness();
    let releaseA: (() => void) | undefined;
    const paneB = vi.fn();
    const paneC = vi.fn((release: () => void) => release());

    scheduler.request("pane-a", (release) => {
      releaseA = release;
    });
    scheduler.request("pane-b", paneB);
    releaseA?.();
    expect(scheduled).toHaveLength(1);

    scheduler.cancelPending("pane-b");
    scheduler.request("pane-c", paneC);
    expect(paneC).toHaveBeenCalledTimes(1);

    runNextTask();
    expect(paneB).not.toHaveBeenCalled();
    expect(paneC).toHaveBeenCalledTimes(1);
  });

  it("releases the turn before propagating a synchronous pump failure", () => {
    const { scheduler, scheduled } = createHarness();
    const expected = new Error("pump sabotage");
    const next = vi.fn((release: () => void) => release());

    expect(() =>
      scheduler.request("pane-a", () => {
        throw expected;
      }),
    ).toThrow(expected);
    scheduler.request("pane-b", next);
    expect(scheduled).toHaveLength(0);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
