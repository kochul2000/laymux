import { describe, expect, it, vi } from "vitest";
import {
  createTerminalWriteFairOwner,
  TERMINAL_WRITE_MAX_SKIPPED_TURNS,
  TerminalWriteFairScheduler,
  type TerminalWritePriority,
} from "./terminal-write-fair-scheduler";

const owner = (label: string) => createTerminalWriteFairOwner(label);

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
  it("serves saturated focused, foreground, and background parsers with 4:2:1 weight", () => {
    const { scheduler, runNextTask } = createHarness();
    const order: string[] = [];
    let releaseBlocker: (() => void) | undefined;
    const blocker = owner("blocker");
    const focused = owner("focused");
    const foreground = owner("foreground");
    const background = owner("background");

    scheduler.request(blocker, (release) => {
      releaseBlocker = release;
    });

    const saturate = (
      currentOwner: ReturnType<typeof owner>,
      label: string,
      priority: TerminalWritePriority,
    ) => {
      const turn = (release: () => void) => {
        order.push(label);
        if (order.length < 7) scheduler.request(currentOwner, turn, () => priority);
        release();
      };
      scheduler.request(currentOwner, turn, () => priority);
    };
    // Deliberately enqueue low priority first. Selection is by current class,
    // not by the order in which a flood happened to request its first turn.
    saturate(background, "background", "background");
    saturate(foreground, "foreground", "foreground");
    saturate(focused, "focused", "focused");

    releaseBlocker?.();
    for (let index = 0; index < 7; index += 1) runNextTask();

    expect(order).toEqual([
      "focused",
      "foreground",
      "focused",
      "background",
      "focused",
      "foreground",
      "focused",
    ]);
  });

  it("samples the latest priority when a queued pane reaches dequeue", () => {
    const { scheduler, runNextTask } = createHarness();
    const order: string[] = [];
    let releaseBlocker: (() => void) | undefined;
    let promotedPriority: TerminalWritePriority = "background";
    const blocker = owner("blocker");
    const foreground = owner("foreground");
    const promoted = owner("promoted");

    scheduler.request(blocker, (release) => {
      releaseBlocker = release;
    });
    scheduler.request(
      foreground,
      (release) => {
        order.push("foreground");
        release();
      },
      () => "foreground",
    );
    scheduler.request(
      promoted,
      (release) => {
        order.push("promoted");
        release();
      },
      () => promotedPriority,
    );

    promotedPriority = "focused";
    releaseBlocker?.();
    runNextTask();

    expect(order).toEqual(["promoted"]);
  });

  it("age-promotes saturated background parsers within a finite turn bound", () => {
    const { scheduler, runNextTask } = createHarness();
    const servicedBackground = new Set<string>();
    let releaseBlocker: (() => void) | undefined;
    const blocker = owner("blocker");

    scheduler.request(blocker, (release) => {
      releaseBlocker = release;
    });

    const saturate = (
      currentOwner: ReturnType<typeof owner>,
      priority: TerminalWritePriority,
      onTurn: () => void,
    ) => {
      const turn = (release: () => void) => {
        onTurn();
        scheduler.request(currentOwner, turn, () => priority);
        release();
      };
      scheduler.request(currentOwner, turn, () => priority);
    };
    for (const label of ["background-a", "background-b", "background-c"]) {
      const currentOwner = owner(label);
      saturate(currentOwner, "background", () => servicedBackground.add(label));
    }
    // K+1 distinct focused owners make ordinary smooth weighting choose the
    // ninth focused owner next. Aging must instead select the earlier-enqueued
    // background FIFO after exactly K skips.
    for (let index = 0; index <= TERMINAL_WRITE_MAX_SKIPPED_TURNS; index += 1) {
      saturate(owner(`focused-${index}`), "focused", () => {});
    }

    releaseBlocker?.();
    // Three overdue owners are serviced on selections K+1 through K+3.
    const initialBackgroundOwnerCount = 3;
    for (
      let index = 0;
      index < TERMINAL_WRITE_MAX_SKIPPED_TURNS + initialBackgroundOwnerCount;
      index += 1
    ) {
      runNextTask();
    }

    expect([...servicedBackground].sort()).toEqual([
      "background-a",
      "background-b",
      "background-c",
    ]);
  });

  it("admits one physical write at a time and rotates waiting panes", () => {
    const { scheduler, scheduled, runNextTask } = createHarness();
    const order: string[] = [];
    let releaseA: (() => void) | undefined;
    let releaseB: (() => void) | undefined;
    const paneA = owner("pane-a");
    const paneB = owner("pane-b");

    scheduler.request(paneA, (release) => {
      order.push("a1");
      releaseA = release;
    });
    scheduler.request(paneB, (release) => {
      order.push("b1");
      releaseB = release;
    });

    expect(order).toEqual(["a1"]);
    expect(scheduled).toHaveLength(0);

    scheduler.request(paneA, (release) => {
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
    const active = owner("active");
    const paneA = owner("pane-a");

    scheduler.request(active, (release) => {
      releaseActive = release;
    });
    scheduler.request(paneA, run);
    scheduler.request(paneA, run);
    scheduler.request(paneA, run);
    releaseActive?.();
    runNextTask();

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("marks a turn contended only when another owner is already waiting", () => {
    const { scheduler, runNextTask } = createHarness();
    const turns: Array<[string, boolean]> = [];
    let releaseA: (() => void) | undefined;
    let releaseB: (() => void) | undefined;
    const paneA = owner("pane-a");
    const paneB = owner("pane-b");

    scheduler.request(paneA, (release, { contended }) => {
      turns.push(["a1", contended]);
      releaseA = release;
    });
    scheduler.request(paneB, (release, { contended }) => {
      turns.push(["b1", contended]);
      releaseB = release;
    });
    scheduler.request(paneA, (release, { contended }) => {
      turns.push(["a2", contended]);
      release();
    });

    expect(turns).toEqual([["a1", false]]);
    releaseA?.();
    runNextTask();
    expect(turns).toEqual([
      ["a1", false],
      ["b1", true],
    ]);
    releaseB?.();
    runNextTask();
    expect(turns).toEqual([
      ["a1", false],
      ["b1", true],
      ["a2", false],
    ]);
  });

  it("cancels a mounted pane without stranding the global lease", () => {
    const { scheduler, scheduled, runNextTask } = createHarness();
    const order: string[] = [];
    let staleRelease: (() => void) | undefined;
    const paneA = owner("pane-a");
    const paneB = owner("pane-b");

    scheduler.request(paneA, (release) => {
      order.push("a");
      staleRelease = release;
    });
    scheduler.request(paneB, (release) => {
      order.push("b");
      release();
    });
    scheduler.cancel(paneA);
    expect(scheduled).toHaveLength(1);
    staleRelease?.();
    expect(scheduled).toHaveLength(1);
    runNextTask();
    expect(order).toEqual(["a", "b"]);
  });

  it("keeps a replacement generation queued when the old callback settles late", () => {
    const { scheduler, scheduled, runNextTask } = createHarness();
    const oldGeneration = owner("shared-instance");
    const newGeneration = owner("shared-instance");
    const otherPane = owner("other-pane");
    const order: string[] = [];
    let releaseOld: (() => void) | undefined;
    let releaseOther: (() => void) | undefined;

    scheduler.request(oldGeneration, (release) => {
      order.push("old");
      releaseOld = release;
    });
    scheduler.request(otherPane, (release) => {
      order.push("other");
      releaseOther = release;
    });

    // A profile change tears down the old effect and lets the other pane run.
    scheduler.cancel(oldGeneration);
    scheduler.request(newGeneration, (release) => {
      order.push("new");
      release();
    });

    // The accepted old xterm callback can still arrive after replacement. Its
    // pending cleanup and stale release must target only the old effect owner.
    scheduler.cancelPending(oldGeneration);
    releaseOld?.();

    expect(scheduled).toHaveLength(1);
    runNextTask();
    expect(order).toEqual(["old", "other"]);
    releaseOther?.();
    runNextTask();
    expect(order).toEqual(["old", "other", "new"]);
  });

  it("can drop a queued retry without releasing an accepted active write", () => {
    const { scheduler, scheduled, runNextTask } = createHarness();
    const order: string[] = [];
    let releaseA: (() => void) | undefined;
    const paneA = owner("pane-a");
    const paneB = owner("pane-b");

    scheduler.request(paneA, (release) => {
      order.push("a");
      releaseA = release;
    });
    scheduler.request(paneB, (release) => {
      order.push("b");
      release();
    });
    scheduler.request(paneA, (release) => {
      order.push("stale-a-retry");
      release();
    });

    scheduler.cancelPending(paneA);
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
    const paneAOwner = owner("pane-a");
    const paneBOwner = owner("pane-b");
    const paneCOwner = owner("pane-c");

    scheduler.request(paneAOwner, (release) => {
      releaseA = release;
    });
    scheduler.request(paneBOwner, paneB);
    releaseA?.();
    expect(scheduled).toHaveLength(1);

    scheduler.cancelPending(paneBOwner);
    scheduler.request(paneCOwner, paneC);
    expect(paneC).toHaveBeenCalledTimes(1);

    runNextTask();
    expect(paneB).not.toHaveBeenCalled();
    expect(paneC).toHaveBeenCalledTimes(1);
  });

  it("resets an active lease and invalidates its pending host task for test isolation", () => {
    const { scheduler, scheduled, runNextTask } = createHarness();
    const stalePending = vi.fn((release: () => void) => release());
    const paneA = owner("pane-a");
    const paneB = owner("pane-b");

    scheduler.request(paneA, () => {});
    scheduler.request(paneB, stalePending);
    expect(scheduler.isIdleForTests()).toBe(false);

    scheduler.cancel(paneA);
    expect(scheduled).toHaveLength(1);
    scheduler.resetForTests();
    expect(scheduler.isIdleForTests()).toBe(true);

    runNextTask();
    expect(stalePending).not.toHaveBeenCalled();
    expect(scheduler.isIdleForTests()).toBe(true);
  });

  it("releases the turn before propagating a synchronous pump failure", () => {
    const { scheduler, scheduled } = createHarness();
    const expected = new Error("pump sabotage");
    const next = vi.fn((release: () => void) => release());
    const paneA = owner("pane-a");
    const paneB = owner("pane-b");

    expect(() =>
      scheduler.request(paneA, () => {
        throw expected;
      }),
    ).toThrow(expected);
    scheduler.request(paneB, next);
    expect(scheduled).toHaveLength(0);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
