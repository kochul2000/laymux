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
 * Applied when a DEC 2026 (synchronized output) *reset* sequence fires
 * — i.e. an app just flushed a frame. Inside a TUI that uses DEC 2026
 * (Codex), the buffer cursor at this instant is the app's intended
 * input-cursor position, so we snapshot it as the authoritative shadow
 * cursor until the next frame. Outside that activity we return the
 * state unchanged and let the caller fall back to the OSC-133 sync
 * pathway.
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
  return {
    ...state,
    hasPromptBoundary: false,
    isInputPhase: false,
    isRepaintInProgress: false,
    cursorX: bufferCursorX,
    cursorAbsY: bufferCursorAbsY,
    hasSyncFramePosition: true,
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
  return { ...state, hasSyncFramePosition: false };
}
