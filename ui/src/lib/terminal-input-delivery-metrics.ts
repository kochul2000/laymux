/**
 * Payload-free observability for local human input delivery (issue #667).
 *
 * An IPC rejection is ambiguous: Rust may have accepted the write and only the
 * response may have been lost. These counters therefore observe one caller
 * attempt; they never drive a retry, permit decision, or terminal recovery.
 * Entries live for one backend terminal session and are removed on close.
 */
export interface TerminalInputDeliveryCounters {
  attempts: number;
  succeeded: number;
  failed: number;
  attemptedBytes: number;
  succeededBytes: number;
  failedBytes: number;
}

export type TerminalInputDeliveryOutcome = "succeeded" | "failed";

export interface TerminalInputDeliveryAttempt {
  readonly terminalId: string;
  readonly sessionEpoch: number;
  readonly bytes: number;
}

interface TerminalInputDeliveryEntry extends TerminalInputDeliveryCounters {
  readonly sessionEpoch: number;
}

const counters = new Map<string, TerminalInputDeliveryEntry>();
const settledAttempts = new WeakSet<TerminalInputDeliveryAttempt>();
let nextSessionEpoch = 0;

function zeroed(): TerminalInputDeliveryCounters {
  return {
    attempts: 0,
    succeeded: 0,
    failed: 0,
    attemptedBytes: 0,
    succeededBytes: 0,
    failedBytes: 0,
  };
}

function entryFor(terminalId: string): TerminalInputDeliveryEntry {
  let entry = counters.get(terminalId);
  if (!entry) {
    entry = {
      ...zeroed(),
      sessionEpoch: ++nextSessionEpoch,
    };
    counters.set(terminalId, entry);
  }
  return entry;
}

/**
 * Start one human input submission and capture its backend-session identity.
 * The returned token must be used to settle it; a close or replacement makes
 * that settlement stale instead of allowing it to recreate old diagnostics.
 */
export function beginTerminalInputDelivery(
  terminalId: string,
  bytes: number,
): TerminalInputDeliveryAttempt {
  const entry = entryFor(terminalId);
  entry.attempts += 1;
  entry.attemptedBytes += bytes;
  return { terminalId, sessionEpoch: entry.sessionEpoch, bytes };
}

/**
 * Settle an attempt only while it still belongs to the live backend session.
 * `false` means the terminal closed or the id was replaced before completion.
 */
export function settleTerminalInputDelivery(
  attempt: TerminalInputDeliveryAttempt,
  outcome: TerminalInputDeliveryOutcome,
): boolean {
  const entry = counters.get(attempt.terminalId);
  if (!entry || entry.sessionEpoch !== attempt.sessionEpoch || settledAttempts.has(attempt)) {
    return false;
  }
  settledAttempts.add(attempt);
  if (outcome === "succeeded") {
    entry.succeeded += 1;
    entry.succeededBytes += attempt.bytes;
  } else {
    entry.failed += 1;
    entry.failedBytes += attempt.bytes;
  }
  return true;
}

export function terminalInputDeliveryCounters(terminalId: string): TerminalInputDeliveryCounters {
  const entry = counters.get(terminalId);
  if (!entry) return zeroed();
  const { sessionEpoch: _sessionEpoch, ...snapshot } = entry;
  return snapshot;
}

/** Every terminal that made a human input delivery attempt, keyed by terminal id. */
export function allTerminalInputDeliveryCounters(): Record<string, TerminalInputDeliveryCounters> {
  const snapshot: Record<string, TerminalInputDeliveryCounters> = {};
  for (const terminalId of counters.keys()) {
    snapshot[terminalId] = terminalInputDeliveryCounters(terminalId);
  }
  return snapshot;
}

/** Drop one closed backend session's diagnostics. Idempotent for teardown races. */
export function forgetTerminalInputDeliveryCounters(terminalId: string): void {
  counters.delete(terminalId);
}

export function resetTerminalInputDeliveryCounters(): void {
  counters.clear();
  nextSessionEpoch = 0;
}
