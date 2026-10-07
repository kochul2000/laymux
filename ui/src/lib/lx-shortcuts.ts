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

import { isShellOwnedCombo } from "./keybinding-core";
import { DEFAULT_KEYBINDINGS, matchesKeybinding } from "./keybinding-registry";
import { useDockStore } from "@/stores/dock-store";
import { useGridStore } from "@/stores/grid-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

/**
 * Actions dispatched by the document-level handler (useKeyboardShortcuts).
 * These must pass through xterm.js while a terminal is focused.
 *
 * Membership is declared per-definition via `passThroughTerminal` in the
 * registry — see the field's doc in `keybinding-registry.ts` for why an
 * action is or isn't flagged. Deriving the list here (instead of keeping a
 * parallel group/exception list) means a new document-level shortcut can't
 * be registered without also deciding its pass-through behavior.
 */
const PASS_THROUGH_ACTION_IDS: readonly string[] = DEFAULT_KEYBINDINGS.filter(
  (d) => d.passThroughTerminal === true,
).map((d) => d.id);

/**
 * Actions whose default combo is a bare key the terminal owns (`pane.delete`
 * = plain Delete): only a rebound combo that includes a modifier passes
 * through; a modifier-less binding stays with the terminal (PR #338 review).
 */
const PASS_THROUGH_WHEN_MODIFIED_ACTION_IDS: readonly string[] = DEFAULT_KEYBINDINGS.filter(
  (d) => d.passThroughTerminal === "whenModified",
).map((d) => d.id);

/** Stack-only actions (`pane.layer`): they pass through only while the focused slot is a stack. */
const PASS_THROUGH_WHEN_STACKED_ACTION_IDS: readonly string[] = DEFAULT_KEYBINDINGS.filter(
  (d) => d.passThroughTerminal === "whenStacked",
).map((d) => d.id);

/** True when grid focus is on a slot holding two or more layers (ADR-0297). */
function focusedSlotIsStacked(): boolean {
  if (useDockStore.getState().focusedDock !== null) return false;
  const index = useGridStore.getState().focusedPaneIndex;
  if (index === null) return false;
  const slot = useWorkspaceStore.getState().getActiveWorkspace()?.panes[index];
  return (slot?.layers.length ?? 0) > 1;
}

/** Terminal-owned actions: their (possibly overridden) combos never pass through. */
const TERMINAL_OWNED_ACTION_IDS: readonly string[] = DEFAULT_KEYBINDINGS.filter(
  (d) => d.group === "Terminal",
).map((d) => d.id);

export function isLxShortcut(e: KeyboardEvent): boolean {
  if (isShellOwnedCombo(e)) return false;
  if (TERMINAL_OWNED_ACTION_IDS.some((id) => matchesKeybinding(e, id))) return false;
  if (PASS_THROUGH_ACTION_IDS.some((id) => matchesKeybinding(e, id))) return true;
  if (
    PASS_THROUGH_WHEN_STACKED_ACTION_IDS.some((id) => matchesKeybinding(e, id)) &&
    focusedSlotIsStacked()
  ) {
    return true;
  }
  return (
    (e.ctrlKey || e.altKey || e.shiftKey) &&
    PASS_THROUGH_WHEN_MODIFIED_ACTION_IDS.some((id) => matchesKeybinding(e, id))
  );
}
