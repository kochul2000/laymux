/**
 * Shadow-cursor diagnostic tracing.
 *
 * Purely client-side: we log to `console` only. We deliberately do NOT send
 * trace events to the Rust backend — the overlay update path runs on every
 * animation frame, and pushing a Tauri `invoke` on each would introduce an
 * observer effect that distorts the exact cursor/flicker behaviour we are
 * trying to diagnose.
 *
 * Enable at build time with `VITE_LAYMUX_CURSOR_TRACE=1`, or at runtime via
 * `localStorage.setItem(CURSOR_TRACE_STORAGE_KEY, "1")`.
 *
 * Related docs:
 * - docs/terminal/fix-flicker.md
 * - docs/terminal/xterm-shadow-cursor-architecture.md
 * - docs/terminal/xterm-cursor-repaint-analysis.md
 */

export const CURSOR_TRACE_STORAGE_KEY = "laymux:cursor-trace";

const BUILD_TIME_ENABLED =
  import.meta.env.VITE_LAYMUX_CURSOR_TRACE === "1" ||
  import.meta.env.VITE_LAYMUX_CURSOR_TRACE === "true";

type StorageLike = Pick<Storage, "getItem">;

interface CursorTraceDeps {
  storage?: StorageLike | null;
  logger?: Pick<Console, "log">;
  now?: () => string;
}

function readStorage(storage: StorageLike | null | undefined): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(CURSOR_TRACE_STORAGE_KEY);
  } catch {
    // `localStorage` access can throw in privacy modes; treat as disabled.
    return null;
  }
}

export function isCursorTraceEnabled(deps: CursorTraceDeps = {}): boolean {
  if (BUILD_TIME_ENABLED) return true;
  const storage =
    deps.storage ??
    (typeof window === "undefined" ? null : window.localStorage);
  return readStorage(storage) === "1";
}

export function createCursorTracer(
  instanceId: string,
  deps: CursorTraceDeps = {},
): (event: string, payload?: Record<string, unknown>) => void {
  const logger = deps.logger ?? console;
  const now = deps.now ?? (() => new Date().toISOString());
  return (event, payload) => {
    if (!isCursorTraceEnabled(deps)) return;
    logger.log(`[cursor-trace][${now()}][${instanceId}] ${event}`, payload ?? {});
  };
}
