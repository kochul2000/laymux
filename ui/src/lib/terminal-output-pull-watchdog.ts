/** Low-frequency exact pull period for a desktop parsed-credit lease. */
export const TERMINAL_OUTPUT_PULL_WATCHDOG_PERIOD_MS = 1_000;

/** A tick this late may have been queued behind the same stalled event edge. */
const TERMINAL_OUTPUT_PULL_WATCHDOG_MIN_DEFER_LAG_MS = 500;

/** Preserve two seconds of margin inside the backend's five-second receipt deadline. */
const TERMINAL_OUTPUT_PULL_WATCHDOG_MAX_POLL_INTERVAL_MS = 3_000;

export class TerminalOutputPullWatchdogCadence {
  private lastTickAt: number;
  private deferredPollNotBefore: number | null = null;
  private nextPollRequired = false;

  constructor(startedAt: number) {
    this.lastTickAt = startedAt;
  }

  requireNextPoll(): void {
    this.nextPollRequired = true;
    this.deferredPollNotBefore = null;
  }

  shouldPoll(now: number): boolean {
    const previousTickAt = this.lastTickAt;
    const elapsed = Math.max(0, now - previousTickAt);
    this.lastTickAt = now;
    if (this.nextPollRequired) {
      this.nextPollRequired = false;
      return true;
    }
    if (this.deferredPollNotBefore !== null) {
      if (now < this.deferredPollNotBefore) return false;
      this.deferredPollNotBefore = null;
      return true;
    }
    const tickLag = Math.max(0, elapsed - TERMINAL_OUTPUT_PULL_WATCHDOG_PERIOD_MS);
    const latestPollAt = previousTickAt + TERMINAL_OUTPUT_PULL_WATCHDOG_MAX_POLL_INTERVAL_MS;
    if (tickLag < TERMINAL_OUTPUT_PULL_WATCHDOG_MIN_DEFER_LAG_MS || now >= latestPollAt) {
      return true;
    }
    // setInterval keeps its original phase after a long main-thread task, so
    // its next callback can arrive almost immediately. Give the queued output
    // event one complete normal period after observing the stall.
    this.deferredPollNotBefore = Math.min(
      now + TERMINAL_OUTPUT_PULL_WATCHDOG_PERIOD_MS,
      latestPollAt,
    );
    return false;
  }
}
