export type TerminalOutputReconnectState = "idle" | "reconnecting" | "failed";

const controllers = new Map<string, TerminalOutputReconnect>();

export function registerTerminalOutputReconnect(
  id: string,
  controller: TerminalOutputReconnect,
): () => void {
  controllers.set(id, controller);
  return () => {
    if (controllers.get(id) === controller) controllers.delete(id);
  };
}

/** Automation starts the button's bounded action without blocking its bridge. */
export function requestTerminalOutputReconnect(id: string): boolean {
  const controller = controllers.get(id);
  if (!controller) return false;
  void controller.retry();
  return true;
}

/** One automatic attempt per pane visit; manual retries share the active attempt. */
export class TerminalOutputReconnect {
  private visible = false;
  private attempted = false;
  private disposed = false;
  private pending: Promise<void> | undefined;

  constructor(
    private readonly reconnect: () => Promise<void>,
    private readonly changed: (state: TerminalOutputReconnectState, error?: string) => void,
  ) {}

  enter(): void {
    if (!this.visible) this.attempted = false;
    this.visible = true;
  }

  leave(): void {
    this.visible = false;
  }

  failed(): Promise<void> {
    if (this.disposed || !this.visible || this.attempted) return Promise.resolve();
    this.attempted = true;
    return this.retry();
  }

  retry(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.pending) return this.pending;
    this.attempted = true;
    this.changed("reconnecting");
    // Install ownership before running user code, including synchronous failures.
    this.pending = Promise.resolve()
      .then(this.reconnect)
      .then(
        () => {
          if (!this.disposed) this.changed("idle");
        },
        (error: unknown) => {
          if (!this.disposed) this.changed("failed", String(error));
        },
      )
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  dispose(): void {
    this.disposed = true;
  }
}
