import { describe, expect, it, vi } from "vitest";
import { TerminalParserAdmission, terminalParserPriority } from "./terminal-parser-admission";
import {
  createTerminalWriteFairOwner,
  TerminalWriteFairScheduler,
} from "./terminal-write-fair-scheduler";

function createHarness() {
  const scheduled: Array<() => void> = [];
  const localScheduled: Array<() => void> = [];
  const scheduler = new TerminalWriteFairScheduler((task) => scheduled.push(task));
  const admission = new TerminalParserAdmission(
    scheduler,
    createTerminalWriteFairOwner("pane"),
    () => "foreground",
    (task) => localScheduled.push(task),
  );
  const runNextTask = () => {
    const task = scheduled.shift();
    expect(task).toBeDefined();
    task?.();
  };
  return { admission, scheduler, scheduled, localScheduled, runNextTask };
}

describe("TerminalParserAdmission", () => {
  it("classifies actual hidden state before remembered focus", () => {
    expect(terminalParserPriority(true, true)).toBe("background");
    expect(terminalParserPriority(false, true)).toBe("focused");
    expect(terminalParserPriority(false, false)).toBe("foreground");
  });

  it("serializes visible and checkpoint lanes through one pane owner", () => {
    const { admission, scheduled, runNextTask } = createHarness();
    const order: string[] = [];
    let releaseCheckpoint: (() => void) | undefined;

    admission.request("checkpoint", (release) => {
      order.push("checkpoint-1");
      releaseCheckpoint = release;
    });
    admission.request("visible", (release, { contended }) => {
      order.push(`visible:${contended}`);
      release();
    });

    expect(order).toEqual(["checkpoint-1"]);
    releaseCheckpoint?.();
    expect(scheduled).toHaveLength(1);
    runNextTask();
    expect(order).toEqual(["checkpoint-1", "visible:false"]);
  });

  it("alternates lanes when both stay saturated without doubling pane weight", () => {
    const { admission, scheduled, runNextTask } = createHarness();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;

    const visible = (release: () => void) => {
      order.push("visible");
      admission.request("visible", visible);
      release();
    };
    const checkpoint = (release: () => void) => {
      order.push("checkpoint");
      admission.request("checkpoint", checkpoint);
      release();
    };

    admission.request("visible", (release) => {
      order.push("visible");
      admission.request("visible", visible);
      releaseFirst = release;
    });
    admission.request("checkpoint", checkpoint);
    releaseFirst?.();
    for (let index = 0; index < 5; index += 1) runNextTask();

    expect(order).toEqual([
      "visible",
      "checkpoint",
      "visible",
      "checkpoint",
      "visible",
      "checkpoint",
    ]);
    expect(scheduled).toHaveLength(1);
  });

  it("deduplicates each lane and lets pending cancellation preserve its sibling", () => {
    const { admission, runNextTask } = createHarness();
    let releaseActive: (() => void) | undefined;
    const visible = vi.fn((release: () => void) => release());
    const checkpoint = vi.fn((release: () => void) => release());

    admission.request("visible", (release) => {
      releaseActive = release;
    });
    admission.request("visible", visible);
    admission.request("visible", visible);
    admission.request("checkpoint", checkpoint);
    admission.cancelPending("visible");
    releaseActive?.();
    runNextTask();

    expect(visible).not.toHaveBeenCalled();
    expect(checkpoint).toHaveBeenCalledTimes(1);
  });

  it("releases a cancelled active lane without stranding the sibling", () => {
    const { admission, runNextTask } = createHarness();
    const checkpoint = vi.fn((release: () => void) => release());

    admission.request("visible", () => {});
    admission.request("checkpoint", checkpoint);
    admission.cancel("visible");
    runNextTask();

    expect(checkpoint).toHaveBeenCalledTimes(1);
  });

  it("holds a checkpoint lease across its Promise-chain microtask boundary", () => {
    const { admission, scheduler, scheduled, localScheduled, runNextTask } = createHarness();
    let releaseFirst: (() => void) | undefined;
    const second = vi.fn((release: () => void) => release());

    admission.request("checkpoint", (release) => {
      releaseFirst = release;
    });
    releaseFirst?.();
    expect(localScheduled).toHaveLength(1);
    expect(scheduler.isIdleForTests()).toBe(false);

    // This request represents the next writeChain operation becoming visible
    // in the Promise continuation after the physical callback.
    admission.request("checkpoint", second);
    expect(second).not.toHaveBeenCalled();
    localScheduled.shift()?.();
    expect(scheduled).toHaveLength(1);
    runNextTask();
    expect(second).toHaveBeenCalledTimes(1);

    expect(localScheduled).toHaveLength(1);
    localScheduled.shift()?.();
    expect(scheduler.isIdleForTests()).toBe(true);
  });

  it("preserves 2:1 weight across delayed checkpoint-chain requeues", () => {
    const scheduled: Array<() => void> = [];
    const foregroundTasks: Array<() => void> = [];
    const backgroundTasks: Array<() => void> = [];
    const scheduler = new TerminalWriteFairScheduler((task) => scheduled.push(task));
    const foreground = new TerminalParserAdmission(
      scheduler,
      createTerminalWriteFairOwner("foreground"),
      () => "foreground",
      (task) => foregroundTasks.push(task),
    );
    const background = new TerminalParserAdmission(
      scheduler,
      createTerminalWriteFairOwner("background"),
      () => "background",
      (task) => backgroundTasks.push(task),
    );
    const blocker = createTerminalWriteFairOwner("blocker");
    const order: string[] = [];
    let releaseBlocker: (() => void) | undefined;
    let releaseActive: (() => void) | undefined;
    scheduler.request(blocker, (release) => {
      releaseBlocker = release;
    });
    const foregroundTurn = (release: () => void) => {
      order.push("foreground");
      releaseActive = release;
    };
    const backgroundTurn = (release: () => void) => {
      order.push("background");
      releaseActive = release;
    };
    foreground.request("checkpoint", foregroundTurn);
    background.request("checkpoint", backgroundTurn);
    releaseBlocker?.();

    for (let index = 0; index < 6; index += 1) {
      scheduled.shift()?.();
      const selectedForeground = order.at(-1) === "foreground";
      releaseActive?.();
      if (index < 5) {
        if (selectedForeground) foreground.request("checkpoint", foregroundTurn);
        else background.request("checkpoint", backgroundTurn);
      }
      const localTasks = selectedForeground ? foregroundTasks : backgroundTasks;
      expect(localTasks).toHaveLength(1);
      localTasks.shift()?.();
    }

    expect(order).toEqual([
      "foreground",
      "background",
      "foreground",
      "foreground",
      "background",
      "foreground",
    ]);
    foreground.dispose();
    background.dispose();
    expect(scheduler.isIdleForTests()).toBe(true);
  });
});
