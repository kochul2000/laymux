export type TerminalOutputControlOutcome<T> =
  | { kind: "resolved"; value: T }
  | { kind: "rejected"; error: unknown }
  | { kind: "timeout" };

export interface TerminalOutputControlWatchdogOptions {
  onTimeout?: () => void;
  onOrphanSettled?: () => void;
}

const DEFAULT_CONTROL_BACKOFF_BASE_MS = 50;
const DEFAULT_CONTROL_BACKOFF_MAX_MS = 1_000;

/** Mount-local resource budget for timed-out bridge Promises still pending. */
export class TerminalOutputControlOrphanBudget {
  private outstandingCount = 0;
  private capacityWaiter: (() => void) | undefined;

  constructor(private readonly maxOutstanding = 6) {
    if (!Number.isInteger(maxOutstanding) || maxOutstanding <= 0) {
      throw new Error("terminal output orphan budget must be a positive integer");
    }
  }

  get outstanding(): number {
    return this.outstandingCount;
  }

  get canStart(): boolean {
    return this.outstandingCount < this.maxOutstanding;
  }

  recordTimeout(): void {
    if (!this.canStart) {
      throw new Error("terminal output orphan budget exceeded");
    }
    this.outstandingCount += 1;
  }

  recordOrphanSettled(): void {
    if (this.outstandingCount === 0) return;
    this.outstandingCount -= 1;
    if (!this.canStart || !this.capacityWaiter) return;
    const waiter = this.capacityWaiter;
    this.capacityWaiter = undefined;
    try {
      waiter();
    } catch {
      // A stale/unmounted recovery callback cannot corrupt resource accounting.
    }
  }

  waitForCapacity(waiter: () => void): void {
    this.capacityWaiter = waiter;
    if (!this.canStart) return;
    this.capacityWaiter = undefined;
    try {
      waiter();
    } catch {
      // Recovery callbacks are epoch guarded by the owner.
    }
  }

  dispose(): void {
    this.capacityWaiter = undefined;
  }
}

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
    const wasOrphan = state === "timed-out";
    state = "settled";
    if (!wasOrphan) return;
    try {
      options.onOrphanSettled?.();
    } catch {
      // Resource bookkeeping is isolated from stale bridge completion.
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
