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
  /**
   * DECTCEM (`\e[?25l/h`) visibility as the app last requested it.
   * While hidden, the overlay caret must not be drawn — the app is
   * mid-repaint (transient, within one chunk) or deliberately hiding
   * the cursor (sustained, e.g. while streaming).
   */
  isCursorHidden: boolean;
  /**
   * True between a DEC 2026 frame flush and the cursor "park" that
   * Codex sends shortly after (`\e[?25l` + CUP + `\e[?25h` outside any
   * sync frame). While pending, the overlay keeps its previous painted
   * position: the at-reset shadow position is only a fallback estimate
   * and repainting with it is what produced visible footer jumps. The
   * park (authoritative) or a settle timeout (fallback) clears this.
   *
   * See `docs/terminal/cursor-jump-evidence/` — the captured trace
   * shows the park chunk arriving ~15 ms after the frame flush.
   */
  parkPending: boolean;
  /**
   * Byte-stream DEC 2026 frame state, driven only by parser set/reset
   * handlers. This must stay independent from xterm.js
   * `synchronizedOutputMode`, which may be cleared by xterm's safety
   * timeout while the application frame is still open.
   */
  isDec2026FrameOpen: boolean;
  hasPromptBoundary: boolean;
  hasSyncFramePosition: boolean;
  isInputPhase: boolean;
  isRepaintInProgress: boolean;
  isAltBufferActive: boolean;
}

export type ShadowSyncEligibility =
  | "eligible"
  | "composition-preview-active"
  | "dec-2026-frame-open"
  | "inactive"
  | "row-mismatch"
  | "repaint-in-progress"
  | "alt-buffer"
  | "sync-output-active";

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
export function isOverlayCaretActivity(activity: TerminalActivityInfo | undefined): boolean {
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
  return (state.hasPromptBoundary && state.isInputPhase) || state.hasSyncFramePosition;
}

export function getShadowSyncEligibility(
  state: Pick<
    ShadowCursorState,
    | "cursorAbsY"
    | "hasPromptBoundary"
    | "isInputPhase"
    | "hasSyncFramePosition"
    | "isRepaintInProgress"
    | "isAltBufferActive"
    | "isDec2026FrameOpen"
  >,
  options: {
    bufferAbsY?: number;
    compositionPreviewActive: boolean;
    syncOutputActive: boolean;
  },
): ShadowSyncEligibility {
  if (options.compositionPreviewActive) return "composition-preview-active";
  if (state.isDec2026FrameOpen) return "dec-2026-frame-open";
  // Shadow cursor has never been initialized by any source (no OSC 133 prompt
  // marker, no DEC 2026 sync frame).  This happens for freshly opened terminals
  // (e.g. from empty view) or shells that don't emit OSC 133 (PowerShell).
  // Allow sync so the shadow cursor gets seeded from the buffer cursor.
  if (!state.hasPromptBoundary && !state.hasSyncFramePosition) return "eligible";
  if (!(state.isInputPhase || state.hasSyncFramePosition)) return "inactive";
  if (
    state.hasSyncFramePosition &&
    !state.isInputPhase &&
    options.bufferAbsY !== undefined &&
    options.bufferAbsY !== state.cursorAbsY
  ) {
    return "row-mismatch";
  }
  if (state.isRepaintInProgress) return "repaint-in-progress";
  if (state.isAltBufferActive) return "alt-buffer";
  if (options.syncOutputActive) return "sync-output-active";
  return "eligible";
}

/**
 * Applied when a DEC 2026 (synchronized output) *set* sequence fires
 * — i.e. an app is about to start a new frame. Inside a TUI overlay
 * activity we also snapshot the current buffer cursor; the matching
 * reset will read this snapshot back. The parser frame itself is
 * activity-independent because activity classification can arrive
 * after the opening sequence. See `applyDec2026ResetToShadowCursor`
 * for the rationale (Codex's footer frames don't restore the cursor
 * before the matching `\e[?2026l`).
 *
 * Outside an overlay-caret activity only the parser frame is opened.
 */
export function applyDec2026SetToShadowCursor(
  state: ShadowCursorState,
  activity: TerminalActivityInfo | undefined,
  bufferCursorX: number,
  bufferCursorAbsY: number,
): ShadowCursorState {
  // A second `?2026h` while the frame is still open (nested or
  // unbalanced set — e.g. the previous frame's `?2026l` was lost) must
  // not overwrite the pre-frame snapshot: the buffer cursor is now
  // mid-frame (footer row), and committing that snapshot at reset time
  // would reintroduce the footer jump through the fallback path.
  if (state.isDec2026FrameOpen) return state;
  if (!isOverlayCaretActivity(activity)) {
    return { ...state, isDec2026FrameOpen: true };
  }
  const cursorX = state.hasSyncFramePosition ? state.cursorX : bufferCursorX;
  const cursorAbsY = state.hasSyncFramePosition ? state.cursorAbsY : bufferCursorAbsY;
  return {
    ...state,
    cursorX,
    cursorAbsY,
    frameSavedCursorX: bufferCursorX,
    frameSavedCursorAbsY: bufferCursorAbsY,
    hasSyncFramePosition: true,
    isDec2026FrameOpen: true,
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
 * Outside an overlay-caret activity only the parser frame is closed and
 * the caller schedules the regular OSC 133 sync.
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
  if (!isOverlayCaretActivity(activity)) {
    if (!state.isDec2026FrameOpen) return state;
    return { ...state, isDec2026FrameOpen: false };
  }
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
    isDec2026FrameOpen: false,
    // The at-reset position above is a fallback estimate. Codex parks
    // the real input cursor in a follow-up chunk (`?25l` CUP `?25h`
    // outside the frame) — hold overlay repaints until that park or a
    // settle timeout. See `applyDectcemShowToShadowCursor`.
    parkPending: true,
  };
}

/**
 * Applied when DECTCEM hide (`\e[?25l`) fires inside an overlay-caret
 * activity. Marks the cursor as app-hidden; the overlay mirrors this.
 * Transient hide/show pairs inside a single chunk never reach paint
 * (overlay updates are rAF-coalesced), so only sustained hides — the
 * ones the app actually wants the user to see — take effect visually.
 */
export function applyDectcemHideToShadowCursor(
  state: ShadowCursorState,
  activity: TerminalActivityInfo | undefined,
): ShadowCursorState {
  if (!isOverlayCaretActivity(activity)) return state;
  if (state.isCursorHidden) return state;
  return { ...state, isCursorHidden: true };
}

/**
 * Applied when DECTCEM show (`\e[?25h`) fires inside an overlay-caret
 * activity. Three very different meanings depending on buffer/frame
 * state:
 *
 * - **Inside a sync frame** (`isDec2026FrameOpen`): the show is the tail
 *   of a repaint — Codex's footer frames end `?25h` with the buffer
 *   cursor still parked on the footer row. The position is untrusted;
 *   only the visibility flag is cleared.
 * - **Inside the alternate buffer** (`isAltBufferActive`): the show
 *   belongs to a full-screen app whose coordinates are meaningless in
 *   the normal buffer. Visibility only — never a park.
 * - **Outside any sync frame, normal buffer**: this is Codex's cursor
 *   *park* — a deliberate hide–move–show that declares "the visible
 *   cursor goes here". The captured trace
 *   (`docs/terminal/cursor-jump-evidence/`) shows `?25l` CUP `?25h`
 *   arriving as its own chunk ~15 ms after each footer frame. This is
 *   the single most authoritative cursor signal Codex emits, so it
 *   overwrites the shadow position unconditionally (no row-equality
 *   gate) and clears `parkPending`.
 *
 * Like `applyDec2026ResetToShadowCursor`, the park clears stale OSC 133
 * shell flags so a Codex-after-shell session can't fall through to the
 * live buffer cursor.
 */
/**
 * Is a DECTCEM show (`\e[?25h`) in this state an authoritative cursor
 * *park*, as opposed to a visibility-only event? Single source for the
 * decision — `applyDectcemShowToShadowCursor` uses it to pick the
 * transition, and `TerminalView.tsx` uses it to gate the park-side
 * effects (settle-timer clear, `dectcem-park` trace).
 *
 * Not a park when:
 * - **inside a sync frame** — the show is a repaint tail; Codex's
 *   footer frames end `?25h` with the cursor still on the footer row;
 * - **inside the alternate buffer** — the show belongs to a
 *   full-screen app (editor, pager) whose coordinates mean nothing to
 *   the normal-buffer shadow cursor. Storing an alt-buffer position as
 *   a park would leave `hasSyncFramePosition` pointing at garbage
 *   after `?1049l`, and the row-mismatch sync gate would then pin the
 *   overlay there until the next park.
 */
export function isDectcemShowPark(
  state: Pick<ShadowCursorState, "isAltBufferActive" | "isDec2026FrameOpen">,
): boolean {
  return !state.isDec2026FrameOpen && !state.isAltBufferActive;
}

export function applyDectcemShowToShadowCursor(
  state: ShadowCursorState,
  activity: TerminalActivityInfo | undefined,
  bufferCursorX: number,
  bufferCursorAbsY: number,
): ShadowCursorState {
  if (!isOverlayCaretActivity(activity)) return state;
  // Visibility-only show — see `isDectcemShowPark` for the two cases.
  if (!isDectcemShowPark(state)) {
    if (!state.isCursorHidden) return state;
    return { ...state, isCursorHidden: false };
  }
  return {
    ...state,
    isCursorHidden: false,
    cursorX: bufferCursorX,
    cursorAbsY: bufferCursorAbsY,
    hasSyncFramePosition: true,
    hasPromptBoundary: false,
    isInputPhase: false,
    isRepaintInProgress: false,
    parkPending: false,
    frameSavedCursorX: undefined,
    frameSavedCursorAbsY: undefined,
  };
}

/**
 * Should the overlay repaint be held at its previous painted position
 * while a post-frame cursor park is pending? (See `parkPending` on
 * `ShadowCursorState` for the rationale.)
 *
 * Two states take precedence over the freeze:
 *
 * - **Composition preview** — the IME caret must track the preview
 *   text immediately; holding it at a stale position breaks visual
 *   feedback mid-composition.
 * - **Sustained DECTCEM hide** — when a DEC 2026 frame ends with the
 *   cursor hidden (`?25l` … `?2026l` with no matching show), the app
 *   wants no visible cursor at all. Freezing would keep the previously
 *   *visible* overlay on screen for up to the settle window,
 *   contradicting the app's explicit hide. The hidden state must reach
 *   paint (and hide the overlay) without waiting for the park.
 *
 * `isAltBufferActive` is deliberately NOT an input: alt-buffer entry
 * is handled by the CSI `?1049h` parser hook, which *synchronously*
 * clears `parkPending` (and the settle timer) before any paint can
 * run — so by the time this predicate is consulted, an alt-buffer
 * state never has a pending park to freeze on. If that invariant is
 * ever relaxed (e.g. alt entry stops clearing `parkPending`), this
 * function must learn the alt-buffer dimension too.
 */
export function shouldFreezeOverlayForPark(
  state: Pick<ShadowCursorState, "parkPending" | "isCursorHidden">,
  compositionPreviewActive: boolean,
): boolean {
  if (compositionPreviewActive) return false;
  if (state.isCursorHidden) return false;
  return state.parkPending;
}

/**
 * Applied when the post-frame settle window expires without a cursor
 * park arriving. The at-reset fallback position (already in
 * `cursorX/AbsY`) becomes the best available estimate, so overlay
 * repaints resume. Worst case the caret moves ~one settle window late
 * instead of jumping to the footer and back.
 */
export function applyParkSettleTimeoutToShadowCursor(state: ShadowCursorState): ShadowCursorState {
  if (!state.parkPending) return state;
  return { ...state, parkPending: false };
}

/**
 * Applied when the terminal's activity transitions away from a
 * TUI-overlay activity (e.g. Codex exits back to the shell). The
 * per-frame `hasSyncFramePosition` snapshot is no longer being refreshed
 * by DEC 2026 resets, so we clear it; from now on the returning shell's
 * OSC 133 prompt boundaries should drive the overlay.
 */
export function applyActivityLeftTuiToShadowCursor(state: ShadowCursorState): ShadowCursorState {
  return {
    ...state,
    hasSyncFramePosition: false,
    frameSavedCursorX: undefined,
    frameSavedCursorAbsY: undefined,
    parkPending: false,
    isCursorHidden: false,
  };
}
