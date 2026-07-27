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

/**
 * Reconciles listener-before-RPC output without guessing across a sequence gap.
 * The caller owns xterm write ordering; this class only decides exact byte suffixes.
 */
export class TerminalOutputAttachCoordinator {
  private pending: TerminalOutputDelta[] = [];
  private expectedSeq: number | null = null;
  private generation: number | null = null;

  get ready(): boolean {
    return this.expectedSeq !== null;
  }

  beginAttach(): void {
    this.expectedSeq = null;
    this.generation = null;
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
    this.expectedSeq = attachment.state.snapshotSeq;
    this.generation = attachment.state.generation;

    const pending = this.pending;
    this.pending = [];
    const chunks: Uint8Array[] = [];
    const segments: TerminalOutputAppliedSegment[] = [];
    for (const delta of pending.sort((a, b) => a.seqStart - b.seqStart || a.seqEnd - b.seqEnd)) {
      const result = this.consume(delta);
      if (result.kind === "gap") {
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
