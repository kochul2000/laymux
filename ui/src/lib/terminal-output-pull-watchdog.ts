/** Low-frequency exact pull period for a desktop parsed-credit lease. */
export const TERMINAL_OUTPUT_PULL_WATCHDOG_PERIOD_MS = 1_000;

/** A tick this late may have been queued behind the same stalled event edge. */
const TERMINAL_OUTPUT_PULL_WATCHDOG_MIN_DEFER_LAG_MS = 500;

/** Only a tick observed within the first two seconds may be deferred. */
const TERMINAL_OUTPUT_PULL_WATCHDOG_MAX_DEFER_ELAPSED_MS = 2_000;

export class TerminalOutputPullWatchdogCadence {
  private lastTickAt: number;
  private nextPollRequired = false;

  constructor(startedAt: number) {
    this.lastTickAt = startedAt;
  }

  shouldPoll(now: number): boolean {
    const elapsed = Math.max(0, now - this.lastTickAt);
    this.lastTickAt = now;
    if (this.nextPollRequired) {
      this.nextPollRequired = false;
      return true;
    }
    const tickLag = Math.max(0, elapsed - TERMINAL_OUTPUT_PULL_WATCHDOG_PERIOD_MS);
    if (
      tickLag < TERMINAL_OUTPUT_PULL_WATCHDOG_MIN_DEFER_LAG_MS ||
      elapsed >= TERMINAL_OUTPUT_PULL_WATCHDOG_MAX_DEFER_ELAPSED_MS
    ) {
      return true;
    }
    this.nextPollRequired = true;
    return false;
  }
}
