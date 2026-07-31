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
type TerminalOutputV3DiagnosticProvider = () => TerminalOutputV3DiagnosticEntry | undefined;
const providers = new Map<string, { owner: symbol; read: TerminalOutputV3DiagnosticProvider }>();

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

/**
 * Register the current mount's synchronous runtime snapshot reader.
 *
 * The returned disposer is owner-fenced: cleanup from a replaced TerminalView
 * cannot remove the newer mount's provider for the same terminal id.
 */
export function registerTerminalOutputV3DiagnosticsProvider(
  terminalId: string,
  read: TerminalOutputV3DiagnosticProvider,
): () => void {
  const owner = Symbol(terminalId);
  providers.set(terminalId, { owner, read });
  return () => {
    if (providers.get(terminalId)?.owner === owner) providers.delete(terminalId);
  };
}

export function allTerminalOutputV3Diagnostics(): Record<string, TerminalOutputV3DiagnosticEntry> {
  const snapshots = new Map(
    Array.from(entries, ([terminalId, entry]) => [terminalId, { ...entry }] as const),
  );
  for (const [terminalId, provider] of providers) {
    try {
      const live = provider.read();
      if (live) snapshots.set(terminalId, { ...live });
    } catch {
      // Diagnostics must not disrupt parser or health reporting. The last
      // published snapshot remains an explicitly stale fallback.
    }
  }
  return Object.fromEntries(snapshots);
}

/** Runtime-only snapshots. Missing/throwing providers are omitted, never replaced by stale cache. */
export function allLiveTerminalOutputV3Diagnostics(): Record<
  string,
  TerminalOutputV3DiagnosticEntry
> {
  const snapshots = new Map<string, TerminalOutputV3DiagnosticEntry>();
  for (const [terminalId, provider] of providers) {
    try {
      const live = provider.read();
      if (live) snapshots.set(terminalId, { ...live });
    } catch {
      // A missing terminal makes benchmark acceptance fail closed. Do not make
      // a stale published ACK snapshot look like capture-start parser backlog.
    }
  }
  return Object.fromEntries(snapshots);
}

export function resetTerminalOutputV3DiagnosticsForTest(): void {
  entries.clear();
  providers.clear();
  controlTrace.clear();
  envelopePasses.clear();
}
