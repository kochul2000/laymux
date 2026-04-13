/**
 * Shadow-cursor diagnostic tracing.
 *
 * Default sink is `console` only. Optionally — when the UI *and* Rust
 * gates are both on — events are also **batched** once per
 * `requestAnimationFrame` and shipped to the Rust side via a single
 * `invoke` call, where they interleave with the PTY trace in the same
 * `tracing` stream. The batching is what keeps the observer effect
 * bounded: we pay at most one IPC hop per frame regardless of how
 * many shadow-cursor events fire in that frame.
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

import { invoke } from "@tauri-apps/api/core";

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

type BatchedEvent = { timestamp: string; event: string; payload?: string };
const pendingBatches = new Map<string, BatchedEvent[]>();
let batchFlushScheduled = false;

function scheduleBatchFlush(): void {
  if (batchFlushScheduled) return;
  batchFlushScheduled = true;
  const run = () => {
    batchFlushScheduled = false;
    if (pendingBatches.size === 0) return;
    const snapshot = Array.from(pendingBatches.entries());
    pendingBatches.clear();
    for (const [terminalId, events] of snapshot) {
      if (events.length === 0) continue;
      void invoke("log_terminal_trace_batch", { terminalId, events }).catch(() => {
        // Swallow: diagnostic path must never propagate errors to callers.
      });
    }
  };
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(run);
  } else {
    setTimeout(run, 0);
  }
}

export function createCursorTracer(
  instanceId: string,
  deps: CursorTraceDeps = {},
): (event: string, payload?: Record<string, unknown>) => void {
  const logger = deps.logger ?? console;
  const now = deps.now ?? (() => new Date().toISOString());
  return (event, payload) => {
    if (!isCursorTraceEnabled(deps)) return;
    const ts = now();
    logger.log(`[cursor-trace][${ts}][${instanceId}] ${event}`, payload ?? {});
    // Skip the IPC path in unit tests (indicated by the caller passing a
    // custom logger). In production it is also opt-in via the UI gate.
    if (!deps.logger) {
      const queue = pendingBatches.get(instanceId) ?? [];
      queue.push({
        timestamp: ts,
        event,
        payload: payload ? JSON.stringify(payload) : undefined,
      });
      pendingBatches.set(instanceId, queue);
      scheduleBatchFlush();
    }
  };
}
