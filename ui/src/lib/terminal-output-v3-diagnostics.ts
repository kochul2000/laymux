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
}
