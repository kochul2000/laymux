/**
 * Shadow-cursor diagnostic tracing.
 *
 * Purely client-side: we log to `console` only. We deliberately do NOT send
 * trace events to the Rust backend — the overlay update path runs on every
 * animation frame, and pushing a Tauri `invoke` on each would introduce an
 * observer effect that distorts the exact cursor/flicker behaviour we are
 * trying to diagnose.
 *
 * Enable at **build time** with `VITE_LAYMUX_CURSOR_TRACE=1` (baked into
 * the Vite bundle), or at **runtime** via
 * `localStorage.setItem(CURSOR_TRACE_STORAGE_KEY, "1")` (no rebuild
 * needed — just refresh the webview).
 *
 * Note: the matching Rust PTY trace (`LAYMUX_PTY_TRACE=1`) is a separate,
 * process-level env var. To correlate both sides in one debugging session
 * you must enable each independently; there is no unified flag.
 *
 * Related docs:
 * - docs/terminal/fix-flicker.md
 * - docs/terminal/xterm-shadow-cursor-architecture.md
 * - docs/terminal/xterm-cursor-repaint-analysis.md
 */

export const CURSOR_TRACE_STORAGE_KEY = "laymux:cursor-trace";

/**
 * Truthy-flag predicate used by every cursor-trace gate (build-time env,
 * runtime localStorage). Matches the Rust `env_flag_enabled` ruleset so
 * the two sides accept the same set of values — `1`, `true`, `TRUE`,
 * `yes`, `YES`. Anything else (including `0`, `false`, `""`, `null`) is
 * treated as disabled.
 */
export function isTruthyFlag(value: string | null | undefined): boolean {
  if (value == null) return false;
  switch (value) {
    case "1":
    case "true":
    case "TRUE":
    case "yes":
    case "YES":
      return true;
    default:
      return false;
  }
}

const BUILD_TIME_ENABLED = isTruthyFlag(
  import.meta.env.VITE_LAYMUX_CURSOR_TRACE as string | undefined,
);

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
  return isTruthyFlag(readStorage(storage));
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
