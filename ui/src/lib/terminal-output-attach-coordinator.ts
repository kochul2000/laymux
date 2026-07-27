export const TERMINAL_OUTPUT_PROTOCOL_VERSION = 1;

export interface TerminalGeometry {
  revision: number;
  cols: number;
  rows: number;
}

export interface TerminalAttachState {
  version: number;
  generation: number;
  snapshotStartSeq: number;
  snapshotSeq: number;
  sourceStartSeq: number;
  sourceSeq: number;
  snapshotKind: "raw";
  protocolRevision: number;
  modes: {
    bracketedPaste: boolean;
  };
  geometry: TerminalGeometry;
}

export interface TerminalOutputAttachment {
  state: TerminalAttachState;
  snapshot: Uint8Array;
}

export interface TerminalOutputDelta {
  generation: number;
  seqStart: number;
  seqEnd: number;
  data: Uint8Array;
  geometry: TerminalGeometry;
}

export type TerminalOutputAppliedSegment = TerminalOutputDelta;

export type TerminalOutputApplyResult =
  | {
      kind: "buffered" | "duplicate";
      chunks: Uint8Array[];
      segments: TerminalOutputAppliedSegment[];
    }
  | { kind: "apply"; chunks: Uint8Array[]; segments: TerminalOutputAppliedSegment[] }
  | {
      kind: "gap";
      chunks: Uint8Array[];
      segments: TerminalOutputAppliedSegment[];
      expectedSeq: number;
      actualSeq: number;
    };

/** Why a served repair range could not be spliced into the stream. */
export type TerminalOutputRepairRejection =
  /** The range covers bytes written on two different PTY grids. */
  | "geometry-change"
  /** The attachment was replaced while the repair was in flight. */
  | "generation-change"
  /** No repair was pending — `beginRepair()` never ran, or an attach took over. */
  | "not-pending";

/**
 * A repair the coordinator refused, tagged with a machine-readable reason.
 *
 * The caller routes each reason to its own recovery counter, and ADR-0072 hangs
 * its revisit conditions on those counters. Classifying by `error.message`
 * instead would silently misfile every bucket the moment a message is reworded,
 * which is exactly the kind of instrumentation rot this PR exists to prevent.
 */
export class TerminalOutputRepairError extends Error {
  readonly reason: TerminalOutputRepairRejection;

  constructor(reason: TerminalOutputRepairRejection, message: string) {
    super(message);
    this.name = "TerminalOutputRepairError";
    this.reason = reason;
  }
}

/**
 * Reconciles listener-before-RPC output without guessing across a sequence gap.
 * The caller owns xterm write ordering; this class only decides exact byte suffixes.
 *
 * A `terminal-output-v2` event is a notification, not a delivery guarantee. When
 * one is lost the bytes still live in the backend ring, so a gap is repaired by
 * pulling the exact missing range rather than by throwing the screen away
 * (ADR-0072). The gapped delta therefore stays buffered: the repair splices in
 * front of it and it is applied right after, in sequence.
 */
export class TerminalOutputAttachCoordinator {
  private pending: TerminalOutputDelta[] = [];
  private expectedSeq: number | null = null;
  private generation: number | null = null;
  private geometryRevision: number | null = null;
  private repairSeq: number | null = null;

  get ready(): boolean {
    return this.expectedSeq !== null;
  }

  beginAttach(): void {
    this.expectedSeq = null;
    this.generation = null;
    this.geometryRevision = null;
    this.repairSeq = null;
    this.pending = [];
  }

  ingest(delta: TerminalOutputDelta): TerminalOutputApplyResult {
    validateDelta(delta);
    if (this.expectedSeq === null) {
      this.pending.push(delta);
      return { kind: "buffered", chunks: [], segments: [] };
    }
    return this.consume(delta);
  }

  completeAttach(attachment: TerminalOutputAttachment): TerminalOutputApplyResult {
    try {
      validateAttachment(attachment);
    } catch (error) {
      this.beginAttach();
      throw error;
    }
    this.repairSeq = null;
    this.expectedSeq = attachment.state.snapshotSeq;
    this.generation = attachment.state.generation;
    this.geometryRevision = attachment.state.geometry.revision;
    return this.drainPending();
  }

  /**
   * Suspend delta application and report the sequence the surface actually holds.
   * Deltas that arrive while a repair is in flight are buffered, so no further
   * gap is reported for the same hole.
   */
  beginRepair(): number {
    const expected = this.expectedSeq;
    if (expected === null) throw new Error("terminal output attach is not ready");
    this.repairSeq = expected;
    this.expectedSeq = null;
    return expected;
  }

  /**
   * Apply the backend-served range for the pending repair, then the deltas that
   * arrived while it was in flight. `kind: "gap"` means the repair did not reach
   * the sequence the surface holds and the caller must fall back to a full attach.
   *
   * Every refusal is a {@link TerminalOutputRepairError} carrying a `reason`, so
   * the caller never has to inspect a message to pick a counter.
   */
  completeRepair(repair: TerminalOutputDelta): TerminalOutputApplyResult {
    validateDelta(repair);
    const resumeSeq = this.repairSeq;
    if (resumeSeq === null) {
      throw new TerminalOutputRepairError("not-pending", "terminal output repair is not pending");
    }
    this.repairSeq = null;
    if (repair.generation !== this.generation) {
      throw new TerminalOutputRepairError(
        "generation-change",
        "terminal output generation changed",
      );
    }
    // The ring stores bytes, not per-byte geometry, so one repair delta cannot
    // describe bytes written on two different grids. Refuse instead of parsing
    // pre-resize bytes at the post-resize size.
    if (repair.geometry.revision !== this.geometryRevision) {
      throw new TerminalOutputRepairError(
        "geometry-change",
        "terminal output repair spans a geometry change",
      );
    }
    if (repair.seqStart > resumeSeq) {
      return {
        kind: "gap",
        chunks: [],
        segments: [],
        expectedSeq: resumeSeq,
        actualSeq: repair.seqStart,
      };
    }

    this.expectedSeq = resumeSeq;
    const first = this.consume(repair);
    if (first.kind === "gap") return first;
    const rest = this.drainPending();
    if (rest.kind === "gap") {
      return {
        ...rest,
        chunks: [...first.chunks, ...rest.chunks],
        segments: [...first.segments, ...rest.segments],
      };
    }
    const chunks = [...first.chunks, ...rest.chunks];
    return {
      kind: chunks.length > 0 ? "apply" : "duplicate",
      chunks,
      segments: [...first.segments, ...rest.segments],
    };
  }

  private drainPending(): TerminalOutputApplyResult {
    const pending = this.pending.sort((a, b) => a.seqStart - b.seqStart || a.seqEnd - b.seqEnd);
    this.pending = [];
    const chunks: Uint8Array[] = [];
    const segments: TerminalOutputAppliedSegment[] = [];
    for (let index = 0; index < pending.length; index += 1) {
      const result = this.consume(pending[index]);
      if (result.kind === "gap") {
        // `consume` re-buffered the gapped delta; keep the deltas behind it too
        // so one repair can bridge the whole hole.
        this.pending.push(...pending.slice(index + 1));
        return {
          ...result,
          chunks: [...chunks, ...result.chunks],
          segments: [...segments, ...result.segments],
        };
      }
      chunks.push(...result.chunks);
      segments.push(...result.segments);
    }
    return { kind: chunks.length > 0 ? "apply" : "duplicate", chunks, segments };
  }

  private consume(delta: TerminalOutputDelta): TerminalOutputApplyResult {
    const expected = this.expectedSeq;
    if (expected === null) throw new Error("terminal output attach is not ready");
    if (delta.generation !== this.generation) {
      throw new Error("terminal output generation changed");
    }
    if (delta.seqEnd <= expected) return { kind: "duplicate", chunks: [], segments: [] };
    if (delta.seqStart > expected) {
      // Keep the delta so a sequence-exact repair can splice in front of it.
      this.pending.push(delta);
      return {
        kind: "gap",
        chunks: [],
        segments: [],
        expectedSeq: expected,
        actualSeq: delta.seqStart,
      };
    }

    const offset = Math.max(0, expected - delta.seqStart);
    const suffix = delta.data.slice(offset);
    this.expectedSeq = delta.seqEnd;
    this.geometryRevision = delta.geometry.revision;
    const segment = {
      ...delta,
      seqStart: expected,
      data: suffix,
    };
    return {
      kind: "apply",
      chunks: suffix.length > 0 ? [suffix] : [],
      segments: suffix.length > 0 ? [segment] : [],
    };
  }
}

export function normalizeTerminalOutputAttachment(value: {
  state: TerminalAttachState;
  snapshot: number[] | Uint8Array;
}): TerminalOutputAttachment {
  const attachment = {
    state: value.state,
    snapshot:
      value.snapshot instanceof Uint8Array ? value.snapshot : new Uint8Array(value.snapshot),
  };
  validateAttachment(attachment);
  return attachment;
}

export function normalizeTerminalOutputDelta(value: {
  generation: number;
  seqStart: number;
  seqEnd: number;
  data: number[] | Uint8Array;
  geometry: TerminalGeometry;
}): TerminalOutputDelta {
  const delta = {
    generation: value.generation,
    seqStart: value.seqStart,
    seqEnd: value.seqEnd,
    data: value.data instanceof Uint8Array ? value.data : new Uint8Array(value.data),
    geometry: value.geometry,
  };
  validateDelta(delta);
  return delta;
}

function validateAttachment(attachment: TerminalOutputAttachment): void {
  const { snapshot } = attachment;
  const stateValue: unknown = attachment.state;
  if (!isMetadataObject(stateValue)) {
    throw new Error("invalid terminal output attachment state");
  }
  const state = stateValue;
  if (state.version !== TERMINAL_OUTPUT_PROTOCOL_VERSION) {
    throw new Error(`unsupported terminal output protocol: ${state.version}`);
  }
  const snapshotStartSeq = state.snapshotStartSeq;
  const snapshotSeq = state.snapshotSeq;
  if (
    !isNonnegativeSafeInteger(snapshotStartSeq) ||
    !isNonnegativeSafeInteger(snapshotSeq) ||
    snapshotSeq < snapshotStartSeq ||
    snapshot.length !== snapshotSeq - snapshotStartSeq ||
    state.sourceStartSeq !== snapshotStartSeq ||
    state.sourceSeq !== snapshotSeq
  ) {
    throw new Error("invalid terminal output attachment range");
  }
  if (
    !isNonnegativeSafeInteger(state.generation) ||
    state.snapshotKind !== "raw" ||
    !isNonnegativeSafeInteger(state.protocolRevision) ||
    !isMetadataObject(state.modes) ||
    typeof state.modes.bracketedPaste !== "boolean" ||
    !isGeometry(state.geometry)
  ) {
    throw new Error("invalid terminal output attachment state");
  }
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isMetadataObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateDelta(delta: TerminalOutputDelta): void {
  if (
    !isNonnegativeSafeInteger(delta.generation) ||
    !Number.isSafeInteger(delta.seqStart) ||
    !Number.isSafeInteger(delta.seqEnd) ||
    delta.seqStart < 0 ||
    delta.seqEnd < delta.seqStart ||
    delta.data.length !== delta.seqEnd - delta.seqStart ||
    !isGeometry(delta.geometry)
  ) {
    throw new Error("invalid terminal output delta range");
  }
}

function isGeometry(value: unknown): value is TerminalGeometry {
  return (
    isMetadataObject(value) &&
    isNonnegativeSafeInteger(value.revision) &&
    isPositiveSafeInteger(value.cols) &&
    isPositiveSafeInteger(value.rows)
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
