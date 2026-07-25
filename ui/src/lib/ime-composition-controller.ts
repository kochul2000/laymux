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

  // Anchor captured at the first compositionstart — preserved across carry-overs
  let compositionAnchor: BufferAnchor = { cursorX: 0, cursorAbsY: 0 };
  // Textarea value snapshot at the start of the composition chain
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
      // Keep compositionAnchor and compositionBaseText from the first composition
      traceComposition(options, "ime-composition-start-carryover", {
        baseText: compositionBaseText,
        textareaValue: textarea?.value ?? "",
        anchorBufferX: compositionAnchor.cursorX,
        anchorBufferAbsY: compositionAnchor.cursorAbsY,
      });
    } else {
      // Fresh composition start
      isCarryOver = false;
      compositionAnchor = options.getAnchor();
      compositionBaseText = textarea?.value ?? "";
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

  // Commit-side input events belong to the composition itself, not to the
  // user typing something new. WebView2/Chromium can deliver the commit's
  // beforeinput/input AFTER compositionend — counting those toward
  // inputActivitySeq would break the quiescence check in the deferred
  // finalize and leave the textarea residue (the accumulation this
  // controller exists to remove) in place.
  const isCompositionSideInput = (event: Event): boolean => {
    const inputEvent = event as Partial<InputEvent>;
    return (
      inputEvent.isComposing === true ||
      inputEvent.inputType === "insertCompositionText" ||
      inputEvent.inputType === "insertFromComposition" ||
      inputEvent.inputType === "deleteCompositionText"
    );
  };

  const handleInputLikeEvent = (event: Event) => {
    if (!isCompositionSideInput(event)) {
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
  if (!input.stabilizeInteractiveCursor || !input.overlayActivity) {
    return "hidden";
  }
  if (input.compositionActive) {
    return "composition-preview";
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
