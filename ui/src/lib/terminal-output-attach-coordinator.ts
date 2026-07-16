export const TERMINAL_OUTPUT_PROTOCOL_VERSION = 1;

export interface TerminalAttachState {
  version: number;
  snapshotStartSeq: number;
  snapshotSeq: number;
  protocolRevision: number;
  modes: {
    bracketedPaste: boolean;
  };
}

export interface TerminalOutputAttachment {
  state: TerminalAttachState;
  snapshot: Uint8Array;
}

export interface TerminalOutputDelta {
  seqStart: number;
  seqEnd: number;
  data: Uint8Array;
}

export type TerminalOutputApplyResult =
  | { kind: "buffered" | "duplicate"; chunks: Uint8Array[] }
  | { kind: "apply"; chunks: Uint8Array[] }
  | { kind: "gap"; chunks: Uint8Array[]; expectedSeq: number; actualSeq: number };

/**
 * Reconciles listener-before-RPC output without guessing across a sequence gap.
 * The caller owns xterm write ordering; this class only decides exact byte suffixes.
 */
export class TerminalOutputAttachCoordinator {
  private pending: TerminalOutputDelta[] = [];
  private expectedSeq: number | null = null;

  get ready(): boolean {
    return this.expectedSeq !== null;
  }

  beginAttach(): void {
    this.expectedSeq = null;
    this.pending = [];
  }

  ingest(delta: TerminalOutputDelta): TerminalOutputApplyResult {
    validateDelta(delta);
    if (this.expectedSeq === null) {
      this.pending.push(delta);
      return { kind: "buffered", chunks: [] };
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

    const pending = this.pending;
    this.pending = [];
    const chunks: Uint8Array[] = [];
    for (const delta of pending.sort((a, b) => a.seqStart - b.seqStart || a.seqEnd - b.seqEnd)) {
      const result = this.consume(delta);
      if (result.kind === "gap") return { ...result, chunks: [...chunks, ...result.chunks] };
      chunks.push(...result.chunks);
    }
    return { kind: chunks.length > 0 ? "apply" : "duplicate", chunks };
  }

  private consume(delta: TerminalOutputDelta): TerminalOutputApplyResult {
    const expected = this.expectedSeq;
    if (expected === null) throw new Error("terminal output attach is not ready");
    if (delta.seqEnd <= expected) return { kind: "duplicate", chunks: [] };
    if (delta.seqStart > expected) {
      return { kind: "gap", chunks: [], expectedSeq: expected, actualSeq: delta.seqStart };
    }

    const offset = Math.max(0, expected - delta.seqStart);
    const suffix = delta.data.slice(offset);
    this.expectedSeq = delta.seqEnd;
    return { kind: "apply", chunks: suffix.length > 0 ? [suffix] : [] };
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
  seqStart: number;
  seqEnd: number;
  data: number[] | Uint8Array;
}): TerminalOutputDelta {
  return {
    seqStart: value.seqStart,
    seqEnd: value.seqEnd,
    data: value.data instanceof Uint8Array ? value.data : new Uint8Array(value.data),
  };
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
    snapshot.length !== snapshotSeq - snapshotStartSeq
  ) {
    throw new Error("invalid terminal output attachment range");
  }
  if (
    !isNonnegativeSafeInteger(state.protocolRevision) ||
    !isMetadataObject(state.modes) ||
    typeof state.modes.bracketedPaste !== "boolean"
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
    !Number.isSafeInteger(delta.seqStart) ||
    !Number.isSafeInteger(delta.seqEnd) ||
    delta.seqStart < 0 ||
    delta.seqEnd < delta.seqStart ||
    delta.data.length !== delta.seqEnd - delta.seqStart
  ) {
    throw new Error("invalid terminal output delta range");
  }
}
