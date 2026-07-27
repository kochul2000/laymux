/**
 * Per-terminal counters for the sequenced output recovery path (ADR-0072).
 *
 * issue #600 could not be confirmed because nobody knew how often a
 * `terminal-output-v2` delta is actually lost, nor which of the several
 * recovery triggers fires. A single `console.warn` per event is not countable
 * once a flood scrolls it away, so every warning carries the running totals for
 * that terminal instead.
 *
 * The counters are keyed by terminal id and are diagnostic only: nothing reads
 * them to make a decision.
 *
 * Their lifetime is **one backend session**, not one terminal id:
 * `closeTerminalSession` calls {@link forgetTerminalOutputRecoveryCounters},
 * because the ring, the generation and every sequence the totals describe die
 * with it. Without that hook a long-lived window accumulates one entry per
 * terminal it ever opened (issue #607).
 *
 * That is shorter than the terminal id's own life, and deliberately so. The
 * xterm-creation effect in `TerminalView` closes the session from its cleanup,
 * so a remount under the same `instanceId` — a hidden-pane eviction, a profile
 * change, a StrictMode double mount — starts the totals over. Read "this one
 * pane keeps missing" within one mount, and read a reset as "the ring these
 * numbers described is gone" rather than as data loss. Surviving remounts would
 * mean dropping the totals from the explicit pane-destroy paths instead, and
 * there is no single one to hang them on: `removePane`, `removeWorkspace`,
 * `removeDockPane` and `setPaneView` each end a terminal id independently.
 */

export type TerminalOutputRecoveryEvent =
  /** `seqStart > expectedSeq` observed on a live delta. */
  | "gap"
  /** A gap repaired byte-exactly from the ring; the screen was kept. */
  | "repair"
  /**
   * The ring could no longer bridge the gap → full reattach, screen lost.
   *
   * ADR-0072 hangs a revisit condition (ring size / checkpoint reuse) on this
   * bucket alone, so nothing else may be filed here. It counts exactly one
   * thing: `resume_terminal_output` answered `null`.
   */
  | "ringEscalation"
  /** The gap spanned a resize → full reattach, screen lost. */
  | "geometryEscalation"
  /**
   * The repair applied, but a second hole opened behind it inside the same
   * pending drain. Unrelated to ring retention.
   *
   * Counted once per occurrence, not once per reattach: another exact range can
   * repay the new hole too, so recovery retries up to
   * `TERMINAL_OUTPUT_REPAIR_MAX_ROUNDS` times and only then escalates to a full
   * reattach (issue #607). A pure observation, therefore — it says a hole
   * reopened, not whether the screen survived. See {@link
   * TerminalOutputRecoveryEvent} `nestedGapEscalation` for the latter.
   */
  | "nestedGap"
  /**
   * The repair loop ran out of rounds and gave up → full reattach, screen lost.
   *
   * Its own bucket for the reason ADR-0072 gave `ringEscalation` one: it is the
   * only evidence that separates "a nested gap was repaid" from "a nested gap
   * cost the screen", and therefore the only evidence that could justify moving
   * `TERMINAL_OUTPUT_REPAIR_MAX_ROUNDS` — a cap this code invented, so nothing
   * else measures it (issue #607).
   */
  | "nestedGapEscalation"
  /**
   * The repair round-trip never settled within the watchdog window → full
   * reattach. Its own bucket because a hung round-trip is a dead IPC channel,
   * not a rejected request: it is the one failure that would otherwise freeze
   * the pane's output forever (issue #607).
   */
  | "repairTimeout"
  /** The repair round-trip failed for any other reason → full reattach. */
  | "repairFailure"
  /** A live delta or a served repair range failed metadata/range validation. */
  | "malformedDelta"
  /** `attach_terminal_output` or its replay failed. */
  | "attachFailure";

export type TerminalOutputRecoveryCounters = Record<TerminalOutputRecoveryEvent, number>;

const EVENTS: readonly TerminalOutputRecoveryEvent[] = [
  "gap",
  "repair",
  "ringEscalation",
  "geometryEscalation",
  "nestedGap",
  "nestedGapEscalation",
  "repairTimeout",
  "repairFailure",
  "malformedDelta",
  "attachFailure",
];

const counters = new Map<string, TerminalOutputRecoveryCounters>();

function zeroed(): TerminalOutputRecoveryCounters {
  return Object.fromEntries(EVENTS.map((event) => [event, 0])) as TerminalOutputRecoveryCounters;
}

/** Count one recovery event and return an immutable snapshot for logging. */
export function recordTerminalOutputRecovery(
  terminalId: string,
  event: TerminalOutputRecoveryEvent,
): TerminalOutputRecoveryCounters {
  let entry = counters.get(terminalId);
  if (!entry) {
    entry = zeroed();
    counters.set(terminalId, entry);
  }
  entry[event] += 1;
  return { ...entry };
}

export function terminalOutputRecoveryCounters(terminalId: string): TerminalOutputRecoveryCounters {
  const entry = counters.get(terminalId);
  return entry ? { ...entry } : zeroed();
}

/**
 * Drop the totals for a terminal whose backend session is gone.
 *
 * Called from the `close_terminal_session` path: once the session is closed its
 * ring and generation are gone, so the totals no longer describe anything a
 * later warning could be compared against. Keeping them would grow the map by
 * one entry per terminal the window ever opened (issue #607).
 *
 * That path is also `TerminalView`'s unmount cleanup, so this runs on remount
 * too — see the module docstring for why the shorter lifetime is accepted.
 * Idempotent: the pane-teardown paths remove several panes per gesture.
 */
export function forgetTerminalOutputRecoveryCounters(terminalId: string): void {
  counters.delete(terminalId);
}

export function resetTerminalOutputRecoveryCounters(): void {
  counters.clear();
}

/** Test-only: how many terminals currently hold counters. */
export function terminalOutputRecoveryCounterCount(): number {
  return counters.size;
}
