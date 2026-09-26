export interface CloseHandlerDeps {
  destroy: () => Promise<void>;
  close: () => Promise<void>;
  saveBeforeClose: () => Promise<void>;
  /**
   * Max time to wait for `saveBeforeClose` before forcing the window closed.
   * A function is evaluated at close time so it can reflect current settings
   * (e.g. a longer kill-on-exit settle delay). See issue #451.
   */
  timeoutMs: number | (() => number);
  beforeClose?: () => Promise<boolean>;
  onSaveProblem?: (error: string, pending: Promise<void>) => Promise<void>;
}

/**
 * Creates a close-requested event handler that:
 * 1. Prevents default close
 * 2. Saves state (with timeout)
 * 3. Calls destroy() to close window
 * 4. Falls back to close() if destroy() fails (e.g., missing permission)
 *
 * On re-entrant call (after fallback close triggers another close-requested),
 * skips preventDefault so Tauri closes the window normally.
 */
export function createCloseHandler(deps: CloseHandlerDeps) {
  let forceClose = false;
  let running = false;

  return async (event: { preventDefault: () => void }) => {
    if (forceClose) {
      // Re-entrant call from fallback close() — let Tauri close naturally
      return;
    }

    event.preventDefault();
    if (running) return;
    running = true;
    if (deps.beforeClose && !(await deps.beforeClose().catch(() => false))) {
      running = false;
      return;
    }

    const timeoutMs = typeof deps.timeoutMs === "function" ? deps.timeoutMs() : deps.timeoutMs;

    const pending = deps.saveBeforeClose();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        pending.then(() => "saved" as const),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), timeoutMs);
        }),
      ]);
      if (outcome === "timeout") await deps.onSaveProblem?.("timeout", pending);
    } catch (error) {
      await deps.onSaveProblem?.(String(error), pending);
    } finally {
      clearTimeout(timer);
    }

    try {
      await deps.destroy();
    } catch {
      // destroy() failed (e.g., missing allow-destroy permission)
      // Fall back to close(), which triggers another close-requested event.
      // Set forceClose so the re-entrant call skips preventDefault.
      forceClose = true;
      await deps.close();
    }
  };
}
