import type { TerminalWriteSource } from "./terminal-data-route";

/** Hard upper bounds for one ordinary physical xterm write. */
export const TERMINAL_WRITE_BATCH_MAX_PARTS = 128;
export const TERMINAL_WRITE_BATCH_MAX_BYTES = 256 * 1024;
/** Logical enqueue slice and maximum physical batch while another pane waits. */
export const TERMINAL_WRITE_FAIR_QUANTUM_BYTES = 64 * 1024;

/**
 * Split one decoded ingress backing into scheduler-sized views without
 * copying its bytes. Queue admission of each view is the physical ownership
 * handoff; the envelope ingress can retain only compact source-range ledgers.
 */
export function terminalWriteFairSlices(data: Uint8Array): readonly Uint8Array[] {
  if (data.byteLength === 0) return [data];
  const slices: Uint8Array[] = [];
  for (let offset = 0; offset < data.byteLength; offset += TERMINAL_WRITE_FAIR_QUANTUM_BYTES) {
    slices.push(data.subarray(offset, offset + TERMINAL_WRITE_FAIR_QUANTUM_BYTES));
  }
  return slices;
}

/**
 * Metadata whose cursor/parser meaning must survive physical-write batching.
 *
 * `batchKey` on the request is the caller's explicit equivalence contract for
 * any additional metadata. These fields are nevertheless checked here because
 * accidentally merging one of their special cases would change observable
 * terminal behaviour rather than merely reduce write calls.
 */
export interface TerminalWriteBatchMetadata {
  source: TerminalWriteSource;
  attachEpoch?: number;
  generation?: number;
  stabilized?: boolean;
  parkDeadline?: number;
  frameEndCursorAuthoritative?: boolean;
  compositionActive?: boolean;
}

export interface TerminalWriteBatchRequest<
  TMetadata extends TerminalWriteBatchMetadata = TerminalWriteBatchMetadata,
> {
  data: string | Uint8Array;
  metadata: TMetadata;
  /**
   * Explicit identity of one merge-compatible live-output run.
   * Missing keys are always barriers.
   */
  batchKey?: string;
  /** A second, explicit allowlist gate controlled by the producer. */
  allowCoalescing: boolean;
  /**
   * The producer guarantees callbacks may settle together after one physical
   * parse/discard. Missing/false keeps callback-bearing requests as barriers.
   */
  coalesceCallbacks?: boolean;
  /** External completion semantics make this request an atomic barrier. */
  onParsed?: () => void;
  /** External cancellation semantics make this request an atomic barrier. */
  onDiscard?: () => void;
}

export interface QueuedTerminalWriteRequest<
  TMetadata extends TerminalWriteBatchMetadata = TerminalWriteBatchMetadata,
> extends TerminalWriteBatchRequest<TMetadata> {
  id: number;
}

/**
 * A prefix removed from the logical FIFO and materialized for one physical
 * write. Keep this object when xterm reports backpressure and pass it to
 * {@link TerminalWriteBatchQueue.restore}; the next dequeue returns this exact
 * object and buffer without concatenating it a second time.
 */
export interface PreparedTerminalWriteBatch<
  TMetadata extends TerminalWriteBatchMetadata = TerminalWriteBatchMetadata,
> {
  data: string | Uint8Array;
  byteLength: number;
  partCount: number;
  firstId: number;
  lastId: number;
  metadata: TMetadata;
  entries: readonly QueuedTerminalWriteRequest<TMetadata>[];
  /** Mutable retry diagnostic state; preserved because restore keeps identity. */
  warned: boolean;
}

type PreparedState = "taken" | "queued" | "discarded";

const utf8Encoder = new TextEncoder();

function dataByteLength(data: string | Uint8Array): number {
  return typeof data === "string" ? utf8Encoder.encode(data).byteLength : data.byteLength;
}

function isIndividuallyCoalescible<TMetadata extends TerminalWriteBatchMetadata>(
  entry: QueuedTerminalWriteRequest<TMetadata>,
): entry is QueuedTerminalWriteRequest<TMetadata> & {
  data: Uint8Array;
  batchKey: string;
} {
  const metadata = entry.metadata;
  return (
    entry.allowCoalescing &&
    entry.batchKey !== undefined &&
    entry.data instanceof Uint8Array &&
    metadata.source === "live" &&
    metadata.stabilized !== true &&
    metadata.parkDeadline === undefined &&
    metadata.frameEndCursorAuthoritative !== true &&
    metadata.compositionActive !== true &&
    ((entry.onParsed === undefined && entry.onDiscard === undefined) ||
      entry.coalesceCallbacks === true)
  );
}

function canJoin<TMetadata extends TerminalWriteBatchMetadata>(
  first: QueuedTerminalWriteRequest<TMetadata>,
  candidate: QueuedTerminalWriteRequest<TMetadata>,
): boolean {
  return (
    isIndividuallyCoalescible(first) &&
    isIndividuallyCoalescible(candidate) &&
    first.batchKey === candidate.batchKey &&
    first.metadata.source === candidate.metadata.source &&
    first.metadata.attachEpoch === candidate.metadata.attachEpoch &&
    first.metadata.generation === candidate.metadata.generation
  );
}

/**
 * Head-index FIFO for logical terminal writes.
 *
 * It batches only explicitly compatible ordinary live-byte requests. Replay,
 * strings, cursor-stabilized emissions, deadline-bearing emissions,
 * authoritative frame ends, and composition output remain one physical write
 * each. Callback-bearing requests merge only under the producer's explicit
 * callback-coalescing contract; the prepared batch retains every callback.
 * Dequeue is bounded by both part count and bytes; an oversized/atomic request
 * at the head still progresses alone.
 */
export class TerminalWriteBatchQueue<
  TMetadata extends TerminalWriteBatchMetadata = TerminalWriteBatchMetadata,
> {
  private entries: QueuedTerminalWriteRequest<TMetadata>[] = [];
  private headIndex = 0;
  private nextId = 1;
  private queuedDepth = 0;
  private queuedBytes = 0;
  private restored: PreparedTerminalWriteBatch<TMetadata> | undefined;
  private readonly preparedStates = new WeakMap<
    PreparedTerminalWriteBatch<TMetadata>,
    PreparedState
  >();

  get depth(): number {
    return this.queuedDepth;
  }

  get bytes(): number {
    return this.queuedBytes;
  }

  /** Zero before the first enqueue; IDs are monotonically increasing thereafter. */
  get lastEnqueuedId(): number {
    return this.nextId - 1;
  }

  enqueue(request: TerminalWriteBatchRequest<TMetadata>): number {
    const id = this.nextId;
    this.nextId += 1;
    this.entries.push({ ...request, id });
    this.queuedDepth += 1;
    this.queuedBytes += dataByteLength(request.data);
    return id;
  }

  /**
   * Remove and prepare the oldest eligible prefix.
   *
   * `cutoffMaxId` freezes a finite drain window: neither the returned batch nor
   * any of its parts can include an enqueue newer than that ID. The dynamic
   * `allowCoalescing` gate is sampled here, not at enqueue, so a composition
   * that starts while requests wait turns every fresh dequeue into one part.
   * `maxCoalescedBytes` can lower the physical batch for a contended scheduler
   * turn without changing the queue's 256 KiB hard ceiling. It applies only to
   * fresh materialization: a restored retry keeps the exact accepted buffer
   * identity and callback set it had before contention changed.
   * A restored multi-part retry is held until the gate opens because splitting
   * it would violate the no-rematerialization retry contract.
   */
  dequeue(
    cutoffMaxId = this.lastEnqueuedId,
    allowCoalescing = true,
    maxCoalescedBytes = TERMINAL_WRITE_BATCH_MAX_BYTES,
  ): PreparedTerminalWriteBatch<TMetadata> | undefined {
    if (this.restored) {
      if (this.restored.lastId > cutoffMaxId || (!allowCoalescing && this.restored.partCount > 1)) {
        return undefined;
      }
      const restored = this.restored;
      this.restored = undefined;
      this.removeMetrics(restored.partCount, restored.byteLength);
      this.preparedStates.set(restored, "taken");
      return restored;
    }

    const first = this.entries[this.headIndex];
    if (!first || first.id > cutoffMaxId) return undefined;

    const coalescingByteLimit = Math.min(
      TERMINAL_WRITE_BATCH_MAX_BYTES,
      Math.max(0, maxCoalescedBytes),
    );
    let partCount = 1;
    let byteLength = dataByteLength(first.data);
    if (allowCoalescing && isIndividuallyCoalescible(first) && byteLength <= coalescingByteLimit) {
      while (partCount < TERMINAL_WRITE_BATCH_MAX_PARTS) {
        const candidate = this.entries[this.headIndex + partCount];
        if (!candidate || candidate.id > cutoffMaxId || !canJoin(first, candidate)) break;
        const candidateBytes = dataByteLength(candidate.data);
        if (byteLength + candidateBytes > coalescingByteLimit) break;
        byteLength += candidateBytes;
        partCount += 1;
      }
    }

    const selected = this.entries.slice(this.headIndex, this.headIndex + partCount);
    const data = this.materialize(selected, byteLength);
    const batch: PreparedTerminalWriteBatch<TMetadata> = {
      data,
      byteLength,
      partCount,
      firstId: first.id,
      lastId: selected[selected.length - 1].id,
      metadata: first.metadata,
      entries: selected,
      warned: false,
    };

    this.headIndex += partCount;
    this.removeMetrics(partCount, byteLength);
    this.compactConsumedHead();
    this.preparedStates.set(batch, "taken");
    return batch;
  }

  /** Put a backpressured prepared batch back at the logical head, unchanged. */
  restore(batch: PreparedTerminalWriteBatch<TMetadata>): void {
    const state = this.preparedStates.get(batch);
    if (state === undefined) {
      throw new Error("prepared batch does not belong to this queue");
    }
    if (state === "queued") {
      throw new Error("prepared batch is already queued");
    }
    if (state === "discarded") {
      throw new Error("cannot restore a discarded prepared batch");
    }
    if (this.restored !== undefined) {
      throw new Error("another prepared batch is already queued at the head");
    }
    this.restored = batch;
    this.queuedDepth += batch.partCount;
    this.queuedBytes += batch.byteLength;
    this.preparedStates.set(batch, "queued");
  }

  /**
   * Remove every not-yet-dequeued request while preserving ID monotonicity.
   *
   * A restored retry is logically at the head and is discarded first. A batch
   * already returned by {@link dequeue} remains the caller's in-flight
   * responsibility. State is reset before callbacks run so callback re-entry
   * cannot be accidentally erased by this clear.
   */
  clear(discardCallbacks = true): void {
    const pending = [...(this.restored?.entries ?? []), ...this.entries.slice(this.headIndex)];
    if (this.restored) this.preparedStates.set(this.restored, "discarded");

    this.restored = undefined;
    this.entries = [];
    this.headIndex = 0;
    this.queuedDepth = 0;
    this.queuedBytes = 0;

    if (!discardCallbacks) return;
    let firstError: unknown;
    for (const entry of pending) {
      try {
        entry.onDiscard?.();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  }

  private materialize(
    entries: readonly QueuedTerminalWriteRequest<TMetadata>[],
    byteLength: number,
  ): string | Uint8Array {
    if (entries.length === 1) return entries[0].data;

    const data = new Uint8Array(byteLength);
    let offset = 0;
    for (const entry of entries) {
      // Multiple entries are selected only after the Uint8Array allowlist gate.
      const part = entry.data as Uint8Array;
      data.set(part, offset);
      offset += part.byteLength;
    }
    return data;
  }

  private removeMetrics(partCount: number, byteLength: number): void {
    this.queuedDepth -= partCount;
    this.queuedBytes -= byteLength;
  }

  private compactConsumedHead(): void {
    if (this.headIndex === this.entries.length) {
      this.entries = [];
      this.headIndex = 0;
      return;
    }
    if (this.headIndex >= 1024 && this.headIndex * 2 >= this.entries.length) {
      this.entries = this.entries.slice(this.headIndex);
      this.headIndex = 0;
    }
  }
}
