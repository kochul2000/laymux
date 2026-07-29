export type TerminalOutputControlOutcome<T> =
  | { kind: "resolved"; value: T }
  | { kind: "rejected"; error: unknown }
  | { kind: "timeout" };

const DEFAULT_CONTROL_BACKOFF_BASE_MS = 50;
const DEFAULT_CONTROL_BACKOFF_MAX_MS = 1_000;
const MAX_UNSETTLED_CONTROL_OPERATIONS_PER_KIND = 6;

/**
 * Bound one local IPC bridge call without cancelling the underlying Promise.
 *
 * The settled wrapper installs both fulfillment and rejection handlers before
 * racing the timer. Consequently an orphan bridge completion is always
 * consumed after timeout. Its result is deliberately absent from the returned
 * timeout outcome, leaving the caller's current epoch as the only authority
 * that may publish a lease or mutate a parsed prefix.
 */
export async function settleTerminalOutputControl<T>(
  operation: PromiseLike<T>,
  timeoutMs: number,
): Promise<TerminalOutputControlOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = Promise.resolve(operation).then<
    TerminalOutputControlOutcome<T>,
    TerminalOutputControlOutcome<T>
  >(
    (value) => ({ kind: "resolved", value }),
    (error: unknown) => ({ kind: "rejected", error }),
  );
  try {
    return await Promise.race([
      settled,
      new Promise<TerminalOutputControlOutcome<T>>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), Math.max(0, timeoutMs));
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Make liveness state authoritative before running fallible diagnostics.
 *
 * A patched console or a poisoned diagnostic adapter must never strand parsed
 * credit on the epoch that recovery was trying to replace.
 */
export function recoverTerminalOutputControl(replaceEpoch: () => void, diagnose: () => void): void {
  replaceEpoch();
  try {
    diagnose();
  } catch {
    // Diagnostics are outside the terminal-output delivery contract.
  }
}

/** 50 → 100 → ... → 1,000 ms; zero means no timeout recovery is pending. */
export function boundedTerminalOutputControlBackoff(timeoutStreak: number): number {
  if (!Number.isFinite(timeoutStreak) || timeoutStreak <= 0) return 0;
  const exponent = Math.min(Math.floor(timeoutStreak) - 1, 30);
  return Math.min(DEFAULT_CONTROL_BACKOFF_MAX_MS, DEFAULT_CONTROL_BACKOFF_BASE_MS * 2 ** exponent);
}

/**
 * An IPC Promise cannot be cancelled, so retrying forever would retain one
 * orphan per watchdog window. One initial call plus five replacements is the
 * hard per-mount/per-kind bound; progress resets the corresponding streak.
 */
export function terminalOutputControlMayRetry(timeoutStreak: number): boolean {
  return timeoutStreak > 0 && timeoutStreak < MAX_UNSETTLED_CONTROL_OPERATIONS_PER_KIND;
}
