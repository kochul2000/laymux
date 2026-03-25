/**
 * Detects terminal output idle state (monitor-silence pattern).
 *
 * Records output events and fires a callback after a configurable
 * period of silence. Similar to tmux's `monitor-silence` option.
 */
export class OutputIdleDetector {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private timeoutMs: number,
    private onIdle: () => void,
  ) {}

  /** Call on every terminal output chunk. Resets the idle timer. */
  recordOutput(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onIdle();
    }, this.timeoutMs);
  }

  /** Cancel the current timer without disposing. */
  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Cancel timer and prevent future use. */
  dispose(): void {
    this.cancel();
  }
}
