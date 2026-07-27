/**
 * Drives a real xterm surface (`xterm-screen.ts`) from a real
 * {@link TerminalOutputAttachCoordinator} and a fake ring (`output-ring.ts`).
 *
 * This is the smallest glue that puts `TerminalView`'s output **recovery
 * decisions** in front of a real parser — attach, ingest, sequence-exact repair
 * with its round cap, and the pre-ADR-0072 reattach — without React, the store
 * or Tauri. It is deliberately explicit about what it does and does not prove:
 *
 * - **Proves**: what a stream of bytes does to the cell grid, including the
 *   coordinator's own splicing arithmetic (suffix offsets, duplicate rejection,
 *   pending drain order). Those are product code paths; only the plumbing here
 *   is test-owned.
 * - **Does not prove**: that `TerminalView` wires the same sequence. Component
 *   wiring stays in `TerminalView.test.tsx`; the two suites cover different
 *   halves of the same claim.
 *
 * Production behaviour this driver deliberately does **not** model, named so a
 * test here is never mistaken for one that covers it (issue #607):
 *
 * - the repair watchdog (`TERMINAL_OUTPUT_REPAIR_TIMEOUT_MS` → `repairTimeout`):
 *   `ring.resume()` is a synchronous call, so no round-trip can hang;
 * - delta validation (`normalizeTerminalOutputDelta` → `malformedDelta`) and
 *   attach failure (`attachFailure`): the ring hands back already-typed deltas
 *   and its `attach()` has no failure mode;
 * - readiness and epoch plumbing — `setOutputReady`, `outputAttachEpoch`,
 *   `isCurrentAttach()`, and the hand-off that kicks an attach-window repair
 *   from the attach's `finally` (so it skips the `TERMINAL_WRITE_RETRY_MS` hop
 *   and cannot race a live delta for the hole). Here the repair runs inline;
 * - the Remote render checkpoint model, which consumes the same segments beside
 *   xterm, and the per-terminal recovery counters' lifetime.
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

/**
 * Mirrors `TERMINAL_OUTPUT_REPAIR_MAX_ROUNDS` in `TerminalView.tsx`.
 *
 * A hole that reopens behind an applied repair range is still repayable by
 * another exact range, so it is retried rather than escalated; the cap only
 * stops a stream that loses deltas faster than repairs land from looping
 * forever (issue #607).
 */
export const SCREEN_REPAIR_MAX_ROUNDS = 4;

/**
 * How deep `escalate()` → `attach()` → `escalate()` may nest before the harness
 * gives up.
 *
 * Today `beginAttach()` clears `pending`, so the second `completeAttach()`
 * cannot report a gap and the recursion terminates by accident. A hook that
 * delivers deltas during an escalation removes that accident. A harness that
 * burns the stack in silence is worse than one that fails loudly.
 */
const MAX_ESCALATION_DEPTH = 4;

/**
 * Events this driver distinguishes — a **subset** of the production buckets in
 * `terminal-output-recovery-metrics.ts`, plus one bucket production does not
 * have.
 *
 * - `reattach` is driver-only. Production has no escalation counter (it infers
 *   escalations from the bucket that caused them), but the control group here
 *   has to assert that the screen-losing path actually ran, so it is counted
 *   directly.
 * - `malformedDelta` and `attachFailure` are missing because they cannot happen
 *   at this layer: the fake ring hands back already-typed deltas, so nothing
 *   fails validation, and `ring.attach()` has no failure mode.
 * - `repairTimeout` is missing for the same kind of reason: `ring.resume()` is
 *   synchronous, so there is no unsettled round-trip for a watchdog to catch.
 */
export interface RecoveryCounters {
  gap: number;
  repair: number;
  ringEscalation: number;
  geometryEscalation: number;
  /** Counted per round, like production: most rounds are repaid by the next. */
  nestedGap: number;
  /** The round cap gave up — the one bucket that says the screen was lost. */
  nestedGapEscalation: number;
  repairFailure: number;
  reattach: number;
}

export interface OutputSurfaceDriverOptions {
  surface: ScreenTerminal;
  ring: OutputRing;
  strategy?: RecoveryStrategy;
  /**
   * Test-owned sabotage: write the bytes a repair applies **twice**.
   *
   * The cell comparisons rest on the repair splicing the missing range in
   * exactly once. This knob makes the recovery path itself double-apply, so the
   * sabotage control travels the code path under test instead of poking xterm
   * behind the coordinator's back — which would only measure `diffScreens`.
   */
  sabotageDuplicateRepairWrite?: boolean;
  hooks?: {
    /**
     * Awaited between `ring.attach()` and `completeAttach()`. Models deltas that
     * arrive while the attach round-trip is open; dropping one of them is how a
     * test produces a gap in the attach window.
     */
    duringAttach?: () => Promise<void> | void;
    /**
     * Awaited between `beginRepair()` and the ring lookup. Lets a test deliver
     * more deltas while a repair is in flight, which is the case the pending
     * queue exists for. Receives the 1-based round number.
     */
    beforeResume?: (round: number) => Promise<void> | void;
    /**
     * Awaited between the ring serving the range and `completeRepair()`. The
     * backend computes the range when the request lands, so deltas that arrive
     * while the answer is in transit are *not* in it — dropping one of those is
     * how a test opens a hole behind the repaired range.
     */
    afterResume?: (round: number) => Promise<void> | void;
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
    nestedGapEscalation: 0,
    repairFailure: 0,
    reattach: 0,
  };
  let generation: number | undefined;
  let escalationDepth = 0;
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

  /**
   * Apply what a repair round produced. Writing the segments is mandatory even
   * when the round ended in a nested gap: the coordinator already moved
   * `expectedSeq` past those bytes, so dropping them would create the very cell
   * loss ADR-0072 exists to prevent.
   */
  const applyRepairChunks = (result: TerminalOutputApplyResult): Promise<void> =>
    enqueue(async () => {
      const passes = options.sabotageDuplicateRepairWrite ? 2 : 1;
      for (let pass = 0; pass < passes; pass += 1) {
        for (const chunk of result.chunks) await surface.write(chunk);
      }
    });

  const attach = async (): Promise<void> => {
    const attachment = ring.attach();
    generation = attachment.state.generation;
    await options.hooks?.duringAttach?.();
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
      if (strategy === "reattach") {
        await escalate();
        return;
      }
      // The desktop snapshot is the whole ring, so a delta lost during the
      // attach round-trip is still retained: repair the exact range instead of
      // escalating to another reattach that would only widen the same window
      // (issue #607). The prefix that arrived before the hole goes first — the
      // coordinator has already moved `expectedSeq` past it.
      await applyChunks(buffered);
      await repair();
      return;
    }
    await applyChunks(buffered);
  };

  const escalate = async (): Promise<void> => {
    if (escalationDepth >= MAX_ESCALATION_DEPTH) {
      throw new Error(
        `output surface driver escalated ${MAX_ESCALATION_DEPTH} times without settling`,
      );
    }
    escalationDepth += 1;
    try {
      counters.reattach += 1;
      coordinator.beginAttach();
      await attach();
    } finally {
      escalationDepth -= 1;
    }
  };

  const repair = async (): Promise<void> => {
    for (let round = 1; ; round += 1) {
      const resumeSeq = coordinator.beginRepair();
      await options.hooks?.beforeResume?.(round);
      const served = ring.resume(generation ?? -1, resumeSeq);
      if (!served) {
        // ADR-0072 reserves this counter for one thing: the backend answered
        // `null` because the ring no longer holds the range.
        counters.ringEscalation += 1;
        await escalate();
        return;
      }
      await options.hooks?.afterResume?.(round);
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
        await applyRepairChunks(result);
        counters.nestedGap += 1;
        // `ready` is false when the served range never reached the surface
        // sequence at all: nothing was applied and `beginRepair()` would throw,
        // so that shape can only escalate.
        if (!coordinator.ready || round >= SCREEN_REPAIR_MAX_ROUNDS) {
          // Its own bucket, for the reason ADR-0072 gave `ringEscalation` one:
          // `nestedGap` counts rounds, and only this one says the screen was
          // lost — it is the sole evidence that could move the cap.
          counters.nestedGapEscalation += 1;
          await escalate();
          return;
        }
        continue;
      }
      counters.repair += 1;
      await applyRepairChunks(result);
      return;
    }
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
