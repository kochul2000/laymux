export const TERMINAL_OUTPUT_ENVELOPE_VERSION = 3;
export const TERMINAL_OUTPUT_ENVELOPE_MAX_BYTES = 64 * 1024;
export const TERMINAL_OUTPUT_ENVELOPE_MAX_DELTAS = 8 * 1024;
export const TERMINAL_OUTPUT_ENVELOPE_MAX_IN_FLIGHT = 4;

export interface TerminalOutputEnvelopeGeometry {
  revision: number;
  cols: number;
  rows: number;
}

export interface TerminalOutputEnvelopeGeometryRun {
  deltaIndex: number;
  geometry: TerminalOutputEnvelopeGeometry;
}

export interface TerminalOutputEnvelopePayload {
  version: number;
  generation: number;
  leaseToken: string;
  envelopeId: number;
  /** `null` is the explicit no-continuation identity. */
  grantId: string | null;
  seqStart: number;
  seqEnd: number;
  data: number[] | Uint8Array;
  deltaEnds: number[];
  geometryRuns: TerminalOutputEnvelopeGeometryRun[];
}

export interface TerminalOutputEnvelopeReceiptIdentity {
  generation: number;
  leaseToken: string;
  envelopeId: number;
  grantId: string | null;
}

export interface TerminalOutputEnvelopeDelta {
  generation: number;
  leaseToken: string;
  envelopeId: number;
  grantId: string | null;
  seqStart: number;
  seqEnd: number;
  data: Uint8Array;
  geometry: TerminalOutputEnvelopeGeometry;
}

export interface TerminalOutputEnvelope {
  version: typeof TERMINAL_OUTPUT_ENVELOPE_VERSION;
  generation: number;
  leaseToken: string;
  envelopeId: number;
  grantId: string | null;
  seqStart: number;
  seqEnd: number;
  /** The one decoded allocation every delta references with `subarray`. */
  backing: Uint8Array;
  deltas: readonly TerminalOutputEnvelopeDelta[];
  receiptIdentity: TerminalOutputEnvelopeReceiptIdentity;
}

/** Decode and validate a complete v3 event before any caller-owned state changes. */
export function normalizeTerminalOutputEnvelope(value: unknown): TerminalOutputEnvelope {
  if (!isRecord(value)) fail("metadata");

  const version = value.version;
  const generation = value.generation;
  const leaseToken = value.leaseToken;
  const envelopeId = value.envelopeId;
  const grantId = value.grantId;
  const seqStart = value.seqStart;
  const seqEnd = value.seqEnd;

  if (version !== TERMINAL_OUTPUT_ENVELOPE_VERSION) fail("version");
  if (!isNonnegativeSafeInteger(generation)) fail("generation");
  if (!isNonemptyString(leaseToken)) fail("lease token");
  if (!isPositiveSafeInteger(envelopeId)) fail("envelope id");
  if (grantId !== null && !isNonemptyString(grantId)) fail("grant id");
  if (
    !isNonnegativeSafeInteger(seqStart) ||
    !isNonnegativeSafeInteger(seqEnd) ||
    seqEnd < seqStart
  ) {
    fail("source range");
  }

  const backing = normalizeData(value.data);
  if (backing.byteLength !== seqEnd - seqStart) fail("source range");

  const deltaEnds = normalizeDeltaEnds(value.deltaEnds, backing.byteLength);
  const geometryRuns = normalizeGeometryRuns(value.geometryRuns, deltaEnds.length);

  const deltas: TerminalOutputEnvelopeDelta[] = [];
  let start = 0;
  let geometryRunIndex = 0;
  for (let deltaIndex = 0; deltaIndex < deltaEnds.length; deltaIndex += 1) {
    while (
      geometryRunIndex + 1 < geometryRuns.length &&
      geometryRuns[geometryRunIndex + 1].deltaIndex <= deltaIndex
    ) {
      geometryRunIndex += 1;
    }
    const end = deltaEnds[deltaIndex];
    deltas.push({
      generation,
      leaseToken,
      envelopeId,
      grantId,
      seqStart: seqStart + start,
      seqEnd: seqStart + end,
      data: backing.subarray(start, end),
      geometry: geometryRuns[geometryRunIndex].geometry,
    });
    start = end;
  }

  return {
    version: TERMINAL_OUTPUT_ENVELOPE_VERSION,
    generation,
    leaseToken,
    envelopeId,
    grantId,
    seqStart,
    seqEnd,
    backing,
    deltas,
    receiptIdentity: { generation, leaseToken, envelopeId, grantId },
  };
}

function normalizeData(value: unknown): Uint8Array {
  if (isUint8Array(value)) {
    if (value.byteLength === 0 || value.byteLength > TERMINAL_OUTPUT_ENVELOPE_MAX_BYTES) {
      fail("data");
    }
    return value;
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > TERMINAL_OUTPUT_ENVELOPE_MAX_BYTES ||
    !value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  ) {
    fail("data");
  }
  return new Uint8Array(value);
}

function normalizeDeltaEnds(value: unknown, byteLength: number): readonly number[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > TERMINAL_OUTPUT_ENVELOPE_MAX_DELTAS
  ) {
    fail("delta boundaries");
  }

  let previous = 0;
  for (const end of value) {
    if (!isPositiveSafeInteger(end) || end <= previous || end > byteLength) {
      fail("delta boundaries");
    }
    previous = end;
  }
  if (previous !== byteLength) fail("delta boundaries");
  return value;
}

function normalizeGeometryRuns(
  value: unknown,
  deltaCount: number,
): readonly TerminalOutputEnvelopeGeometryRun[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > deltaCount) {
    fail("geometry runs");
  }

  const runs: TerminalOutputEnvelopeGeometryRun[] = [];
  let previous = -1;
  for (const candidate of value) {
    if (!isRecord(candidate)) fail("geometry runs");
    const deltaIndex = candidate.deltaIndex;
    if (
      !isNonnegativeSafeInteger(deltaIndex) ||
      deltaIndex <= previous ||
      deltaIndex >= deltaCount ||
      !isGeometry(candidate.geometry)
    ) {
      fail("geometry runs");
    }
    runs.push({
      deltaIndex,
      geometry: {
        revision: candidate.geometry.revision,
        cols: candidate.geometry.cols,
        rows: candidate.geometry.rows,
      },
    });
    previous = deltaIndex;
  }
  if (runs[0].deltaIndex !== 0) fail("geometry runs");
  return runs;
}

function isGeometry(value: unknown): value is TerminalOutputEnvelopeGeometry {
  return (
    isRecord(value) &&
    isNonnegativeSafeInteger(value.revision) &&
    isPositiveSafeInteger(value.cols) &&
    isPositiveSafeInteger(value.rows)
  );
}

function isUint8Array(value: unknown): value is Uint8Array {
  return (
    value instanceof Uint8Array || Object.prototype.toString.call(value) === "[object Uint8Array]"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function fail(part: string): never {
  throw new Error(`invalid terminal output envelope ${part}`);
}
