export type TerminalOutputControlOutcome<T> =
  | { kind: "resolved"; value: T }
  | { kind: "rejected"; error: unknown }
  | { kind: "timeout" };

export interface TerminalOutputControlWatchdogOptions {
  onTimeout?: () => void;
  /** Called once when the underlying bridge Promise resolves or rejects. */
  onSettled?: () => void;
}

const DEFAULT_CONTROL_BACKOFF_BASE_MS = 50;
const DEFAULT_CONTROL_BACKOFF_MAX_MS = 1_000;

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
  options: TerminalOutputControlWatchdogOptions = {},
): Promise<TerminalOutputControlOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let state: "pending" | "settled" | "timed-out" = "pending";
  const recordSettlement = () => {
    state = "settled";
    try {
      options.onSettled?.();
    } catch {
      // Resource bookkeeping is isolated from bridge completion semantics.
    }
  };
  const settled = Promise.resolve(operation).then<
    TerminalOutputControlOutcome<T>,
    TerminalOutputControlOutcome<T>
  >(
    (value) => {
      recordSettlement();
      return { kind: "resolved", value };
    },
    (error: unknown) => {
      recordSettlement();
      return { kind: "rejected", error };
    },
  );
  try {
    return await Promise.race([
      settled,
      new Promise<TerminalOutputControlOutcome<T>>((resolve) => {
        timer = setTimeout(
          () => {
            if (state !== "pending") return;
            state = "timed-out";
            try {
              options.onTimeout?.();
            } catch {
              // The timeout verdict still has to reach the epoch owner.
            }
            resolve({ kind: "timeout" });
          },
          Math.max(0, timeoutMs),
        );
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
