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

function readTextareaState(
  textarea: HTMLTextAreaElement,
  compositionStartUtf16Index: number,
  compositionEndUtf16Index: number = textarea.value.length,
): Pick<
  CompositionPreviewState,
  "text" | "caretUtf16Index" | "caretCellOffset" | "textCellWidth"
> {
  const safeStart = Math.max(0, Math.min(compositionStartUtf16Index, textarea.value.length));
  const safeEnd = Math.max(safeStart, Math.min(compositionEndUtf16Index, textarea.value.length));
  const text = textarea.value.slice(safeStart, safeEnd);
  const absoluteCaretUtf16Index = textarea.selectionStart ?? safeEnd;
  const caretUtf16Index = Math.max(0, Math.min(absoluteCaretUtf16Index, safeEnd) - safeStart);
  return {
    text,
    caretUtf16Index,
    caretCellOffset: stringCellWidth(text.slice(0, caretUtf16Index)),
    textCellWidth: stringCellWidth(text),
  };
}

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

function getAnchoredCompositionState(
  textarea: HTMLTextAreaElement,
  baseText: string,
  baseAnchor: BufferAnchor,
): Pick<
  CompositionPreviewState,
  "text" | "caretUtf16Index" | "caretCellOffset" | "textCellWidth" | "anchorBufferX" | "anchorBufferAbsY"
> {
  const changedRange = getChangedRange(baseText, textarea.value);
  const shiftedPrefix = baseText.slice(changedRange.startUtf16Index);
  const shiftedPrefixWidth = stringCellWidth(shiftedPrefix);
  const absoluteCaretUtf16Index = textarea.selectionStart ?? changedRange.endUtf16Index;
  const caretUtf16Index = Math.max(
    0,
    Math.min(absoluteCaretUtf16Index, changedRange.endUtf16Index) - changedRange.startUtf16Index,
  );

  return {
    text: changedRange.text,
    caretUtf16Index,
    caretCellOffset: stringCellWidth(changedRange.text.slice(0, caretUtf16Index)),
    textCellWidth: stringCellWidth(changedRange.text),
    anchorBufferX: Math.max(0, baseAnchor.cursorX - shiftedPrefixWidth),
    anchorBufferAbsY: baseAnchor.cursorAbsY,
  };
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

export function createImeCompositionController(
  options: CompositionControllerOptions,
): ImeCompositionController {
  let textarea: HTMLTextAreaElement | null = null;
  let state = createEmptyState();
  let compositionBaseText = "";
  let compositionBaseAnchor: BufferAnchor = { cursorX: 0, cursorAbsY: 0 };
  let latestCompositionDisplayText = "";
  let compositionStartUtf16Index = 0;
  let compositionEndUtf16Index = 0;
  let pendingAnimationFrame: number | null = null;
  let pendingTimeout: ReturnType<typeof setTimeout> | null = null;

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

  const reset = () => {
    cancelPendingSync();
    compositionBaseText = "";
    compositionBaseAnchor = { cursorX: 0, cursorAbsY: 0 };
    latestCompositionDisplayText = "";
    compositionStartUtf16Index = 0;
    compositionEndUtf16Index = 0;
    state = createEmptyState();
    emit();
  };

  const handleCompositionStart = () => {
    const anchor = options.getAnchor();
    const nextTextarea = textarea;
    compositionBaseText = nextTextarea?.value ?? "";
    compositionBaseAnchor = anchor;
    compositionStartUtf16Index = nextTextarea?.value.length ?? 0;
    compositionEndUtf16Index = compositionStartUtf16Index;
    update({
      active: true,
      anchorBufferX: anchor.cursorX,
      anchorBufferAbsY: anchor.cursorAbsY,
      ...(nextTextarea
        ? readTextareaState(
            nextTextarea,
            compositionStartUtf16Index,
            compositionEndUtf16Index,
          )
        : { text: "", caretUtf16Index: 0, caretCellOffset: 0, textCellWidth: 0 }),
    });
  };

  const syncPreviewFromTextareaSlice = () => {
    cancelPendingSync();
    if (!textarea || !state.active) return;
    compositionEndUtf16Index = textarea.value.length;
    const anchoredState = getAnchoredCompositionState(textarea, compositionBaseText, compositionBaseAnchor);
    const previewText =
      latestCompositionDisplayText &&
      latestCompositionDisplayText.length > anchoredState.text.length &&
      latestCompositionDisplayText.endsWith(anchoredState.text)
        ? latestCompositionDisplayText
        : anchoredState.text;
    update({
      ...anchoredState,
      text: previewText,
      caretUtf16Index: previewText.length,
      caretCellOffset: stringCellWidth(previewText),
      textCellWidth: stringCellWidth(previewText),
    });
  };

  const schedulePreviewSync = () => {
    cancelPendingSync();
    pendingAnimationFrame = requestAnimationFrame(() => {
      pendingAnimationFrame = null;
      syncPreviewFromTextareaSlice();
    });
    pendingTimeout = setTimeout(() => {
      pendingTimeout = null;
      syncPreviewFromTextareaSlice();
    }, 0);
  };

  const handleCompositionUpdate = (event: CompositionEvent) => {
    latestCompositionDisplayText = event.data ?? "";
    schedulePreviewSync();
  };

  const handleCompositionEnd = () => {
    reset();
  };

  const handleInputLikeEvent = () => {
    schedulePreviewSync();
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
      handleInputLikeEvent();
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
