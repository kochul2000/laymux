/**
 * Identifies keyboard events that are IDE-level shortcuts.
 * Used by TerminalView to let these events pass through xterm.js
 * so they can reach the document-level handler in useKeyboardShortcuts.
 *
 * The pass-through decision consults the keybinding registry — user
 * overrides included — instead of a hardcoded key list (#332/#333):
 * rebinding an action automatically moves its pass-through combo, and the
 * old default combo is no longer swallowed by the terminal.
 *
 * Design principles preserved:
 * - Never capture Ctrl+single letter/digit — those belong to the shell
 *   (e.g. Ctrl+C → SIGINT), even if a user binds an IDE action there.
 * - Terminal-scoped bindings (terminal.copy/paste/zoom*) are handled inside
 *   TerminalView's own key handler and never pass through, so they win when
 *   a user override collides with a document-level shortcut.
 */

import { DEFAULT_KEYBINDINGS, matchesKeybinding } from "./keybinding-registry";

/**
 * Actions dispatched by the document-level handler (useKeyboardShortcuts).
 * These must pass through xterm.js while a terminal is focused.
 *
 * Selected by group: Workspace + UI are document-level, plus `pane.focus`
 * (Alt+Arrow navigation). Intentionally excluded:
 * - Terminal / Memo groups — handled inside the focused view itself.
 * - `pane.delete` (plain Delete) — the terminal must keep receiving Delete.
 * - Issue Reporter — modal-local scope, never active while a terminal is focused.
 */
const PASS_THROUGH_GROUPS = new Set(["Workspace", "UI"]);
const PASS_THROUGH_EXTRA_IDS = new Set(["pane.focus"]);
const PASS_THROUGH_ACTION_IDS: readonly string[] = DEFAULT_KEYBINDINGS.filter(
  (d) => PASS_THROUGH_GROUPS.has(d.group) || PASS_THROUGH_EXTRA_IDS.has(d.id),
).map((d) => d.id);

/** Terminal-owned actions: their (possibly overridden) combos never pass through. */
const TERMINAL_OWNED_ACTION_IDS: readonly string[] = DEFAULT_KEYBINDINGS.filter(
  (d) => d.group === "Terminal",
).map((d) => d.id);

/** Ctrl+single letter/digit (no Alt/Shift) is shell territory — never pass through. */
function isShellOwnedCombo(e: KeyboardEvent): boolean {
  return e.ctrlKey && !e.altKey && !e.shiftKey && /^[a-zA-Z0-9]$/.test(e.key);
}

export function isLxShortcut(e: KeyboardEvent): boolean {
  if (isShellOwnedCombo(e)) return false;
  if (TERMINAL_OWNED_ACTION_IDS.some((id) => matchesKeybinding(e, id))) return false;
  return PASS_THROUGH_ACTION_IDS.some((id) => matchesKeybinding(e, id));
}
