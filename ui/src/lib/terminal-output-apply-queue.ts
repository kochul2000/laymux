import type { TerminalOutputAppliedSegment } from "./terminal-output-attach-coordinator";
import { coalesceTerminalOutputSegments } from "./terminal-output-coalesce";

export interface TerminalOutputApplyQueueOptions {
  /**
   * Whether the surface still owes a parse callback for bytes already handed to
   * it. While true the queue holds segments back so they can be merged.
   */
  isSurfaceBusy: () => boolean;
  /** Hand a merged batch to the surface, in order. */
  apply: (segments: TerminalOutputAppliedSegment[]) => void;
  /** Called with the queue depth after every push, for diagnostics. */
  onDepth?: (depth: number) => void;
}

/**
 * Holds already-sequenced output segments only while the surface is behind, and
 * merges what accumulated before applying it (issue #606).
 *
 * The problem this solves is a cost that is per-segment rather than per-byte.
 * Applying one segment costs a `terminal.write` plus its parse callback, a
 * rendererless checkpoint-model write (ADR-0069), a stabilizer push, a
 * `TextDecoder` round, and a full sweep of the activity/Codex/Claude detectors
 * over their rolling windows. An output flood arrives as thousands of small
 * `terminal-output-v2` deltas, so that constant — not the byte volume — is what
 * saturates the WebView main thread. Once it is saturated, every `automation-request`
 * queues behind it and the Automation API can only answer
 * `Frontend response timeout`; a layout change lands synchronous reflow/atlas work
 * in the middle, and the backlog it creates takes far longer to clear than the
 * work itself took.
 *
 * The trigger is backpressure, never a timer:
 * - **surface idle** → apply immediately, so nothing about interactive latency
 *   changes and a single delta is still a single write;
 * - **surface busy** → hold, and let the write that is already in flight flush
 *   the queue on completion. Latency is therefore bounded by the parse already
 *   underway, and the batch size grows only as far as the surface is behind.
 *
 * Ordering is total: one queue in arrival order, so a sequence-exact repair range
 * still reaches the surface ahead of the deltas it splices in front of
 * (ADR-0072). Merging itself is refused across generation, geometry revision and
 * sequence holes — see {@link coalesceTerminalOutputSegments}.
 */
export class TerminalOutputApplyQueue {
  private queued: TerminalOutputAppliedSegment[] = [];

  constructor(private readonly options: TerminalOutputApplyQueueOptions) {}

  get depth(): number {
    return this.queued.length;
  }

  /** Accept segments; apply now if the surface is idle, otherwise hold them. */
  push(segments: readonly TerminalOutputAppliedSegment[]): void {
    if (segments.length === 0) return;
    for (const segment of segments) this.queued.push(segment);
    this.options.onDepth?.(this.queued.length);
    if (!this.options.isSurfaceBusy()) this.flush();
  }

  /** Apply everything held, merged. Safe to call when empty. */
  flush(): void {
    if (this.queued.length === 0) return;
    const queued = this.queued;
    // Cleared before `apply` runs: applying re-enters through the write FIFO,
    // which flushes again on completion, and a queue that still held these
    // segments would write them twice.
    this.queued = [];
    this.options.apply(coalesceTerminalOutputSegments(queued));
  }

  /**
   * Drop everything held without applying it.
   *
   * The only legitimate caller is a full re-attach: it `reset()`s the surface and
   * replays the ring, so anything still queued describes a screen that is about
   * to be discarded and would be applied on top of the replay.
   */
  clear(): void {
    this.queued = [];
  }
}
