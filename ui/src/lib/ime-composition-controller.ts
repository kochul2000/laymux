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

function codePointWidth(codePoint: number): number {
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  ) {
    return 0;
  }
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2329 && codePoint <= 0x232a) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff01 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faf6) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

function splitCodePoints(text: string): { segment: string; width: number }[] {
  const out: { segment: string; width: number }[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const codePoint = text.codePointAt(i);
    if (codePoint === undefined) continue;
    const segment = String.fromCodePoint(codePoint);
    out.push({ segment, width: codePointWidth(codePoint) });
    if (codePoint > 0xffff) {
      i += 1;
    }
  }
  return out;
}

export function stringCellWidth(text: string): number {
  let width = 0;
  for (const item of splitCodePoints(text)) {
    width += item.width;
  }
  return width;
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
  state: Pick<
    CompositionPreviewState,
    "anchorBufferX" | "anchorBufferAbsY" | "caretCellOffset"
  >,
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
  renderedText: string;
  rowCount: number;
  maxRowCellWidth: number;
} {
  const previewCursor = getCompositionPreviewCursor(state, cols);
  if (cols <= 0 || !state.text) {
    return {
      ...previewCursor,
      renderedText: state.text,
      rowCount: 1,
      maxRowCellWidth: state.textCellWidth,
    };
  }

  const segments = splitCodePoints(state.text);
  let currentCol = state.anchorBufferX;
  let maxRowCellWidth = Math.max(0, currentCol);
  let rowCount = 1;
  let renderedText = "";
  let currentRowWidth = currentCol;

  for (const { segment, width } of segments) {
    if (width > 0 && currentCol + width > cols) {
      renderedText += "\n";
      rowCount += 1;
      currentCol = 0;
      currentRowWidth = 0;
    }
    renderedText += segment;
    currentCol += width;
    currentRowWidth += width;
    maxRowCellWidth = Math.max(maxRowCellWidth, currentRowWidth);
  }

  return {
    ...previewCursor,
    renderedText,
    rowCount,
    maxRowCellWidth,
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

    pendingFinalizeTimeout = setTimeout(() => {
      pendingFinalizeTimeout = null;
      reset();
    }, 0);
  };

  const handleInputLikeEvent = () => {
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
  compositionActive: boolean;
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
  if (input.compositionActive) {
    return "composition-preview";
  }
  if (!input.stabilizeInteractiveCursor || !input.overlayActivity) {
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
