interface DeferredParsedCallback {
  onParsed: () => void;
  onDiscard?: () => void;
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

  drain(): (() => void) | undefined {
    if (this.callbacks.length === 0) return undefined;
    const callbacks = this.callbacks.splice(0);
    return () => callbacks.forEach((callback) => callback.onParsed());
  }

  discard(): void {
    const callbacks = this.callbacks.splice(0);
    for (const callback of callbacks) callback.onDiscard?.();
  }
}
