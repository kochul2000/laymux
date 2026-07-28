interface DeferredParsedCallback {
  onParsed: () => void;
  onDiscard?: () => void;
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

  push(onParsed: () => void, onDiscard?: () => void): void {
    this.callbacks.push({ onParsed, onDiscard });
  }

  drain(): DrainedParsedCallbacks | undefined {
    if (this.callbacks.length === 0) return undefined;
    const callbacks = this.callbacks.splice(0);
    let settled = false;
    const settle = (outcome: "parsed" | "discarded") => {
      if (settled) return;
      settled = true;
      for (const callback of callbacks) {
        if (outcome === "parsed") callback.onParsed();
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
    for (const callback of callbacks) callback.onDiscard?.();
  }
}
