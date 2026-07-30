import { describe, expect, it, vi } from "vitest";
import {
  TERMINAL_CHECKPOINT_MAX_CALLBACKS_PER_LEASE,
  TerminalParserAdmission,
  terminalParserPriority,
} from "./terminal-parser-admission";
import {
  createTerminalWriteFairOwner,
  TerminalWriteFairScheduler,
} from "./terminal-write-fair-scheduler";
import { TERMINAL_WRITE_FAIR_QUANTUM_BYTES } from "./terminal-write-batch-queue";

function createHarness() {
  const scheduled: Array<() => void> = [];
  const localScheduled: Array<() => void> = [];
  const scheduler = new TerminalWriteFairScheduler((task) => scheduled.push(task));
  const admission = new TerminalParserAdmission(
    scheduler,
    createTerminalWriteFairOwner("pane"),
    () => "foreground",
    (task) => {
      localScheduled.push(task);
      return () => {
        const index = localScheduled.indexOf(task);
        if (index >= 0) localScheduled.splice(index, 1);
      };
    },
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

  it("does not retain a reusable checkpoint lease after a synchronous throw", () => {
    const scheduled: Array<() => void> = [];
    const localScheduled: Array<() => void> = [];
    const scheduler = new TerminalWriteFairScheduler((task) => scheduled.push(task));
    const admission = new TerminalParserAdmission(
      scheduler,
      createTerminalWriteFairOwner("checkpoint"),
      () => "background",
      (task) => {
        localScheduled.push(task);
        return () => {
          const index = localScheduled.indexOf(task);
          if (index >= 0) localScheduled.splice(index, 1);
        };
      },
    );

    expect(() =>
      admission.request(
        "checkpoint",
        () => {
          throw new Error("sync parser failure");
        },
        1,
      ),
    ).toThrow("sync parser failure");

    let releaseOther: (() => void) | undefined;
    scheduler.request(createTerminalWriteFairOwner("other"), (release) => {
      releaseOther = release;
    });
    const retry = vi.fn((release: () => void) => release());
    admission.request("checkpoint", retry, 1);

    expect(retry).not.toHaveBeenCalled();
    expect(localScheduled).toHaveLength(0);
    releaseOther?.();
    scheduled.shift()?.();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("reuses a checkpoint lease for small Promise-chain segments", () => {
    const { admission, scheduler, scheduled, localScheduled } = createHarness();
    let releaseFirst: (() => void) | undefined;
    const second = vi.fn((release: () => void) => release());

    admission.request(
      "checkpoint",
      (release) => {
        releaseFirst = release;
      },
      1_024,
    );
    releaseFirst?.();
    expect(localScheduled).toHaveLength(1);
    expect(scheduler.isIdleForTests()).toBe(false);

    // This request represents the next writeChain operation becoming visible
    // in the Promise continuation after the physical callback.
    admission.request("checkpoint", second, 1_024);
    expect(second).toHaveBeenCalledTimes(1);
    expect(scheduled).toHaveLength(0);

    // The first release timer was cancelled before the continued physical
    // write. Only the final held lease still needs a host timer.
    expect(localScheduled).toHaveLength(1);
    localScheduled.shift()?.();
    expect(scheduler.isIdleForTests()).toBe(true);
  });

  it("cancels a stale release timer before the next xterm-like parser task", async () => {
    type HostTask = { kind: "admission" | "parser"; run: () => void };
    const hostTasks: HostTask[] = [];
    const scheduler = new TerminalWriteFairScheduler((task) =>
      hostTasks.push({ kind: "admission", run: task }),
    );
    const admission = new TerminalParserAdmission(
      scheduler,
      createTerminalWriteFairOwner("checkpoint"),
      () => "background",
      (task) => {
        const scheduled = { kind: "admission" as const, run: task };
        hostTasks.push(scheduled);
        return () => {
          const index = hostTasks.indexOf(scheduled);
          if (index >= 0) hostTasks.splice(index, 1);
        };
      },
    );
    const runParserWrite = (release: () => void) => {
      hostTasks.push({
        kind: "parser",
        run: () => {
          release();
          void Promise.resolve().then(() => admission.request("checkpoint", runParserWrite, 1));
        },
      });
    };

    admission.request("checkpoint", runParserWrite, 1);
    expect(hostTasks.map(({ kind }) => kind)).toEqual(["parser"]);
    hostTasks.shift()?.run();
    await Promise.resolve();

    // The held-lease timer was queued before the Promise continuation, but the
    // continuation cancels it before scheduling xterm's next parser task.
    expect(hostTasks.map(({ kind }) => kind)).toEqual(["parser"]);
    admission.dispose();
  });

  it("hands off after checkpoint continuations consume one contended quantum", () => {
    const scheduled: Array<() => void> = [];
    const localScheduled: Array<() => void> = [];
    const scheduler = new TerminalWriteFairScheduler((task) => scheduled.push(task));
    const checkpoint = new TerminalParserAdmission(
      scheduler,
      createTerminalWriteFairOwner("checkpoint"),
      () => "background",
      (task) => {
        localScheduled.push(task);
        return () => {
          const index = localScheduled.indexOf(task);
          if (index >= 0) localScheduled.splice(index, 1);
        };
      },
    );
    const otherOwner = createTerminalWriteFairOwner("other");
    const order: string[] = [];
    let releaseCheckpoint: (() => void) | undefined;
    const segment = (release: () => void) => {
      order.push("checkpoint");
      releaseCheckpoint = release;
    };

    checkpoint.request("checkpoint", segment, TERMINAL_WRITE_FAIR_QUANTUM_BYTES / 2);
    scheduler.request(otherOwner, (release) => {
      order.push("other");
      release();
    });
    releaseCheckpoint?.();
    checkpoint.request("checkpoint", segment, TERMINAL_WRITE_FAIR_QUANTUM_BYTES / 2);
    expect(order).toEqual(["checkpoint", "checkpoint"]);
    releaseCheckpoint?.();
    checkpoint.request("checkpoint", segment, 1);
    expect(order).toEqual(["checkpoint", "checkpoint"]);

    scheduled.shift()?.();
    expect(order).toEqual(["checkpoint", "checkpoint", "other"]);
    scheduled.shift()?.();
    expect(order).toEqual(["checkpoint", "checkpoint", "other", "checkpoint"]);
  });

  it("fills a checkpoint quantum before handing the pane turn to its visible sibling", () => {
    const scheduled: Array<() => void> = [];
    const localScheduled: Array<() => void> = [];
    const scheduler = new TerminalWriteFairScheduler((task) => scheduled.push(task));
    const admission = new TerminalParserAdmission(
      scheduler,
      createTerminalWriteFairOwner("two-lane"),
      () => "background",
      (task) => {
        localScheduled.push(task);
        return () => {
          const index = localScheduled.indexOf(task);
          if (index >= 0) localScheduled.splice(index, 1);
        };
      },
    );
    const order: string[] = [];
    let releaseCheckpoint: (() => void) | undefined;
    const checkpointTurn = (release: () => void) => {
      order.push("checkpoint");
      releaseCheckpoint = release;
    };

    admission.request("checkpoint", checkpointTurn, TERMINAL_WRITE_FAIR_QUANTUM_BYTES / 2);
    scheduler.request(createTerminalWriteFairOwner("other"), (release) => {
      order.push("other");
      release();
    });
    admission.request("visible", (release) => {
      order.push("visible");
      release();
    });
    releaseCheckpoint?.();
    admission.request("checkpoint", checkpointTurn, TERMINAL_WRITE_FAIR_QUANTUM_BYTES / 2);
    expect(order).toEqual(["checkpoint", "checkpoint"]);

    releaseCheckpoint?.();
    admission.request("checkpoint", checkpointTurn, 1);
    expect(order).toEqual(["checkpoint", "checkpoint"]);
    scheduled.shift()?.();
    expect(order).toEqual(["checkpoint", "checkpoint", "other"]);
    scheduled.shift()?.();
    expect(order).toEqual(["checkpoint", "checkpoint", "other", "visible"]);
    scheduled.shift()?.();
    expect(order).toEqual(["checkpoint", "checkpoint", "other", "visible", "checkpoint"]);
  });

  it("hands off instead of splitting a checkpoint operation across leases", () => {
    const scheduled: Array<() => void> = [];
    const scheduler = new TerminalWriteFairScheduler((task) => scheduled.push(task));
    const checkpoint = new TerminalParserAdmission(
      scheduler,
      createTerminalWriteFairOwner("checkpoint"),
      () => "background",
      () => () => {},
    );
    const order: string[] = [];
    const maxBytes: number[] = [];
    let releaseCheckpoint: (() => void) | undefined;
    checkpoint.request(
      "checkpoint",
      (release) => {
        order.push("checkpoint-first");
        releaseCheckpoint = release;
      },
      (TERMINAL_WRITE_FAIR_QUANTUM_BYTES * 3) / 4,
    );
    const otherOwner = createTerminalWriteFairOwner("other");
    scheduler.request(otherOwner, (release) => {
      order.push("other");
      scheduler.request(otherOwner, (tailRelease) => {
        order.push("other-tail");
        tailRelease();
      });
      release();
    });
    releaseCheckpoint?.();

    checkpoint.request(
      "checkpoint",
      (release, context) => {
        order.push("checkpoint-second");
        maxBytes.push(context.maxBytes);
        release();
      },
      TERMINAL_WRITE_FAIR_QUANTUM_BYTES / 2,
    );
    expect(order).toEqual(["checkpoint-first"]);

    scheduled.shift()?.();
    expect(order).toEqual(["checkpoint-first", "other"]);
    scheduled.shift()?.();
    expect(order).toEqual(["checkpoint-first", "other", "checkpoint-second"]);
    expect(maxBytes).toEqual([TERMINAL_WRITE_FAIR_QUANTUM_BYTES]);
  });

  it("hands off after the checkpoint callback-count cap even for one-byte segments", () => {
    const scheduled: Array<() => void> = [];
    const scheduler = new TerminalWriteFairScheduler((task) => scheduled.push(task));
    const checkpoint = new TerminalParserAdmission(
      scheduler,
      createTerminalWriteFairOwner("checkpoint"),
      () => "background",
      () => () => {},
    );
    const order: string[] = [];
    let releaseCheckpoint: (() => void) | undefined;
    const segment = (release: () => void) => {
      order.push("checkpoint");
      releaseCheckpoint = release;
    };

    checkpoint.request("checkpoint", segment, 1);
    scheduler.request(createTerminalWriteFairOwner("other"), (release) => {
      order.push("other");
      release();
    });
    for (let index = 1; index < TERMINAL_CHECKPOINT_MAX_CALLBACKS_PER_LEASE; index += 1) {
      releaseCheckpoint?.();
      checkpoint.request("checkpoint", segment, 1);
    }
    expect(order).toHaveLength(TERMINAL_CHECKPOINT_MAX_CALLBACKS_PER_LEASE);
    releaseCheckpoint?.();
    checkpoint.request("checkpoint", segment, 1);
    expect(order).toHaveLength(TERMINAL_CHECKPOINT_MAX_CALLBACKS_PER_LEASE);

    scheduled.shift()?.();
    expect(order.at(-1)).toBe("other");
  });

  it("preserves 2:1 weight across delayed checkpoint-chain requeues", () => {
    const scheduled: Array<() => void> = [];
    const scheduler = new TerminalWriteFairScheduler((task) => scheduled.push(task));
    const foreground = new TerminalParserAdmission(
      scheduler,
      createTerminalWriteFairOwner("foreground"),
      () => "foreground",
      () => () => {},
    );
    const background = new TerminalParserAdmission(
      scheduler,
      createTerminalWriteFairOwner("background"),
      () => "background",
      () => () => {},
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
