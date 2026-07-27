/**
 * Deterministic pane ↔ terminal id derivation (ADR-0005).
 *
 * A TerminalView pane's terminal id is always `terminal-<paneId>`, so the
 * handle is derivable from layout state alone — no lookup table, no store read.
 * That only holds while every caller derives it the *same* way, so this module
 * owns both directions instead of each call site re-deriving the format.
 */

/** Deterministic terminal id of a TerminalView pane. */
export function toTerminalId(paneId: string): string {
  return `terminal-${paneId}`;
}

/**
 * Inverse of `toTerminalId`. Strips one leading `terminal-` prefix and returns
 * anything else unchanged, so a value that is already a pane id passes through.
 */
export function toPaneId(terminalId: string): string {
  return terminalId.replace(/^terminal-/, "");
}
