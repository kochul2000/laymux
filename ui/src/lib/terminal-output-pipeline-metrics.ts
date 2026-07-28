/**
 * Per-terminal cost counters for the frontend output pipeline (issue #606).
 *
 * The recovery counters next door (`terminal-output-recovery-metrics.ts`) answer
 * "did the stream break?". They were all zero while the frontend was 42–87 s
 * unresponsive, which proved the stall is not a correctness failure — and left
 * nobody able to say where the time went.
 *
 * These counters answer "what did the pipeline pay for?". They are diagnostic
 * only: nothing reads them to make a decision. They are read out of band, over
 * `GET /api/v1/diagnostics/frontend`, which is served from Rust state and
 * therefore still answers while the WebView main thread is saturated — the one
 * thing the `automation-request` bridge cannot do.
 *
 * Lifetime matches the recovery counters: one backend session, dropped by
 * `closeTerminalSession`.
 */

export interface TerminalOutputPipelineCounters {
  /** `terminal-output-v2` events the listener received. */
  deltaEvents: number;
  /** Bytes those events carried. */
  deltaBytes: number;
  /** Segments handed to the apply path before coalescing. */
  segmentsIn: number;
  /** Segments left after coalescing — i.e. actual xterm/checkpoint writes. */
  segmentsOut: number;
  /** Deepest apply backlog observed, in segments. */
  applyQueueMaxDepth: number;
  /** `terminal.write` calls made on the visible xterm. */
  xtermWrites: number;
  /** Bytes those writes carried. */
  xtermWriteBytes: number;
  /** Deepest `deferredTerminalWrites` FIFO depth observed. */
  writeQueueMaxDepth: number;
  /** Times xterm refused a write with backpressure and the chunk was retried. */
  writeBackpressure: number;
  /** `apply()` calls on the rendererless checkpoint model (ADR-0069). */
  checkpointApplies: number;
  /** `fitAddon.fit()` calls that actually ran. */
  fits: number;
  /** Longest a fit sat deferred behind the write FIFO / quiet window, in ms. */
  fitDeferredMaxMs: number;
  /** WebGL texture-atlas rebuilds this surface performed. */
  atlasRebuilds: number;
  /** Full re-attaches (`attach_terminal_output`), i.e. screen-losing replays. */
  attaches: number;
  /** Snapshot bytes actually replayed into xterm by those attaches. */
  attachReplayBytes: number;
}

export type TerminalOutputPipelineCounterName = keyof TerminalOutputPipelineCounters;

const COUNTERS: readonly TerminalOutputPipelineCounterName[] = [
  "deltaEvents",
  "deltaBytes",
  "segmentsIn",
  "segmentsOut",
  "applyQueueMaxDepth",
  "xtermWrites",
  "xtermWriteBytes",
  "writeQueueMaxDepth",
  "writeBackpressure",
  "checkpointApplies",
  "fits",
  "fitDeferredMaxMs",
  "atlasRebuilds",
  "attaches",
  "attachReplayBytes",
];

/** Counters whose meaning is "high-water mark", not "running total". */
const MAX_COUNTERS = new Set<TerminalOutputPipelineCounterName>([
  "applyQueueMaxDepth",
  "writeQueueMaxDepth",
  "fitDeferredMaxMs",
]);

const counters = new Map<string, TerminalOutputPipelineCounters>();

function zeroed(): TerminalOutputPipelineCounters {
  return Object.fromEntries(
    COUNTERS.map((name) => [name, 0]),
  ) as unknown as TerminalOutputPipelineCounters;
}

function entryFor(terminalId: string): TerminalOutputPipelineCounters {
  let entry = counters.get(terminalId);
  if (!entry) {
    entry = zeroed();
    counters.set(terminalId, entry);
  }
  return entry;
}

/**
 * Add to a running total, or raise a high-water mark.
 *
 * One function for both so callers never have to remember which kind a counter
 * is; {@link MAX_COUNTERS} is the single place that decides.
 */
export function recordTerminalOutputPipeline(
  terminalId: string,
  counter: TerminalOutputPipelineCounterName,
  value = 1,
): void {
  const entry = entryFor(terminalId);
  if (MAX_COUNTERS.has(counter)) {
    if (value > entry[counter]) entry[counter] = value;
    return;
  }
  entry[counter] += value;
}

export function terminalOutputPipelineCounters(terminalId: string): TerminalOutputPipelineCounters {
  const entry = counters.get(terminalId);
  return entry ? { ...entry } : zeroed();
}

/** Every terminal that has produced pipeline counters, keyed by terminal id. */
export function allTerminalOutputPipelineCounters(): Record<
  string,
  TerminalOutputPipelineCounters
> {
  const snapshot: Record<string, TerminalOutputPipelineCounters> = {};
  for (const [terminalId, entry] of counters) snapshot[terminalId] = { ...entry };
  return snapshot;
}

/** Drop the totals for a terminal whose backend session is gone. */
export function forgetTerminalOutputPipelineCounters(terminalId: string): void {
  counters.delete(terminalId);
}

export function resetTerminalOutputPipelineCounters(): void {
  counters.clear();
}
