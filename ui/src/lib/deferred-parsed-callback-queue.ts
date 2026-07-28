interface DeferredParsedCallback {
  onParsed?: () => void;
  onDiscard?: () => void;
  settled: boolean;
}

export interface DrainedParsedCallbacks {
  onParsed: () => void;
  onDiscard: () => void;
}

/**
 * Keeps parser completion separate from lifecycle cancellation. A superseded
 * attach may release its internal waiter without reporting a stale write as
 * parsed.
 */
export class DeferredParsedCallbackQueue {
  private callbacks: DeferredParsedCallback[] = [];

  push(onParsed?: () => void, onDiscard?: () => void): void {
    if (!onParsed && !onDiscard) return;
    this.callbacks.push({ onParsed, onDiscard, settled: false });
  }

  drain(): DrainedParsedCallbacks | undefined {
    if (this.callbacks.length === 0) return undefined;
    const callbacks = this.callbacks.splice(0);
    let settled = false;
    const settle = (outcome: "parsed" | "discarded") => {
      if (settled) return;
      settled = true;
      for (const callback of callbacks) {
        if (callback.settled) continue;
        callback.settled = true;
        if (outcome === "parsed") callback.onParsed?.();
        else callback.onDiscard?.();
      }
    };
    return {
      onParsed: () => settle("parsed"),
      onDiscard: () => settle("discarded"),
    };
  }

  discard(): void {
    const callbacks = this.callbacks.splice(0);
    for (const callback of callbacks) {
      if (callback.settled) continue;
      callback.settled = true;
      callback.onDiscard?.();
    }
  }

  /**
   * Capture only the currently pending logical ranges for an immediate prefix
   * emission. Calling the returned closure removes/discards that snapshot;
   * success leaves it queued until the stabilizer releases its held tail.
   */
  snapshotDiscard(): (() => void) | undefined {
    const callbacks = this.callbacks.filter(({ settled }) => !settled);
    if (callbacks.length === 0) return undefined;
    let invoked = false;
    return () => {
      if (invoked) return;
      invoked = true;
      const captured = new Set(callbacks);
      this.callbacks = this.callbacks.filter((callback) => !captured.has(callback));
      for (const callback of callbacks) {
        if (callback.settled) continue;
        callback.settled = true;
        callback.onDiscard?.();
      }
    };
  }
}
