/**
 * ADR-0072 Consequences (7), on a real cell grid.
 *
 * The claim sequence-exact repair exists for is: *"a differential render frame
 * sequence ends up cell-identical to the lossless path after a repair."* Every
 * other consequence of that ADR is pinned by
 * `terminal-output-attach-coordinator.test.ts`, which reasons about sequences
 * and byte ranges. This one cannot be — it is a claim about **cells**, and the
 * desktop terminal suite mocks xterm, so its `write` never reaches a parser
 * (issue #605).
 *
 * So these tests stream the bytes into a real `@xterm/xterm` and read the
 * buffer back. They run in the screen suite (`npm run test:screen`, ADR-0074).
 *
 * The three tests form one argument:
 *
 * 1. repair restores the screen **exactly** — cell for cell, cursor included;
 * 2. the pre-ADR-0072 recovery (`reset()` + truncated replay) **does not** —
 *    the rows the program painted once and never repainted stay blank;
 * 3. and the comparison is not vacuous: double-applying one frame's bytes is
 *    caught, so test 1 passing means something.
 */

import { describe, expect, it } from "vitest";
import {
  createDifferentialFrameScript,
  type DifferentialFrameScript,
} from "@/test/screen/differential-frames";
import { createOutputRing } from "@/test/screen/output-ring";
import {
  createOutputSurfaceDriver,
  type RecoveryCounters,
  type RecoveryStrategy,
} from "@/test/screen/output-surface-driver";
import {
  createScreenTerminal,
  diffScreens,
  formatScreen,
  screenRow,
  screenRows,
  type ScreenSnapshot,
} from "@/test/screen/xterm-screen";

const script = createDifferentialFrameScript({ updates: 12 });
const encoder = new TextEncoder();
const frameBytes = script.frames.map((frame) => encoder.encode(frame).length);

/** Sequence one past the last byte of frame `index`. */
function seqAfterFrame(index: number): number {
  return frameBytes.slice(0, index + 1).reduce((sum, length) => sum + length, 0);
}

interface RunOptions {
  strategy?: RecoveryStrategy;
  /** Frame whose `terminal-output-v2` notification is lost. */
  dropIndex?: number;
  /**
   * Once the dropped frame is recorded, the ring drops everything before the
   * end of this frame. Cutting on a frame boundary keeps a replay from starting
   * mid-escape, so any divergence is attributable to unrepainted cells.
   */
  evictThroughFrame?: number;
  /** Record and deliver `dropIndex + 2` while the repair round-trip is open. */
  deliverDuringRepair?: boolean;
  /** Re-apply this frame's bytes straight to xterm — sabotage control. */
  duplicateFrame?: number;
}

interface RunResult {
  snapshot: ScreenSnapshot;
  counters: Readonly<RecoveryCounters>;
}

async function runScript(
  frames: DifferentialFrameScript,
  options: RunOptions = {},
): Promise<RunResult> {
  const surface = createScreenTerminal({ cols: frames.cols, rows: frames.rows, scrollback: 200 });
  const ring = createOutputRing({ cols: frames.cols, rows: frames.rows });
  const duringRepairIndex =
    options.deliverDuringRepair && options.dropIndex !== undefined
      ? options.dropIndex + 2
      : undefined;
  const driver = createOutputSurfaceDriver({
    surface,
    ring,
    strategy: options.strategy,
    hooks: {
      beforeResume: async () => {
        if (duringRepairIndex === undefined) return;
        await driver.deliver(ring.record(frames.frames[duringRepairIndex]));
      },
    },
  });
  await driver.attach();
  for (let index = 0; index < frames.frames.length; index += 1) {
    // Already recorded and delivered from inside the repair round-trip.
    if (index === duringRepairIndex) continue;
    const delta = ring.record(frames.frames[index]);
    if (index === options.dropIndex) {
      if (options.evictThroughFrame !== undefined) {
        ring.evictTo(seqAfterFrame(options.evictThroughFrame));
      }
      // The notification never reaches the surface; the bytes stay in the ring.
      continue;
    }
    await driver.deliver(delta);
    if (index === options.duplicateFrame) await surface.write(frames.frames[index]);
  }
  await driver.idle();
  const snapshot = surface.capture();
  surface.dispose();
  return { snapshot, counters: driver.counters };
}

const noRecovery: RecoveryCounters = {
  gap: 0,
  repair: 0,
  ringEscalation: 0,
  geometryEscalation: 0,
  nestedGap: 0,
  repairFailure: 0,
  reattach: 0,
};

describe("differential render frames survive a delivery gap (ADR-0072 (7))", () => {
  it("paints the screen the script describes", async () => {
    const { snapshot, counters } = await runScript(script);
    expect(counters).toEqual(noRecovery);
    // Guards the premise: frame 0's cells are still on screen at the end, so
    // losing them below is a real loss and not an artifact of the script.
    const text = screenRows(snapshot).join("\n");
    for (const line of script.paintOnceText) expect(text).toContain(line);
    expect(screenRow(snapshot, 21)).toContain("> generate the");
    expect(formatScreen(snapshot)).toContain("baseY=0");
    // Wide cells take part in the comparison: xterm's own width, not ours.
    const widths = snapshot.viewport.flatMap((row) => row.cells.map((cell) => cell.width));
    expect(widths).toContain(2);
    expect(widths).toContain(0);
  });

  it("is cell-identical after a sequence-exact repair", async () => {
    const lossless = await runScript(script);
    const repaired = await runScript(script, {
      dropIndex: 6,
      // A delta lands while the repair is in flight, so the served range
      // overlaps the pending queue and the coordinator has to trim it.
      deliverDuringRepair: true,
    });
    expect(diffScreens(lossless.snapshot, repaired.snapshot)).toBeNull();
    expect(repaired.counters).toEqual({ ...noRecovery, gap: 1, repair: 1 });
  });

  it("is cell-identical even when the ring has already evicted the initial paint", async () => {
    // The bytes that painted the header are gone; the *gap range* is not. That
    // asymmetry is the whole point — repair needs the hole, not the history.
    const lossless = await runScript(script);
    const repaired = await runScript(script, { dropIndex: 6, evictThroughFrame: 0 });
    expect(diffScreens(lossless.snapshot, repaired.snapshot)).toBeNull();
    expect(repaired.counters).toEqual({ ...noRecovery, gap: 1, repair: 1 });
  });
});

describe("reset() + truncated replay does not restore the screen (issue #600)", () => {
  it("loses every row the program painted once and never repainted", async () => {
    const lossless = await runScript(script);
    const reattached = await runScript(script, {
      strategy: "reattach",
      dropIndex: 6,
      evictThroughFrame: 0,
    });

    expect(reattached.counters).toEqual({ ...noRecovery, gap: 1, reattach: 1 });
    // The defect, stated positively: this recovery path *cannot* reproduce the
    // screen. If this ever returns null the control group has stopped being a
    // control group and the tests above prove nothing.
    expect(diffScreens(lossless.snapshot, reattached.snapshot)).not.toBeNull();

    for (const row of script.paintOnceRows) {
      expect(screenRow(lossless.snapshot, row)).not.toBe("");
      // Nothing in the replayed suffix addresses these cells, so they stay
      // blank forever — exactly the permanent hole issue #596 measured.
      expect(screenRow(reattached.snapshot, row)).toBe("");
    }
    // Same story for the scrolled log lines, which move rows but are never
    // repainted either.
    const replayedText = screenRows(reattached.snapshot).join("\n");
    for (const line of script.paintOnceText) expect(replayedText).not.toContain(line);
  });

  it("escalates to that same path when the ring can no longer bridge the gap", async () => {
    // ADR-0072 keeps this residual and hangs a revisit condition on the counter.
    const lossless = await runScript(script);
    const escalated = await runScript(script, { dropIndex: 6, evictThroughFrame: 6 });

    expect(escalated.counters).toEqual({
      ...noRecovery,
      gap: 1,
      ringEscalation: 1,
      reattach: 1,
    });
    expect(diffScreens(lossless.snapshot, escalated.snapshot)).not.toBeNull();
    expect(screenRow(escalated.snapshot, 0)).toBe("");
  });
});

describe("the cell comparison is sensitive enough to be worth trusting", () => {
  it("catches one frame applied twice", async () => {
    // Sabotage control (dev-repro-methodology §5). The coordinator's job on a
    // repair is to splice bytes in *exactly once*; if applying a frame twice
    // were invisible here, the equality above would be vacuous.
    const lossless = await runScript(script);
    const doubled = await runScript(script, { duplicateFrame: 6 });
    expect(diffScreens(lossless.snapshot, doubled.snapshot)).not.toBeNull();
  });
});
