/**
 * Drives a real xterm surface (`xterm-screen.ts`) from a real
 * {@link TerminalOutputAttachCoordinator} and a fake ring (`output-ring.ts`).
 *
 * This is the smallest glue that reproduces `TerminalView`'s output path —
 * attach, ingest, and the two recovery strategies — without React, the store or
 * Tauri. It is deliberately explicit about what it does and does not prove:
 *
 * - **Proves**: what a stream of bytes does to the cell grid, including the
 *   coordinator's own splicing arithmetic (suffix offsets, duplicate rejection,
 *   pending drain order). Those are product code paths; only the plumbing here
 *   is test-owned.
 * - **Does not prove**: that `TerminalView` wires the same sequence. Component
 *   wiring stays in `TerminalView.test.tsx`; the two suites cover different
 *   halves of the same claim.
 *
 * The `"reattach"` strategy is not dead code — it is the control group. It is
 * what the desktop did before [ADR-0072]: throw the gapped delta away,
 * `reset()`, and replay whatever the ring still holds. Keeping it runnable is
 * what lets a test *demonstrate* the screen loss instead of asserting that the
 * current code merely differs from something unspecified.
 */

import {
  TerminalOutputAttachCoordinator,
  TerminalOutputRepairError,
} from "@/lib/terminal-output-attach-coordinator";
import type {
  TerminalOutputApplyResult,
  TerminalOutputDelta,
} from "@/lib/terminal-output-attach-coordinator";
import type { OutputRing } from "./output-ring";
import type { ScreenTerminal } from "./xterm-screen";

export type RecoveryStrategy =
  /** Current behaviour: pull the exact missing range out of the ring. */
  | "sequence-exact"
  /** Pre-ADR-0072 behaviour: drop the delta, `reset()`, replay the ring. */
  | "reattach";

/** Same buckets `terminal-output-recovery-metrics.ts` keeps in production. */
export interface RecoveryCounters {
  gap: number;
  repair: number;
  ringEscalation: number;
  geometryEscalation: number;
  nestedGap: number;
  repairFailure: number;
  reattach: number;
}

export interface OutputSurfaceDriverOptions {
  surface: ScreenTerminal;
  ring: OutputRing;
  strategy?: RecoveryStrategy;
  hooks?: {
    /**
     * Awaited between `beginRepair()` and the ring lookup. Lets a test deliver
     * more deltas while a repair is in flight, which is the case the pending
     * queue exists for.
     */
    beforeResume?: () => Promise<void> | void;
  };
}

export interface OutputSurfaceDriver {
  readonly counters: Readonly<RecoveryCounters>;
  /** Full attach: snapshot the ring, `reset()`, replay, then accept deltas. */
  attach(): Promise<void>;
  /** Deliver one `terminal-output-v2` notification. */
  deliver(delta: TerminalOutputDelta): Promise<void>;
  /** Resolve once every queued xterm write has been parsed. */
  idle(): Promise<void>;
}

export function createOutputSurfaceDriver(
  options: OutputSurfaceDriverOptions,
): OutputSurfaceDriver {
  const { surface, ring } = options;
  const strategy = options.strategy ?? "sequence-exact";
  const coordinator = new TerminalOutputAttachCoordinator();
  const counters: RecoveryCounters = {
    gap: 0,
    repair: 0,
    ringEscalation: 0,
    geometryEscalation: 0,
    nestedGap: 0,
    repairFailure: 0,
    reattach: 0,
  };
  let generation: number | undefined;
  // xterm's own write queue is FIFO, but the awaits below can interleave, so
  // chain them the way TerminalView chains `terminalOutputWriteChain`.
  let writeChain: Promise<void> = Promise.resolve();

  const enqueue = (run: () => Promise<void>): Promise<void> => {
    writeChain = writeChain.then(run);
    return writeChain;
  };

  const applyChunks = (result: TerminalOutputApplyResult): Promise<void> =>
    enqueue(async () => {
      for (const chunk of result.chunks) await surface.write(chunk);
    });

  const attach = async (): Promise<void> => {
    const attachment = ring.attach();
    generation = attachment.state.generation;
    await enqueue(async () => {
      // The screen-losing step. Everything painted before `snapshotStartSeq` is
      // gone, and only bytes the replay happens to repaint come back.
      surface.reset();
      if (attachment.snapshot.length > 0) await surface.write(attachment.snapshot);
      await surface.write(attachment.state.modes.bracketedPaste ? "\x1b[?2004h" : "\x1b[?2004l");
    });
    const buffered = coordinator.completeAttach(attachment);
    if (buffered.kind === "gap") {
      counters.gap += 1;
      await escalate();
      return;
    }
    await applyChunks(buffered);
  };

  const escalate = async (): Promise<void> => {
    counters.reattach += 1;
    coordinator.beginAttach();
    await attach();
  };

  const repair = async (): Promise<void> => {
    const resumeSeq = coordinator.beginRepair();
    await options.hooks?.beforeResume?.();
    const served = ring.resume(generation ?? -1, resumeSeq);
    if (!served) {
      // ADR-0072 reserves this counter for one thing: the backend answered
      // `null` because the ring no longer holds the range.
      counters.ringEscalation += 1;
      await escalate();
      return;
    }
    let result: TerminalOutputApplyResult;
    try {
      result = coordinator.completeRepair(served);
    } catch (error) {
      if (error instanceof TerminalOutputRepairError && error.reason === "geometry-change") {
        counters.geometryEscalation += 1;
      } else {
        counters.repairFailure += 1;
      }
      await escalate();
      return;
    }
    if (result.kind === "gap") {
      counters.nestedGap += 1;
      await escalate();
      return;
    }
    counters.repair += 1;
    await applyChunks(result);
  };

  const recover = async (): Promise<void> => {
    counters.gap += 1;
    if (strategy === "reattach") {
      await escalate();
      return;
    }
    await repair();
  };

  return {
    counters,
    attach,
    async deliver(delta) {
      const result = coordinator.ingest(delta);
      if (result.kind === "gap") {
        await recover();
        return;
      }
      await applyChunks(result);
    },
    idle: () => enqueue(async () => {}),
  };
}
