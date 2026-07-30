export type TerminalOutputV3DiagnosticState = "active" | "fail-stopped";

export interface TerminalOutputV3DiagnosticEntry {
  state: TerminalOutputV3DiagnosticState;
  reason: string | null;
  generation: number;
  leaseToken: string;
  attachEpoch: number;
  snapshotSeq: number;
  admittedSeq: number;
  parsedSeq: number;
  nextEnvelopeId: number;
  activeGrantId: string | null;
  repairCount: number;
  lastRepairReason: string | null;
}

const entries = new Map<string, TerminalOutputV3DiagnosticEntry>();

/**
 * Continuation control trace (issue: Codex frame flood identity_conflict).
 *
 * The backend keys its hold dedup on the opener envelope identity with the
 * grant id stripped, while this side keys it on the grant id too. Two holds
 * that look distinct here therefore collide there. Record what was actually
 * sent so the disagreement is observable instead of inferred.
 */
export interface TerminalOutputV3ControlTraceEntry {
  kind: "hold" | "close";
  envelopeId: number;
  grantId: string | null;
  seq: number;
  /** How many times `controlsForTransitions` had run for this envelope id. */
  envelopePass: number;
}

const controlTrace = new Map<string, TerminalOutputV3ControlTraceEntry[]>();
const envelopePasses = new Map<string, Map<number, number>>();
const CONTROL_TRACE_LIMIT = 24;

export function noteTerminalOutputV3EnvelopePass(terminalId: string, envelopeId: number): number {
  let passes = envelopePasses.get(terminalId);
  if (!passes) {
    passes = new Map();
    envelopePasses.set(terminalId, passes);
  }
  const pass = (passes.get(envelopeId) ?? 0) + 1;
  passes.set(envelopeId, pass);
  if (passes.size > 512) {
    for (const key of Array.from(passes.keys()).slice(0, 256)) passes.delete(key);
  }
  return pass;
}

export function recordTerminalOutputV3ControlTrace(
  terminalId: string,
  entry: TerminalOutputV3ControlTraceEntry,
): void {
  const list = controlTrace.get(terminalId) ?? [];
  list.push(entry);
  if (list.length > CONTROL_TRACE_LIMIT) list.splice(0, list.length - CONTROL_TRACE_LIMIT);
  controlTrace.set(terminalId, list);
}

export function allTerminalOutputV3ControlTrace(): Record<
  string,
  TerminalOutputV3ControlTraceEntry[]
> {
  return Object.fromEntries(
    Array.from(controlTrace, ([terminalId, list]) => [terminalId, list.map((e) => ({ ...e }))]),
  );
}

/** Publish identity/frontier metadata only. Terminal payload bytes never enter diagnostics. */
export function recordTerminalOutputV3Diagnostics(
  terminalId: string,
  entry: TerminalOutputV3DiagnosticEntry,
): void {
  entries.set(terminalId, { ...entry });
}

export function forgetTerminalOutputV3Diagnostics(terminalId: string): void {
  entries.delete(terminalId);
}

export function allTerminalOutputV3Diagnostics(): Record<string, TerminalOutputV3DiagnosticEntry> {
  return Object.fromEntries(
    Array.from(entries, ([terminalId, entry]) => [terminalId, { ...entry }]),
  );
}

export function resetTerminalOutputV3DiagnosticsForTest(): void {
  entries.clear();
  controlTrace.clear();
  envelopePasses.clear();
}
