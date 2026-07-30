import { describe, expect, it, vi } from "vitest";
import { TerminalParserAdmission, terminalParserPriority } from "./terminal-parser-admission";
import {
  createTerminalWriteFairOwner,
  TerminalWriteFairScheduler,
} from "./terminal-write-fair-scheduler";

function createHarness() {
  const scheduled: Array<() => void> = [];
  const scheduler = new TerminalWriteFairScheduler((task) => scheduled.push(task));
  const admission = new TerminalParserAdmission(
    scheduler,
    createTerminalWriteFairOwner("pane"),
    () => "foreground",
  );
  const runNextTask = () => {
    const task = scheduled.shift();
    expect(task).toBeDefined();
    task?.();
  };
  return { admission, scheduler, scheduled, runNextTask };
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
});
