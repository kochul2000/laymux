/**
 * Identifies keyboard events that are IDE-level shortcuts.
 * Used by TerminalView to let these events pass through xterm.js
 * so they can reach the document-level handler in useKeyboardShortcuts.
 *
 * Design principle: never capture Ctrl+single-key — those belong to the shell.
 * IDE shortcuts use Ctrl+Shift, Ctrl+Alt, or Alt+Arrow.
 */

const CTRL_SHIFT_KEYS = new Set(["U", "B", "I", "u", "b", "i"]);
const CTRL_ALT_KEYS = new Set([
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "N",
  "W",
  "R",
  "D",
  "n",
  "w",
  "r",
  "d",
]);
const ALT_ARROWS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

export function isLxShortcut(e: KeyboardEvent): boolean {
  // Alt+Arrow: pane navigation
  if (e.altKey && !e.ctrlKey && !e.shiftKey && ALT_ARROWS.has(e.key)) {
    return true;
  }

  if (!e.ctrlKey) return false;

  // Ctrl+, (settings) — no shell conflict
  if (!e.shiftKey && !e.altKey && e.key === ",") return true;

  // Ctrl+Shift+key
  if (e.shiftKey && !e.altKey) {
    return CTRL_SHIFT_KEYS.has(e.key);
  }

  // Ctrl+Alt: workspace switch (1~9) + workspace nav (ArrowUp/Down)
  if (e.altKey && !e.shiftKey) {
    return CTRL_ALT_KEYS.has(e.key);
  }

  return false;
}
