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
  /**
   * Live column count, used only to tell two kinds of row change apart at a
   * carry-over (issue #551):
   *
   *  - the committed text wrapped, so the live cursor legitimately sits on
   *    `chainRow + floor(derived / cols)`. Arithmetic already knows the answer and
   *    the layout normalizes the out-of-range column, so the live reading — which
   *    lags the echo — must NOT be adopted.
   *  - something moved the input line itself (a shell reprinting one row up, IL/DL
   *    inside a scroll region, the scrollback cap dropping rows). Arithmetic cannot
   *    know that, so the live reading becomes the new origin.
   *
   * #541 rejected passing `cols` in to do the controller's own wrapping. This is a
   * different use: wrapping stays in `getCompositionPreviewLayout`, and `cols` only
   * classifies a row change. Return 0 when unknown — the classifier then treats
   * every row change as unexplained, which is the pre-existing behaviour.
   */
  getCols: () => number;
  /**
   * Commit text the controller is dropping so the caller can send it to the PTY.
   * Only used when a blur ends a live composition — see `handleBlur` for why xterm
   * cannot be relied on to send it and why this cannot double up (issue #555).
   */
  onCommit?: (text: string) => void;
  /**
   * Whether xterm still has a composition send scheduled. Measured discriminator
   * for the blur commit — see `handleBlur` (issue #555).
   */
  getXtermPendingSend?: () => boolean;
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
  /**
   * The buffer gained `rowDelta` rows of scrollback, so every absolute row below
   * the top moved down by that much. Carries the open composition's anchor with
   * it (issue #570).
   */
  notifyBufferScrolled(rowDelta: number): void;
};

/**
 * Where the cursor ends up after xterm writes `text` starting at `originColumn`.
 *
 * The single owner of the row-advance rule. Both the carry-over anchor arithmetic
 * and the preview layout's anchor normalization go through here so the rule cannot
 * drift between them — #541's objection to duplicating wrap logic applies even when
 * the second copy is "only" a classifier.
 *
 * `originColumn` may be at or past `cols`: xterm's pending-wrap cursor stays at
 * `cols` until the next write, and the carry-over anchor is derived arithmetically.
 *
 * Cluster-aware and pad-aware, matching xterm measured on the committed bundle: when
 * the remaining space is narrower than the glyph, xterm pads the last column and puts
 * the whole glyph on the next row. So `advanceCells(74, "가", 75)` is `(2, +1)`, not
 * the `(1, +1)` that plain `% cols` arithmetic on a 2-cell width would give.
 */
export function advanceCells(
  originColumn: number,
  text: string,
  cols: number,
): { column: number; rowOffset: number } {
  if (cols <= 0) {
    return { column: originColumn + stringCellWidth(text), rowOffset: 0 };
  }
  let column = originColumn % cols;
  let rowOffset = Math.floor(originColumn / cols);
  for (const { width } of splitCellClusters(text)) {
    if (width > 0 && column + width > cols) {
      rowOffset += 1;
      column = 0;
    }
    column += width;
  }
  return { column, rowOffset };
}

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
  /**
   * The anchor after normalization, in the same space as `rows[].startColumn` and
   * `rows[].rowOffset`. Returned so the renderer places its container from these
   * instead of re-deriving them from the raw `anchorBufferX`: doing that in two
   * places is what double-counted the row offset and dropped the preview a row
   * below its own caret.
   */
  anchorColumn: number;
  anchorRowOffset: number;
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
      // The one documented exception to the normalization contract: with no known
      // column count there is nothing to normalize against, so the raw anchor is
      // passed through here and in `startColumn` below. Only reachable when
      // `cols <= 0`, which the renderer never does.
      anchorColumn: state.anchorBufferX,
      anchorRowOffset: 0,
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
  // Normalize an anchor column that is at or past the right edge before laying
  // anything out (issue #551). Two ways it gets there, both legitimate:
  //
  //  - xterm's pending-wrap cursor. Fill a row to its last column and
  //    `buffer.active.cursorX` stays at `cols` until the next write wraps it, so
  //    the live anchor is reported as column 150 on a 150-column terminal.
  //  - the carry-over anchor is derived as origin + committed width, which runs
  //    past the edge while the echo of the wrapping syllable has not arrived.
  //
  // The caret path already normalized (`getCompositionPreviewCursor` uses
  // `% cols` and `floor(/ cols)`); this loop did not. Its wrap branch only ever
  // resets to column 0, so *every* out-of-range anchor rendered at column 0 of
  // the next row: 150 landed correctly, 152 landed on top of it, and the second
  // syllable of a chain crossing the boundary simply vanished under the first.
  const anchorAdvance = advanceCells(state.anchorBufferX, "", cols);
  const anchorColumn = anchorAdvance.column;
  const anchorRowOffset = anchorAdvance.rowOffset;
  let currentCol = anchorColumn;
  let currentRowOffset = anchorRowOffset;
  let currentRowStartColumn = anchorColumn;
  let currentRowText = "";
  let currentRowWidth = 0;
  let consumedCellWidth = 0;
  let cursorX = anchorColumn;
  let cursorAbsY = state.anchorBufferAbsY + anchorRowOffset;
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
    anchorColumn,
    anchorRowOffset,
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
  // Column count captured with the origin. A reflow invalidates both the origin row
  // and any row delta measured in the old count, so a change forces a re-base.
  let chainCols = 0;
  // Textarea value snapshot at the start of the *current syllable*, so the preview
  // diff yields only the syllable being composed.
  let compositionBaseText = "";
  // Latest compositionupdate event.data — used for Korean split-time display
  let latestCompositionDisplayText = "";
  // Text handed to xterm at the last compositionend. xterm sends it from a deferred
  // timeout, so a blur landing inside that window destroys the source and this is the
  // only surviving copy (issue #555).
  let lastFinalizedText = "";

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
    chainCols = 0;
    compositionBaseText = "";
    latestCompositionDisplayText = "";
    lastFinalizedText = "";
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
      const live = options.getAnchor();
      const cols = options.getCols();
      const chainCommitted = committedBase.slice(chainBaseText.length);
      const chainCommittedWidth = stringCellWidth(chainCommitted);
      // Advance through the shared rule rather than adding the width, so `derived`
      // knows what plain arithmetic cannot: when the remaining space is narrower than
      // the glyph, xterm pads the last column and puts the whole glyph on the next
      // row. Measured — origin 74 on a 75-column terminal advances to (2, +1), while
      // `74 + 2` normalized by `% cols` claims column 1. That one cell was corrected
      // by the next carry-over's live reading, so it only showed when the boundary
      // syllable was the chain's *last* — typing one syllable at the right margin and
      // confirming with space had no next carry-over to fix it.
      // Captured before any re-base below so the trace reports the origin this
      // carry-over actually derived from.
      const originX = chainAnchor.cursorX;
      const advance = advanceCells(chainAnchor.cursorX, chainCommitted, cols);
      // Kept as cells measured from column 0 of the chain's origin row so it stays on
      // one axis with `liveAbs` below. The layout normalizes it back into a column and
      // a row offset with the same rule.
      const derived: BufferAnchor = {
        cursorX: cols > 0 ? advance.column + advance.rowOffset * cols : advance.column,
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
      // Where the committed text says the live cursor should be once it has caught
      // up — straight out of the shared advance, no second wrap rule. Measured on a
      // 150-column shell: origin 148, three syllables committed, `derived` 154 — that
      // is row+1 column 4, and the live cursor reported (2, row+1) because it had
      // echoed only two. Adopting it there dropped a syllable of advance and, because
      // adoption re-bases, the deficit then persisted for the rest of the chain: five
      // jamo typed, four drawn.
      const derivedRow = chainAnchor.cursorAbsY + advance.rowOffset;
      const rowExplainedByWrap = live.cursorAbsY === derivedRow;
      // A reflow moves the row the origin pointed at, so neither the origin nor a row
      // delta measured in the old column count survives it. Re-base unconditionally
      // rather than relying on the classifier happening to fall through to
      // `originMoved` — it does today, but by luck.
      const colsChanged = chainCols !== 0 && cols !== chainCols;
      // Compare on one axis, in cells measured from the chain origin's row, so a
      // wrapped live reading is not mistaken for a moved one.
      const liveAbs =
        live.cursorX + (cols > 0 ? (live.cursorAbsY - chainAnchor.cursorAbsY) * cols : 0);
      const originMoved =
        colsChanged || (!rowExplainedByWrap && live.cursorAbsY !== chainAnchor.cursorAbsY);
      const liveAhead = !originMoved && liveAbs > derived.cursorX;
      let anchorSource: string;
      if (originMoved || liveAhead) {
        chainAnchor = live;
        chainBaseText = committedBase;
        chainCols = cols;
        compositionAnchor = live;
        anchorSource = colsChanged
          ? "shadow-cursor-rebase-resize"
          : originMoved
            ? "shadow-cursor-rebase-row"
            : "shadow-cursor-rebase-ahead";
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
        chainAnchorX: originX,
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
      chainCols = options.getCols();
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

  const handleCompositionEnd = (event?: CompositionEvent) => {
    // Don't finalize immediately — schedule a deferred reset.
    // If a new compositionstart arrives in the same event-loop tick
    // (Korean carry-over), we cancel this timeout and continue.
    // This mirrors WT's pattern where OnEndComposition decrements
    // the counter and only finalizes when it reaches 0.
    phase = "pending-finalize";
    // Read the event's own data. It is the only thing that distinguishes a commit
    // from a cancel: pressing Esc mid-composition ends it with `data: ""`, and
    // without looking at that this would keep the previous syllable and inject it if
    // a blur followed (issue #555 review). `compositionupdate` is already trusted
    // the same way a few lines up, so the posture is consistent.
    //
    // Fall back to the preview text only when the event is absent — a synthetic
    // dispatch, or a browser that omits `data`. `state.text` can still be empty when
    // the last `compositionupdate` has not reached its deferred sync yet, so the
    // synchronous `latestCompositionDisplayText` backs it up.
    lastFinalizedText =
      typeof event?.data === "string" ? event.data : state.text || latestCompositionDisplayText;
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
    // A blur mid-composition leaves this controller (and the preview box) stuck in
    // "composing" until the next focus cycle, so it still has to reset.
    //
    // But resetting alone *loses the syllable* (issue #555). Measured against a real
    // `Terminal`: on blur xterm clears the helper textarea and sends nothing, leaving
    // its own `_isComposing` true; a `compositionend` arriving after the blur cannot
    // recover it either, because the finalizer's slice source is already empty. For
    // Korean — and CJK generally — a focus change is a commit, not a cancel, so the
    // text the user could see has to reach the PTY.
    //
    // Phase alone is NOT the discriminator — measured. WebView2 + Windows IME fires
    // `compositionend` *before* the blur, so the real sequence is end → blur → flush:
    // the blur lands inside xterm's deferred finalize window, clears the textarea, and
    // the finalizer then slices an empty string. The controller is in
    // `pending-finalize` there, and the syllable is lost exactly as if no
    // `compositionend` had arrived at all.
    //
    // What separates "xterm will send it" from "xterm can no longer send it" is
    // xterm's own pending flag at blur time:
    //
    //   end → blur → flush   pending true   textarea already ""   → doomed, commit
    //   end → flush → blur   pending false  already on the wire   → do not commit
    //
    // Two texts can be in danger at once. A carry-over ends one syllable and starts the
    // next in the same tick, so a blur can catch a doomed pending send *and* a live
    // composition. The doomed one is `lastFinalizedText` — not `state.text`, which by
    // then holds the newer syllable.
    //
    // Neither comes from the textarea: xterm clears it in its own blur handler, which
    // is registered first (at `terminal.open()`), so reading it here would depend on
    // listener order.
    const xtermSendPending = options.getXtermPendingSend?.() ?? false;
    const doomedFinalized = xtermSendPending ? lastFinalizedText : "";
    // `state.text` lags: the preview sync is deferred to a rAF/timeout, so a blur can
    // arrive before the last `compositionupdate` has been applied. The display text from
    // that update is synchronous and, per the preview logic, the same source — so it is a
    // backstop, not a different value.
    const inFlight = phase === "composing" ? state.text || latestCompositionDisplayText : "";
    const commitOnBlur = doomedFinalized + inFlight;
    traceComposition(options, "ime-composition-blur-reset", {
      phase,
      textareaValue: textarea?.value ?? "",
      xtermSendPending,
      doomedFinalized,
      inFlight,
      commitOnBlur,
    });
    if (commitOnBlur) options.onCommit?.(commitOnBlur);
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
    /**
     * The anchor is an absolute buffer row, and the renderer turns it into a
     * screen row with `anchorBufferAbsY - baseY`. That subtraction is what makes
     * a *stationary* anchor drift: a TUI that keeps its input box at the bottom
     * pushes its transcript up by emitting rows, `baseY` grows, and the preview
     * rides the old content upward while the line it belongs to stays put
     * (issue #570 — measured 9 rows of Claude output, preview 9 rows high).
     *
     * Nothing else re-anchors in that window. The anchor is recomputed on
     * composition events only, so between two keystrokes — or during the long
     * pause while an agent streams a reply — there is no other owner to correct
     * it.
     *
     * Adding the same delta pins the anchor to its screen row, which is where
     * the input line stays. When the scrollback cap is reached the delta is 0:
     * rows are dropped from the top instead, the bottom-anchored input line
     * keeps its absolute row, and the anchor must not move either.
     */
    notifyBufferScrolled(rowDelta) {
      if (rowDelta === 0 || phase === "idle" || !state.active) return;
      compositionAnchor = {
        ...compositionAnchor,
        cursorAbsY: compositionAnchor.cursorAbsY + rowDelta,
      };
      chainAnchor = { ...chainAnchor, cursorAbsY: chainAnchor.cursorAbsY + rowDelta };
      traceComposition(options, "ime-composition-anchor-scrolled", {
        rowDelta,
        anchorBufferAbsY: compositionAnchor.cursorAbsY,
      });
      update({ anchorBufferAbsY: compositionAnchor.cursorAbsY });
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
  // Scrolled into the scrollback: nothing may paint, composition included. The
  // preview is anchored to a buffer row, so drawing it against a viewport that is
  // showing history puts it on the wrong line — and the user is not looking at the
  // input line anyway. Measured: the preview disappears on scroll and comes back
  // intact at the live bottom, with no text lost, so hiding here is correct rather
  // than a gap to close (issue #553 non-goals).
  if (input.viewportScrolledUp) {
    return "hidden";
  }
  // Composition outranks the caret policy gate below (issue #551) and the alt buffer
  // (issue #553).
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
  // The alt buffer is the same kind of question as the caret policy: a fullscreen TUI
  // drives its own cursor, so a shadow-cursor caret is meaningless there. That says
  // nothing about the text the user is typing, and vim showed the consequence — the
  // composing jamo was invisible with no way to see it, before any scrolling.
  // Anchoring is in fact simpler in the alt buffer: it has no scrollback, so `baseY`
  // is always 0 and the absolute-row conversion is the identity. vim emits neither an
  // OSC 133 prompt nor a sync frame, so `computeUseShadowCursor` is false and the
  // anchor comes from the live buffer cursor — which is exactly where vim put it.
  //
  // It stays *below* opened/focused/syncOutputActive and viewportScrolledUp: those are
  // genuine "not visible / geometry not trustworthy" conditions, and painting a
  // preview against them would place it wrongly.
  if (input.compositionActive) {
    return "composition-preview";
  }
  if (input.isAltBufferActive) {
    return "alt-buffer";
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
