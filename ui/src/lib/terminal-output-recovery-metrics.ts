/**
 * Per-terminal counters for the sequenced output recovery path (ADR-0072).
 *
 * issue #600 could not be confirmed because nobody knew how often a
 * `terminal-output-v2` delta is actually lost, nor which of the several
 * recovery triggers fires. A single `console.warn` per event is not countable
 * once a flood scrolls it away, so every warning carries the running totals for
 * that terminal instead.
 *
 * The counters are keyed by terminal id and survive `TerminalView` remounts on
 * purpose — the symptom is "this one pane keeps missing", which is a property of
 * the terminal, not of one React mount. They are diagnostic only: nothing reads
 * them to make a decision.
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
   * pending drain → full reattach. Unrelated to ring retention.
   */
  | "nestedGap"
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

export function resetTerminalOutputRecoveryCounters(): void {
  counters.clear();
}
