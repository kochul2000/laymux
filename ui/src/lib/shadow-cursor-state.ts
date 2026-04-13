/**
 * Pure state transitions for the shadow-cursor overlay used by
 * `TerminalView.tsx`. Extracted so the transitions can be unit-tested
 * without spinning up xterm.js. Keep the implementation side-effect
 * free — all ambient coupling (ref mutation, scheduling overlay paint,
 * etc.) lives in the component.
 *
 * Related research docs (see `docs/terminal/`):
 * - fix-flicker.md
 * - xterm-shadow-cursor-architecture.md
 * - xterm-cursor-repaint-analysis.md
 */

import type { TerminalActivityInfo } from "@/stores/terminal-store";

export interface ShadowCursorState {
  commandStartLine: number;
  commandStartX: number;
  cursorX: number;
  cursorAbsY: number;
  /**
   * Cursor position captured the instant a DEC 2026 (synchronized
   * output) frame opened. Codex footer-update frames do not restore
   * the cursor before sending `\e[?2026l`, so reading the buffer at
   * the reset instant lands on the footer row. The pre-frame snapshot
   * is the cursor as Codex actually intends it to look to the user
   * (i.e. the input-prompt position right before the frame began).
   *
   * `undefined` when no DEC 2026 frame is currently open.
   *
   * See `docs/terminal/cursor-jump-evidence/` for the captured trace
   * that motivated this field.
   */
  frameSavedCursorX?: number;
  frameSavedCursorAbsY?: number;
  hasPromptBoundary: boolean;
  hasSyncFramePosition: boolean;
  isComposing: boolean;
  isInputPhase: boolean;
  isRepaintInProgress: boolean;
  isAltBufferActive: boolean;
}

/**
 * Activities for which the UI replaces the native xterm cursor with an
 * overlay caret. Exported from here (and re-used in `TerminalView.tsx`)
 * so the same predicate governs both the live overlay gate and the
 * state transitions below.
 *
 * Claude Code is deliberately *not* in this set: it positions the
 * native cursor correctly at the end of every DEC 2026 frame, and an
 * overlay on top of that only causes double-caret artefacts. Codex,
 * by contrast, leaves the native cursor parked at footer repaint
 * positions — those are the cases the overlay exists for.
 */
export function isOverlayCaretActivity(
  activity: TerminalActivityInfo | undefined,
): boolean {
  return activity?.type === "interactiveApp" && activity.name === "Codex";
}

/**
 * Should the overlay read its coordinates from the shadow cursor, or
 * fall back to `buffer.active.cursorX/Y`? True means "use shadow" —
 * i.e. the shadow cursor holds a snapshot we trust more than whatever
 * the live buffer cursor is pointing at right now (which, during a
 * TUI footer repaint, is often the bottom of the screen).
 */
export function computeUseShadowCursor(state: ShadowCursorState): boolean {
  return (
    (state.hasPromptBoundary && (state.isInputPhase || state.isComposing)) ||
    state.hasSyncFramePosition
  );
}

/**
 * Applied when a DEC 2026 (synchronized output) *set* sequence fires
 * — i.e. an app is about to start a new frame. Inside a TUI overlay
 * activity we snapshot the current buffer cursor; the matching reset
 * will read this snapshot back. See `applyDec2026ResetToShadowCursor`
 * for the rationale (Codex's footer frames don't restore the cursor
 * before the matching `\e[?2026l`).
 *
 * No-op outside an overlay-caret activity.
 */
export function applyDec2026SetToShadowCursor(
  state: ShadowCursorState,
  activity: TerminalActivityInfo | undefined,
  bufferCursorX: number,
  bufferCursorAbsY: number,
): ShadowCursorState {
  if (!isOverlayCaretActivity(activity)) return state;
  return {
    ...state,
    frameSavedCursorX: bufferCursorX,
    frameSavedCursorAbsY: bufferCursorAbsY,
  };
}

/**
 * Applied when a DEC 2026 (synchronized output) *reset* sequence fires
 * — i.e. an app just flushed a frame. We use the cursor snapshot taken
 * at the matching `applyDec2026SetToShadowCursor` if one is available,
 * because Codex's footer-update frames leave the buffer cursor on the
 * footer row at reset time (not on the input row). When no snapshot
 * exists — orphan reset, set lost to a chunk boundary, etc. — we fall
 * back to the live buffer cursor, which is still the best estimate.
 * Outside an overlay-caret activity we return the state unchanged and
 * let the caller schedule the regular OSC 133 sync.
 *
 * Critically, this clears any lingering OSC-133 flags (`hasPromptBoundary`,
 * `isInputPhase`, `isRepaintInProgress`) — those are semantics of a
 * shell session and are stale the moment we enter a TUI. Leaving them
 * set caused the overlay to fall through to the live buffer cursor
 * (and jump to the footer) on every repaint.
 */
export function applyDec2026ResetToShadowCursor(
  state: ShadowCursorState,
  activity: TerminalActivityInfo | undefined,
  bufferCursorX: number,
  bufferCursorAbsY: number,
): ShadowCursorState {
  if (!isOverlayCaretActivity(activity)) return state;
  const cursorX = state.frameSavedCursorX ?? bufferCursorX;
  const cursorAbsY = state.frameSavedCursorAbsY ?? bufferCursorAbsY;
  return {
    ...state,
    hasPromptBoundary: false,
    isInputPhase: false,
    isRepaintInProgress: false,
    cursorX,
    cursorAbsY,
    hasSyncFramePosition: true,
    frameSavedCursorX: undefined,
    frameSavedCursorAbsY: undefined,
  };
}

/**
 * Applied when the terminal's activity transitions away from a
 * TUI-overlay activity (e.g. Codex exits back to the shell). The
 * per-frame `hasSyncFramePosition` snapshot is no longer being refreshed
 * by DEC 2026 resets, so we clear it; from now on the returning shell's
 * OSC 133 prompt boundaries should drive the overlay.
 */
export function applyActivityLeftTuiToShadowCursor(
  state: ShadowCursorState,
): ShadowCursorState {
  return {
    ...state,
    hasSyncFramePosition: false,
    frameSavedCursorX: undefined,
    frameSavedCursorAbsY: undefined,
  };
}
