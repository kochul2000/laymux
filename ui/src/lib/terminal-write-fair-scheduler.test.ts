import { describe, expect, it, vi } from "vitest";
import {
  createTerminalWriteFairOwner,
  sanitizeTerminalWriteClassShare,
  TERMINAL_WRITE_CONTROL_YIELD_INTERVAL_TURNS,
  TERMINAL_WRITE_DEFAULT_CLASS_SHARE,
  TERMINAL_WRITE_MAX_CLASS_SHARE,
  TERMINAL_WRITE_MIN_CLASS_SHARE,
  TerminalWriteFairScheduler,
  type TerminalWritePriority,
} from "./terminal-write-fair-scheduler";

const owner = (label: string) => createTerminalWriteFairOwner(label);

const CLASS_SHARE_CYCLE_TURNS =
  TERMINAL_WRITE_DEFAULT_CLASS_SHARE.focused +
  TERMINAL_WRITE_DEFAULT_CLASS_SHARE.foreground +
  TERMINAL_WRITE_DEFAULT_CLASS_SHARE.background;

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
  it("uses a MessageChannel task for browser handoff without timer nesting", () => {
    vi.useFakeTimers();
    const posted: Array<() => void> = [];
    let channelConstructions = 0;
    const originalMessageChannel = window.MessageChannel;
    class FakeMessageChannel {
      constructor() {
        channelConstructions += 1;
      }
      port1 = {
        onmessage: null as (() => void) | null,
        close: vi.fn(),
      };
      port2 = {
        postMessage: () => posted.push(() => this.port1.onmessage?.()),
        close: vi.fn(),
      };
    }
    Object.defineProperty(window, "MessageChannel", {
      configurable: true,
      value: FakeMessageChannel,
    });
    const scheduler = new TerminalWriteFairScheduler();
    try {
      let releaseActive: (() => void) | undefined;
      const next = vi.fn((release: () => void) => release());
      const pendingOwner = owner("next");
      scheduler.request(owner("active"), (release) => {
        releaseActive = release;
      });
      scheduler.request(pendingOwner, next);
      releaseActive?.();

      expect(posted).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
      scheduler.cancelPending(pendingOwner);

      let releaseReplacement: (() => void) | undefined;
      scheduler.request(owner("replacement"), (release) => {
        releaseReplacement = release;
      });
      scheduler.request(owner("after-replacement"), next);
      releaseReplacement?.();
      expect(posted).toHaveLength(2);
      expect(channelConstructions).toBe(1);

      posted.shift()?.();
      expect(next).not.toHaveBeenCalled();
      posted.shift()?.();
      expect(next).toHaveBeenCalledTimes(1);
    } finally {
      scheduler.resetForTests();
      Object.defineProperty(window, "MessageChannel", {
        configurable: true,
        value: originalMessageChannel,
      });
      vi.useRealTimers();
    }
  });

  it("falls back to a timer when MessageChannel is unavailable", () => {
    vi.useFakeTimers();
    const originalMessageChannel = window.MessageChannel;
    Object.defineProperty(window, "MessageChannel", {
      configurable: true,
      value: undefined,
    });
    const scheduler = new TerminalWriteFairScheduler();
    try {
      let releaseActive: (() => void) | undefined;
      const next = vi.fn((release: () => void) => release());
      scheduler.request(owner("active"), (release) => {
        releaseActive = release;
      });
      scheduler.request(owner("next"), next);
      releaseActive?.();

      expect(vi.getTimerCount()).toBe(1);
      vi.runOnlyPendingTimers();
      expect(next).toHaveBeenCalledTimes(1);
    } finally {
      scheduler.resetForTests();
      Object.defineProperty(window, "MessageChannel", {
        configurable: true,
        value: originalMessageChannel,
      });
      vi.useRealTimers();
    }
  });

  it("periodically yields the MessageChannel chain to other browser task sources", () => {
    vi.useFakeTimers();
    const posted: Array<() => void> = [];
    const originalMessageChannel = window.MessageChannel;
    class FakeMessageChannel {
      port1 = {
        onmessage: null as (() => void) | null,
        close: vi.fn(),
      };
      port2 = {
        postMessage: () => posted.push(() => this.port1.onmessage?.()),
        close: vi.fn(),
      };
    }
    Object.defineProperty(window, "MessageChannel", {
      configurable: true,
      value: FakeMessageChannel,
    });
    const scheduler = new TerminalWriteFairScheduler();
    try {
      const saturatedOwner = owner("saturated");
      let turns = 0;
      const turn = (release: () => void) => {
        turns += 1;
        if (turns <= TERMINAL_WRITE_CONTROL_YIELD_INTERVAL_TURNS) {
          scheduler.request(saturatedOwner, turn);
        }
        release();
      };

      scheduler.request(saturatedOwner, turn);
      for (let index = 1; index < TERMINAL_WRITE_CONTROL_YIELD_INTERVAL_TURNS; index += 1) {
        expect(posted).toHaveLength(1);
        posted.shift()?.();
      }

      expect(turns).toBe(TERMINAL_WRITE_CONTROL_YIELD_INTERVAL_TURNS);
      expect(posted).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(1);
      vi.runOnlyPendingTimers();
      expect(turns).toBe(TERMINAL_WRITE_CONTROL_YIELD_INTERVAL_TURNS);
      expect(posted).toHaveLength(1);
      posted.shift()?.();
      expect(turns).toBe(TERMINAL_WRITE_CONTROL_YIELD_INTERVAL_TURNS + 1);
    } finally {
      scheduler.resetForTests();
      Object.defineProperty(window, "MessageChannel", {
        configurable: true,
        value: originalMessageChannel,
      });
      vi.useRealTimers();
    }
  });

  /** Drive `turns` admissions with the given panes all continuously backlogged. */
  function runSaturated(
    scheduler: TerminalWriteFairScheduler,
    runNextTask: () => void,
    panes: Array<{ label: string; priority: TerminalWritePriority }>,
    turns: number,
  ): string[] {
    const served: string[] = [];
    let releaseBlocker: (() => void) | undefined;
    scheduler.request(owner("blocker"), (release) => {
      releaseBlocker = release;
    });
    for (const pane of panes) {
      const paneOwner = owner(pane.label);
      const turn = (release: () => void) => {
        served.push(pane.label);
        if (served.length < turns) scheduler.request(paneOwner, turn, () => pane.priority);
        release();
      };
      scheduler.request(paneOwner, turn, () => pane.priority);
    }
    releaseBlocker?.();
    for (let index = 0; index < turns; index += 1) runNextTask();
    return served;
  }

  const countOf = (served: string[], label: string) =>
    served.filter((entry) => entry === label).length;

  it("splits one cycle between classes by their configured share", () => {
    const { scheduler, runNextTask } = createHarness();
    // Deliberately enqueue the lowest class first. Selection is by current
    // class, not by the order in which a flood requested its first turn.
    const served = runSaturated(
      scheduler,
      runNextTask,
      [
        { label: "background", priority: "background" },
        { label: "foreground", priority: "foreground" },
        { label: "focused", priority: "focused" },
      ],
      CLASS_SHARE_CYCLE_TURNS,
    );

    expect(served[0]).toBe("focused");
    expect(countOf(served, "focused")).toBe(TERMINAL_WRITE_DEFAULT_CLASS_SHARE.focused);
    expect(countOf(served, "foreground")).toBe(TERMINAL_WRITE_DEFAULT_CLASS_SHARE.foreground);
    expect(countOf(served, "background")).toBe(TERMINAL_WRITE_DEFAULT_CLASS_SHARE.background);
  });

  it("keeps the active workspace's share no matter how many hidden panes flood", () => {
    // issue #686: with a per-pane weight the active workspace's share was
    // divided by the hidden pane count, so a hidden crowd flattened admission
    // into plain round-robin. A class share does not depend on that count.
    const focusedSharePerCycle = TERMINAL_WRITE_DEFAULT_CLASS_SHARE.focused;
    const hiddenSharePerCycle = TERMINAL_WRITE_DEFAULT_CLASS_SHARE.background;

    for (const hiddenPaneCount of [2, 8, 40]) {
      const { scheduler, runNextTask } = createHarness();
      // One full round of the hidden class, so every hidden pane is reachable.
      const cycles = hiddenPaneCount;
      const panes: Array<{ label: string; priority: TerminalWritePriority }> = [
        { label: "focused", priority: "focused" },
      ];
      for (let index = 0; index < hiddenPaneCount; index += 1) {
        panes.push({ label: `hidden-${index}`, priority: "background" });
      }
      const turns = CLASS_SHARE_CYCLE_TURNS * cycles;
      // The idle foreground class lends its share, so the cycle here is
      // focused + background only.
      const activeCycleTurns = focusedSharePerCycle + hiddenSharePerCycle;
      const served = runSaturated(scheduler, runNextTask, panes, turns);
      const focusedTurns = countOf(served, "focused");
      const hiddenTurns = served.length - focusedTurns;

      expect(focusedTurns / served.length).toBeCloseTo(focusedSharePerCycle / activeCycleTurns, 1);
      expect(hiddenTurns).toBeGreaterThan(0);
      // Tier 2 is round-robin, so the hidden class's turns spread evenly and no
      // hidden pane is skipped within one round of its own class.
      const hiddenCounts = Array.from({ length: hiddenPaneCount }, (_, index) =>
        countOf(served, `hidden-${index}`),
      );
      expect(Math.max(...hiddenCounts) - Math.min(...hiddenCounts)).toBeLessThanOrEqual(1);
      expect(Math.min(...hiddenCounts)).toBeGreaterThan(0);
      scheduler.resetForTests();
    }
  });

  it("serves every hidden pane within its class-share starvation bound", () => {
    const { scheduler, runNextTask } = createHarness();
    const hiddenPaneCount = 8;
    // A hidden pane waits at most one full round of its own class: the class
    // needs `cycle / hiddenShare` turns per own turn, times the class members.
    const boundTurns =
      Math.ceil(CLASS_SHARE_CYCLE_TURNS / TERMINAL_WRITE_DEFAULT_CLASS_SHARE.background) *
      hiddenPaneCount;
    const panes: Array<{ label: string; priority: TerminalWritePriority }> = [
      { label: "focused", priority: "focused" },
      { label: "visible", priority: "foreground" },
    ];
    for (let index = 0; index < hiddenPaneCount; index += 1) {
      panes.push({ label: `hidden-${index}`, priority: "background" });
    }

    const served = runSaturated(scheduler, runNextTask, panes, boundTurns);

    for (let index = 0; index < hiddenPaneCount; index += 1) {
      expect(countOf(served, `hidden-${index}`)).toBeGreaterThan(0);
    }
  });

  it("adopts configured class shares and clamps invalid ones", () => {
    expect(sanitizeTerminalWriteClassShare(undefined)).toEqual(TERMINAL_WRITE_DEFAULT_CLASS_SHARE);
    expect(
      sanitizeTerminalWriteClassShare({ focused: 0, foreground: "x", background: 7.9 }),
    ).toEqual({
      focused: TERMINAL_WRITE_MIN_CLASS_SHARE,
      foreground: TERMINAL_WRITE_DEFAULT_CLASS_SHARE.foreground,
      background: 7,
    });
    expect(sanitizeTerminalWriteClassShare({ focused: 10_000 }).focused).toBe(
      TERMINAL_WRITE_MAX_CLASS_SHARE,
    );

    const { scheduler, runNextTask } = createHarness();
    scheduler.setClassShare({ focused: 1, foreground: 1, background: 3 });
    const served = runSaturated(
      scheduler,
      runNextTask,
      [
        { label: "focused", priority: "focused" },
        { label: "hidden", priority: "background" },
      ],
      4,
    );

    // Shares are honoured verbatim, including a deliberately hidden-first table.
    expect(countOf(served, "hidden")).toBe(3);
    expect(countOf(served, "focused")).toBe(1);
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

  it("does not let a focused crowd take the hidden class's share", () => {
    const { scheduler, runNextTask } = createHarness();
    const focusedPaneCount = 9;
    const cycleTurns =
      TERMINAL_WRITE_DEFAULT_CLASS_SHARE.focused + TERMINAL_WRITE_DEFAULT_CLASS_SHARE.background;
    const panes: Array<{ label: string; priority: TerminalWritePriority }> = [
      { label: "hidden", priority: "background" },
    ];
    for (let index = 0; index < focusedPaneCount; index += 1) {
      panes.push({ label: `focused-${index}`, priority: "focused" });
    }

    const served = runSaturated(scheduler, runNextTask, panes, cycleTurns);

    // Adding focused panes divides the focused class's share among them; it
    // never consumes the hidden class's share.
    expect(countOf(served, "hidden")).toBe(TERMINAL_WRITE_DEFAULT_CLASS_SHARE.background);
  });

  it("lends an idle class's share to the classes that are backlogged", () => {
    const { scheduler, runNextTask } = createHarness();
    const cycleTurns =
      TERMINAL_WRITE_DEFAULT_CLASS_SHARE.focused + TERMINAL_WRITE_DEFAULT_CLASS_SHARE.background;

    const served = runSaturated(
      scheduler,
      runNextTask,
      [
        { label: "focused", priority: "focused" },
        { label: "hidden", priority: "background" },
      ],
      cycleTurns,
    );

    expect(countOf(served, "focused")).toBe(TERMINAL_WRITE_DEFAULT_CLASS_SHARE.focused);
    expect(countOf(served, "hidden")).toBe(TERMINAL_WRITE_DEFAULT_CLASS_SHARE.background);
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

  it("rotates panes inside one class in waiting order", () => {
    const { scheduler, runNextTask } = createHarness();
    const hiddenPaneCount = 3;
    const panes: Array<{ label: string; priority: TerminalWritePriority }> = [];
    for (let index = 0; index < hiddenPaneCount; index += 1) {
      panes.push({ label: `hidden-${index}`, priority: "background" });
    }

    // A single pending class owns every turn, so tier 2 alone decides the order.
    const served = runSaturated(scheduler, runNextTask, panes, hiddenPaneCount * 2);

    expect(served).toEqual([
      "hidden-0",
      "hidden-1",
      "hidden-2",
      "hidden-0",
      "hidden-1",
      "hidden-2",
    ]);
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
