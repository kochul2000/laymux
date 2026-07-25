import { isCompositionSideInput } from "./ime-composition-events";

import { splitCellClusters, stringCellWidth } from "./terminal-unicode-width";

export type CompositionPreviewState = {
  active: boolean;
  text: string;
  caretUtf16Index: number;
  caretCellOffset: number;
  textCellWidth: number;
  anchorBufferX: number;
  anchorBufferAbsY: number;
};

type CompositionControllerOptions = {
  getAnchor: () => { cursorX: number; cursorAbsY: number };
  onStateChange?: (state: CompositionPreviewState) => void;
  onTrace?: (event: string, payload: Record<string, unknown>) => void;
};

type BufferAnchor = {
  cursorX: number;
  cursorAbsY: number;
};

function createEmptyState(): CompositionPreviewState {
  return {
    active: false,
    text: "",
    caretUtf16Index: 0,
    caretCellOffset: 0,
    textCellWidth: 0,
    anchorBufferX: 0,
    anchorBufferAbsY: 0,
  };
}

/**
 * Find the changed (inserted/replaced) range between two strings.
 * Used in normal (non-carry-over) mode to extract only the active
 * composition text from the textarea value.
 */
function getChangedRange(
  before: string,
  after: string,
): {
  startUtf16Index: number;
  endUtf16Index: number;
  text: string;
} {
  let startUtf16Index = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (
    startUtf16Index < maxPrefix &&
    before.charCodeAt(startUtf16Index) === after.charCodeAt(startUtf16Index)
  ) {
    startUtf16Index += 1;
  }

  let beforeEndUtf16Index = before.length;
  let afterEndUtf16Index = after.length;
  while (
    beforeEndUtf16Index > startUtf16Index &&
    afterEndUtf16Index > startUtf16Index &&
    before.charCodeAt(beforeEndUtf16Index - 1) === after.charCodeAt(afterEndUtf16Index - 1)
  ) {
    beforeEndUtf16Index -= 1;
    afterEndUtf16Index -= 1;
  }

  return {
    startUtf16Index,
    endUtf16Index: afterEndUtf16Index,
    text: after.slice(startUtf16Index, afterEndUtf16Index),
  };
}

function traceComposition(
  options: CompositionControllerOptions,
  event: string,
  payload: Record<string, unknown>,
): void {
  options.onTrace?.(event, payload);
}

export type ImeCompositionController = {
  bind(textarea: HTMLTextAreaElement): void;
  dispose(): void;
  getState(): CompositionPreviewState;
};

export function getCompositionPreviewCursor(
  state: Pick<CompositionPreviewState, "anchorBufferX" | "anchorBufferAbsY" | "caretCellOffset">,
  cols: number,
): { cursorX: number; cursorAbsY: number } {
  const compositionAbsCell = state.anchorBufferX + state.caretCellOffset;
  if (cols <= 0) {
    return {
      cursorX: compositionAbsCell,
      cursorAbsY: state.anchorBufferAbsY,
    };
  }
  return {
    cursorX: compositionAbsCell % cols,
    cursorAbsY: state.anchorBufferAbsY + Math.floor(compositionAbsCell / cols),
  };
}

export function getCompositionPreviewLayout(
  state: Pick<
    CompositionPreviewState,
    "text" | "anchorBufferX" | "anchorBufferAbsY" | "caretCellOffset" | "textCellWidth"
  >,
  cols: number,
): {
  cursorX: number;
  cursorAbsY: number;
  rows: Array<{
    text: string;
    startColumn: number;
    rowOffset: number;
    cellWidth: number;
  }>;
} {
  if (cols <= 0 || !state.text) {
    return {
      ...getCompositionPreviewCursor(state, cols),
      rows: state.text
        ? [
            {
              text: state.text,
              startColumn: state.anchorBufferX,
              rowOffset: 0,
              cellWidth: state.textCellWidth,
            },
          ]
        : [],
    };
  }

  // Grapheme clusters, not code points: a ZWJ sequence, variation selector or
  // combining mark must never be cut across a row boundary, and the wrap test
  // below has to see the cluster's final cell width so it agrees with the width
  // xterm's buffer will claim for the same text.
  const clusters = splitCellClusters(state.text);
  const rows: Array<{
    text: string;
    startColumn: number;
    rowOffset: number;
    cellWidth: number;
  }> = [];
  let currentCol = state.anchorBufferX;
  let currentRowOffset = 0;
  let currentRowStartColumn = state.anchorBufferX;
  let currentRowText = "";
  let currentRowWidth = 0;
  let consumedCellWidth = 0;
  let cursorX = state.anchorBufferX;
  let cursorAbsY = state.anchorBufferAbsY;
  let cursorResolved = state.caretCellOffset <= 0;

  const flushRow = () => {
    if (!currentRowText) return;
    rows.push({
      text: currentRowText,
      startColumn: currentRowStartColumn,
      rowOffset: currentRowOffset,
      cellWidth: currentRowWidth,
    });
    currentRowText = "";
    currentRowWidth = 0;
  };

  const resolveCursor = (clusterStartColumn: number, clusterWidth: number) => {
    if (cursorResolved || state.caretCellOffset > consumedCellWidth + clusterWidth) return;

    const cellOffsetInCluster = Math.max(0, state.caretCellOffset - consumedCellWidth);
    const absoluteColumn = clusterStartColumn + cellOffsetInCluster;
    cursorX = absoluteColumn % cols;
    cursorAbsY = state.anchorBufferAbsY + currentRowOffset + Math.floor(absoluteColumn / cols);
    cursorResolved = true;
  };

  for (const { segment, width } of clusters) {
    if (width > 0 && currentCol + width > cols) {
      flushRow();
      currentRowOffset += 1;
      currentCol = 0;
      currentRowStartColumn = 0;
    }

    const clusterStartColumn = currentCol;
    currentRowText += segment;
    resolveCursor(clusterStartColumn, width);
    currentCol += width;
    currentRowWidth += width;
    consumedCellWidth += width;
  }
  flushRow();

  if (!cursorResolved) {
    const fallbackCursor = getCompositionPreviewCursor(state, cols);
    cursorX = fallbackCursor.cursorX;
    cursorAbsY = fallbackCursor.cursorAbsY;
  }

  return {
    cursorX,
    cursorAbsY,
    rows,
  };
}

// ---------------------------------------------------------------------------
// Composition controller
//
// Inspired by Windows Terminal's TSF Implementation._doCompositionUpdate():
// - Clean separation of finalized vs active composition text
// - Deferred finalization (like WT's composition counter reaching 0)
// - Each composition chain is tracked as a unit; carry-over is detected
//   when compositionstart fires before the deferred reset timeout
// ---------------------------------------------------------------------------

export function createImeCompositionController(
  options: CompositionControllerOptions,
): ImeCompositionController {
  let textarea: HTMLTextAreaElement | null = null;
  let state = createEmptyState();

  // Phase tracks the composition lifecycle:
  //   idle → composing → pending-finalize → idle
  //                  ↑         │  (carry-over: compositionstart before timeout)
  //                  └─────────┘
  let phase: "idle" | "composing" | "pending-finalize" = "idle";
  let isCarryOver = false;

  // Where the *current* syllable is painted. Recomputed at every carry-over.
  let compositionAnchor: BufferAnchor = { cursorX: 0, cursorAbsY: 0 };
  // Anchor and textarea value as of the chain's *first* compositionstart. The
  // per-syllable anchor is always `chainAnchor + width(committed since chainBase)`,
  // never a live reading taken mid-chain — see `handleCompositionStart`.
  let chainAnchor: BufferAnchor = { cursorX: 0, cursorAbsY: 0 };
  let chainBaseText = "";
  // Textarea value snapshot at the start of the *current syllable*, so the preview
  // diff yields only the syllable being composed.
  let compositionBaseText = "";
  // Latest compositionupdate event.data — used for Korean split-time display
  let latestCompositionDisplayText = "";

  let pendingAnimationFrame: number | null = null;
  let pendingTimeout: ReturnType<typeof setTimeout> | null = null;
  let pendingFinalizeTimeout: ReturnType<typeof setTimeout> | null = null;

  // Monotonic counter bumped on every keydown/beforeinput/input the textarea
  // sees. The deferred finalize compares it against the value captured at
  // compositionend to decide whether the textarea has been quiet since then
  // (safe to clear residue) or new input already raced in (leave it alone).
  let inputActivitySeq = 0;

  const emit = () => {
    options.onStateChange?.(state);
  };

  const update = (patch: Partial<CompositionPreviewState>) => {
    state = { ...state, ...patch };
    emit();
  };

  const cancelPendingSync = () => {
    if (pendingAnimationFrame !== null) {
      cancelAnimationFrame(pendingAnimationFrame);
      pendingAnimationFrame = null;
    }
    if (pendingTimeout !== null) {
      clearTimeout(pendingTimeout);
      pendingTimeout = null;
    }
  };

  const cancelPendingFinalize = () => {
    if (pendingFinalizeTimeout !== null) {
      clearTimeout(pendingFinalizeTimeout);
      pendingFinalizeTimeout = null;
    }
  };

  const reset = () => {
    cancelPendingSync();
    cancelPendingFinalize();
    phase = "idle";
    isCarryOver = false;
    compositionAnchor = { cursorX: 0, cursorAbsY: 0 };
    chainAnchor = { cursorX: 0, cursorAbsY: 0 };
    chainBaseText = "";
    compositionBaseText = "";
    latestCompositionDisplayText = "";
    state = createEmptyState();
    emit();
  };

  const syncPreview = () => {
    cancelPendingSync();
    if (!textarea || phase !== "composing") return;

    // Always use getChangedRange to extract only the text added since
    // compositionBaseText. Carry-over only preserves the anchor and baseText;
    // the preview text computation is identical for both modes.
    // This mirrors WT's _doCompositionUpdate which always cleanly separates
    // finalized (already echoed by shell) from active composition text.
    const changedRange = getChangedRange(compositionBaseText, textarea.value);
    const rawText = changedRange.text;

    // Korean split-time: compositionupdate may report more text than the diff
    // (e.g., the IME shows the full syllable in progress while the textarea
    // only has a partial jamo sequence)
    const previewText =
      latestCompositionDisplayText &&
      latestCompositionDisplayText.length > rawText.length &&
      latestCompositionDisplayText.endsWith(rawText)
        ? latestCompositionDisplayText
        : rawText;

    const shiftedPrefix = compositionBaseText.slice(changedRange.startUtf16Index);
    const shiftedPrefixWidth = stringCellWidth(shiftedPrefix);
    const anchorX = Math.max(0, compositionAnchor.cursorX - shiftedPrefixWidth);
    const anchorAbsY = compositionAnchor.cursorAbsY;

    update({
      text: previewText,
      caretUtf16Index: previewText.length,
      caretCellOffset: stringCellWidth(previewText),
      textCellWidth: stringCellWidth(previewText),
      anchorBufferX: anchorX,
      anchorBufferAbsY: anchorAbsY,
    });

    traceComposition(options, "ime-composition-sync", {
      phase,
      isCarryOver,
      baseText: compositionBaseText,
      textareaValue: textarea.value,
      previewText,
      anchorX,
      anchorAbsY,
    });
  };

  const schedulePreviewSync = () => {
    cancelPendingSync();
    pendingAnimationFrame = requestAnimationFrame(() => {
      pendingAnimationFrame = null;
      syncPreview();
    });
    pendingTimeout = setTimeout(() => {
      pendingTimeout = null;
      syncPreview();
    }, 0);
  };

  const handleCompositionStart = () => {
    if (phase === "pending-finalize") {
      // Carry-over detected: Korean IME committed one syllable and immediately
      // started the next — like WT's composition counter staying above 0.
      // Cancel the deferred reset and continue the composition chain.
      cancelPendingFinalize();
      isCarryOver = true;
      // The committed syllable has already gone to the PTY, so it must leave the
      // preview — keeping it would show confirmed text as still composing and
      // grow the preview across the whole sentence (issue #546). Re-base on the
      // current textarea value so `getChangedRange` yields only the new syllable.
      const committedBase = textarea?.value ?? "";
      // Anchor the syllable at the chain's start plus the width of **everything
      // committed since the chain started** — not by nudging the previous anchor,
      // and never by adopting a live shadow-cursor reading taken mid-chain.
      //
      // The live reading is the trap (issue #551). It lags the committed text by
      // as many syllables as the PTY has not echoed yet, so "the shadow cursor
      // moved" does not mean "the shadow cursor caught up". Adopting it on the
      // second carry-over of `ㄱㄱㄱ` regressed a correct arithmetic column 4 back
      // to the one-echo-behind value 4 when the truth was 6: the third syllable
      // painted on top of the second and the preview looked frozen at `ㄱㄱ`.
      //
      // Deriving from the chain start is monotonic and treats the first and Nth
      // carry-over identically. `cursorAbsY` is an absolute buffer row, so it does
      // not move when the viewport scrolls — the chain's row stays valid.
      const chainCommittedWidth = stringCellWidth(committedBase.slice(chainBaseText.length));
      const derived: BufferAnchor = {
        cursorX: chainAnchor.cursorX + chainCommittedWidth,
        cursorAbsY: chainAnchor.cursorAbsY,
      };
      // A row change means the arithmetic origin is no longer valid, whatever the
      // direction: xterm pushed a whole wide glyph past the wrap boundary, the shell
      // reprinted its input line one row up (CUP / `ESC[A` — PSReadLine multi-line,
      // a two-line zsh prompt), IL/DL/RI moved the row inside a scroll region, or
      // the scrollback cap dropped old rows so a fixed row's absolute index fell.
      // All of those keep the composition valid, so the live reading wins and
      // becomes the new origin. Not re-basing was the bug: `derived` kept being
      // computed from the dead origin, `liveIsAhead` then stayed true for the rest
      // of the chain, and the anchor tracked the one-echo-behind live value again —
      // the very regression this guard exists to stop.
      //
      // Lag is rejected only *within* a row, which is sound because an echo arriving
      // late never changes rows — it is the same text landing at a larger column.
      //
      // Scope note: on panes whose anchor comes from the shadow cursor,
      // `getShadowSyncEligibility` returns `composition-preview-active` while a
      // composition is open, so the live reading is frozen and the row-change branch
      // effectively never fires. It is the buffer-cursor (shell) path that actually
      // exercises the re-base.
      const live = options.getAnchor();
      const rowChanged = live.cursorAbsY !== chainAnchor.cursorAbsY;
      const liveAhead = !rowChanged && live.cursorX > derived.cursorX;
      let anchorSource: string;
      if (rowChanged || liveAhead) {
        chainAnchor = live;
        chainBaseText = committedBase;
        compositionAnchor = live;
        anchorSource = rowChanged ? "shadow-cursor-rebase-row" : "shadow-cursor-rebase-ahead";
      } else {
        compositionAnchor = derived;
        anchorSource = "chain-committed-width";
      }
      // Re-base the per-syllable diff so `getChangedRange` yields only the new
      // syllable — the committed one has already gone to the PTY and must leave
      // the preview (issue #546).
      compositionBaseText = committedBase;
      traceComposition(options, "ime-composition-start-carryover", {
        baseText: compositionBaseText,
        textareaValue: textarea?.value ?? "",
        chainBaseText,
        chainCommittedWidth,
        // The origin this carry-over derived from, before any re-base above.
        chainAnchorX: derived.cursorX - chainCommittedWidth,
        derivedX: derived.cursorX,
        liveX: live.cursorX,
        liveAbsY: live.cursorAbsY,
        anchorSource,
        anchorBufferX: compositionAnchor.cursorX,
        anchorBufferAbsY: compositionAnchor.cursorAbsY,
      });
    } else {
      // Fresh composition start
      isCarryOver = false;
      // The only place a live anchor is read. Everything the chain paints after
      // this is derived from it arithmetically.
      chainAnchor = options.getAnchor();
      chainBaseText = textarea?.value ?? "";
      compositionAnchor = chainAnchor;
      compositionBaseText = chainBaseText;
      traceComposition(options, "ime-composition-start", {
        baseText: compositionBaseText,
        anchorBufferX: compositionAnchor.cursorX,
        anchorBufferAbsY: compositionAnchor.cursorAbsY,
        textareaValue: textarea?.value ?? "",
      });
    }

    phase = "composing";
    update({
      active: true,
      anchorBufferX: compositionAnchor.cursorX,
      anchorBufferAbsY: compositionAnchor.cursorAbsY,
      // Clear the text too. On a carry-over the previous syllable is still in
      // `state` and is already committed, so painting it once at the *new*
      // anchor would draw it one syllable to the right of where it really is
      // until the next sync replaces it.
      text: "",
      caretUtf16Index: 0,
      caretCellOffset: 0,
      textCellWidth: 0,
    });
  };

  const handleCompositionUpdate = (event: CompositionEvent) => {
    latestCompositionDisplayText = event.data ?? "";
    traceComposition(options, "ime-composition-update", {
      eventData: event.data ?? "",
      textareaValue: textarea?.value ?? "",
      selectionStart: textarea?.selectionStart ?? null,
    });
    schedulePreviewSync();
  };

  const handleCompositionEnd = () => {
    // Don't finalize immediately — schedule a deferred reset.
    // If a new compositionstart arrives in the same event-loop tick
    // (Korean carry-over), we cancel this timeout and continue.
    // This mirrors WT's pattern where OnEndComposition decrements
    // the counter and only finalizes when it reaches 0.
    phase = "pending-finalize";
    latestCompositionDisplayText = "";

    traceComposition(options, "ime-composition-end", {
      textareaValue: textarea?.value ?? "",
      finalPreviewText: state.text,
    });

    const seqAtEnd = inputActivitySeq;
    pendingFinalizeTimeout = setTimeout(() => {
      pendingFinalizeTimeout = null;
      // Clear committed residue from the helper textarea. xterm binds its
      // compositionend listener before ours (terminal.open() vs later bind),
      // so its finalize timeout is queued first and has already read the
      // value and sent the final text to the PTY by the time this runs.
      // Left alone, the value accumulates across composition chains and any
      // later event-order glitch (missed compositionend, forced finalize)
      // makes xterm's substring bookkeeping re-send already-committed text —
      // the Korean syllable-duplication bug. Skip when any key/input event
      // arrived after compositionend: xterm's keydown-229 diff path may hold
      // a pre-clear snapshot of the value, and clearing under it would emit
      // a spurious DEL.
      if (textarea && textarea.value && inputActivitySeq === seqAtEnd) {
        traceComposition(options, "ime-composition-finalize-clear", {
          clearedValue: textarea.value,
        });
        textarea.value = "";
      }
      reset();
    }, 0);
  };

  const handleActivityEvent = () => {
    inputActivitySeq += 1;
  };

  const handleBlur = () => {
    if (phase === "idle") return;
    // A blur mid-composition means the browser force-committed or aborted
    // the composition. compositionend normally follows, but WebView2 +
    // Windows IME can drop it — leaving this controller (and the preview
    // box) stuck in "composing" until the next focus cycle. Reset here;
    // xterm clears the textarea itself on blur.
    traceComposition(options, "ime-composition-blur-reset", {
      phase,
      textareaValue: textarea?.value ?? "",
    });
    reset();
  };

  const handleInputLikeEvent = (event: Event) => {
    if (!isCompositionSideInput(event as Partial<InputEvent>)) {
      inputActivitySeq += 1;
    }
    if (phase === "composing") {
      schedulePreviewSync();
    }
    traceComposition(options, "ime-composition-input-like", {
      textareaValue: textarea?.value ?? "",
      phase,
    });
  };

  const unbind = () => {
    if (!textarea) return;
    textarea.removeEventListener("compositionstart", handleCompositionStart);
    textarea.removeEventListener("compositionupdate", handleCompositionUpdate);
    textarea.removeEventListener("compositionend", handleCompositionEnd);
    textarea.removeEventListener("beforeinput", handleInputLikeEvent);
    textarea.removeEventListener("input", handleInputLikeEvent);
    textarea.removeEventListener("keydown", handleActivityEvent);
    textarea.removeEventListener("blur", handleBlur);
    textarea = null;
  };

  return {
    bind(nextTextarea) {
      if (textarea === nextTextarea) return;
      unbind();
      textarea = nextTextarea;
      textarea.addEventListener("compositionstart", handleCompositionStart);
      textarea.addEventListener("compositionupdate", handleCompositionUpdate);
      textarea.addEventListener("compositionend", handleCompositionEnd);
      textarea.addEventListener("beforeinput", handleInputLikeEvent);
      textarea.addEventListener("input", handleInputLikeEvent);
      textarea.addEventListener("keydown", handleActivityEvent);
      textarea.addEventListener("blur", handleBlur);
    },
    dispose() {
      unbind();
      reset();
    },
    getState() {
      return state;
    },
  };
}

export type VisualCaretOwner =
  | "hidden"
  | "alt-buffer"
  | "composition-preview"
  | "sync-frame"
  | "shadow-input"
  | "buffer";

type VisualCaretOwnerInput = {
  opened: boolean;
  focused: boolean;
  stabilizeInteractiveCursor: boolean;
  overlayActivity: boolean;
  syncOutputActive: boolean;
  isAltBufferActive: boolean;
  /** The user is viewing scrollback instead of the live terminal bottom. */
  viewportScrolledUp: boolean;
  compositionActive: boolean;
  /**
   * DECTCEM (`\e[?25l`) hidden state as the app last requested it.
   * A sustained hide means the app does not want a visible cursor —
   * the overlay caret must mirror that. Composition preview wins over
   * this (the IME caret tracks the preview text the user is typing).
   */
  cursorHidden: boolean;
  hasSyncFramePosition: boolean;
  hasPromptBoundary: boolean;
  isInputPhase: boolean;
};

export function resolveVisualCaretOwner(input: VisualCaretOwnerInput): VisualCaretOwner {
  if (!input.opened || !input.focused || input.syncOutputActive) {
    return "hidden";
  }
  if (input.isAltBufferActive) {
    return "alt-buffer";
  }
  if (input.viewportScrolledUp) {
    return "hidden";
  }
  // Composition outranks the caret policy gate below (issue #551).
  //
  // The two decisions are not the same kind of thing. `stabilizeInteractiveCursor`
  // and `overlayActivity` decide whether laymux owns the *caret* — a policy that
  // exists because Codex parks its cursor on the footer during repaints, so only
  // there is a shadow-cursor caret worth drawing. The composition preview is not a
  // caret: it is the text the user is currently typing, and its native renderer is
  // switched off unconditionally (`.xterm .composition-view { visibility: hidden }`
  // in index.css). Gating it on the caret policy left non-Codex panes with no
  // renderer at all for in-flight composition — invisible, no underline, in every
  // shell and every non-Codex TUI.
  //
  // It stays *below* opened/focused/syncOutputActive, alt-buffer and
  // viewportScrolledUp: those are genuine "not visible / geometry not trustworthy"
  // conditions, and painting a preview against them would place it wrongly.
  if (input.compositionActive) {
    return "composition-preview";
  }
  if (!input.stabilizeInteractiveCursor || !input.overlayActivity) {
    return "hidden";
  }
  if (input.cursorHidden) {
    return "hidden";
  }
  if (input.hasSyncFramePosition) {
    return "sync-frame";
  }
  if (input.hasPromptBoundary && input.isInputPhase) {
    return "shadow-input";
  }
  return "buffer";
}
