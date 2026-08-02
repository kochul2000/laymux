/**
 * Ctrl+C constants shared by every path that interrupts a terminal.
 *
 * Deliberately a leaf module with no imports. Both consumers —
 * `interrupt-terminals-on-exit` (kill-on-exit, issue #451) and
 * `workspace-clear` (ADR-0113) — are reachable from `settings-store`, so
 * hanging these values off either one puts a cycle through the store.
 */

/** ETX — the byte a terminal sends when the user presses Ctrl+C. */
export const CTRL_C = "\x03";

/**
 * Fixed spacing between consecutive Ctrl+C presses. Agents need a beat between
 * the "interrupt" press and the "confirm exit" press; not worth a setting.
 */
export const INTERRUPT_ROUND_INTERVAL_MS = 120;
