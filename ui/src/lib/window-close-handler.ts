export interface CloseHandlerDeps {
  destroy: () => Promise<void>;
  close: () => Promise<void>;
  saveBeforeClose: () => Promise<void>;
  timeoutMs: number;
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

  return async (event: { preventDefault: () => void }) => {
    if (forceClose) {
      // Re-entrant call from fallback close() — let Tauri close naturally
      return;
    }

    event.preventDefault();

    try {
      await Promise.race([
        deps.saveBeforeClose().then(() => "saved" as const),
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), deps.timeoutMs),
        ),
      ]);
    } catch {
      // Save failure is non-fatal — proceed to close
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
