/**
 * Anchor contract shared by the visible composition preview and the OS's native
 * IME candidate window.
 *
 * Issue #532. laymux renders its own composition preview from the **shadow
 * cursor** (`shadow-cursor-state.ts`), because TUI prompts move xterm's public
 * buffer cursor to a footer/status row during repaints. The OS candidate window
 * has no idea about any of that: it is positioned from the DOM rect of the
 * focused xterm helper textarea, and xterm keeps that textarea on the **public
 * buffer cursor**. Wherever the two disagree, the preview is right and the
 * candidate window is on a different row or column.
 *
 * ADR-0053 decided not to move the helper textarea, on the grounds that doing so
 * without evidence risks disturbing the composition lifecycle. ADR-0061 narrows
 * that: the textarea is moved **only** when the two cursors actually disagree,
 * and only its position is touched — never its value, focus, or composition
 * events, which stay xterm's (ADR-0053/0054).
 *
 * Everything here is pure geometry so the rules are testable without a headful
 * browser: cell size derivation, the disagreement gate, device-pixel rounding
 * and clamping. The caller owns all DOM reads and writes.
 */

export type CellMetrics = {
  cellWidth: number;
  cellHeight: number;
};

/** A cell in viewport coordinates: column, and row relative to the viewport top. */
export type AnchorCell = {
  column: number;
  row: number;
};

/**
 * Cell size from the rendered screen rect.
 *
 * Derived from the measured rect rather than from font metrics so it already
 * includes whatever scaling the renderer applied — the same derivation the
 * overlay caret uses, which is what keeps preview and candidate window on one
 * contract. Returns `null` for any degenerate geometry (zero-size canvas during
 * mount, `cols`/`rows` not yet known) so callers can skip instead of writing
 * `NaN` into a style.
 */
export function computeCellMetrics(
  targetWidth: number,
  targetHeight: number,
  cols: number,
  rows: number,
): CellMetrics | null {
  if (cols <= 0 || rows <= 0) return null;
  const cellWidth = targetWidth / cols;
  const cellHeight = targetHeight / rows;
  if (!Number.isFinite(cellWidth) || !Number.isFinite(cellHeight)) return null;
  if (cellWidth <= 0 || cellHeight <= 0) return null;
  return { cellWidth, cellHeight };
}

/**
 * True when the helper textarea has to be moved.
 *
 * The gate is deliberately "the two cursors disagree", not "a composition is
 * active": in an ordinary shell the two agree and xterm's own placement is
 * already correct, so moving the textarea there would be churn with no
 * observable benefit and a real risk of perturbing the IME.
 */
export function shouldSyncHelperAnchor(publicCell: AnchorCell, anchorCell: AnchorCell): boolean {
  return publicCell.column !== anchorCell.column || publicCell.row !== anchorCell.row;
}

/**
 * Clamp an anchor cell into the viewport.
 *
 * A shadow cursor can legitimately sit outside the current viewport (scrollback,
 * a park that resolved to a row that has since scrolled). Placing the textarea
 * there would push the candidate window outside the pane, so the anchor is
 * clamped to the last visible cell instead — the popup stays attached to the
 * pane even when the exact cell is not on screen.
 */
export function clampAnchorCell(cell: AnchorCell, cols: number, rows: number): AnchorCell {
  const maxColumn = Math.max(0, cols - 1);
  const maxRow = Math.max(0, rows - 1);
  return {
    column: Math.min(Math.max(0, cell.column), maxColumn),
    row: Math.min(Math.max(0, cell.row), maxRow),
  };
}

/**
 * Snap a CSS pixel value to the device pixel grid.
 *
 * The candidate window is an OS surface placed from the textarea's device-pixel
 * rect. Leaving a fractional CSS offset lets the OS round it a different way
 * than the renderer rounded the glyph, which shows up as the popup sitting one
 * pixel off the caret on fractional-DPR displays.
 */
export function snapToDevicePixel(value: number, devicePixelRatio: number): number {
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.round(value * ratio) / ratio;
}

export type HelperAnchorInput = {
  anchorCell: AnchorCell;
  metrics: CellMetrics;
  /** Screen-rect origin relative to the textarea's offset parent. */
  originLeft: number;
  originTop: number;
  devicePixelRatio: number;
};

export type HelperAnchorStyle = {
  left: number;
  top: number;
};

/**
 * Offsets to place the helper textarea's top-left on the anchor cell.
 *
 * Only the anchor cell's own origin is used — no width/height are returned. The
 * textarea keeps whatever box xterm gave it; the OS reads its position, and
 * resizing it is not this decision's business.
 */
export function computeHelperAnchorStyle(input: HelperAnchorInput): HelperAnchorStyle {
  const { anchorCell, metrics, originLeft, originTop, devicePixelRatio } = input;
  return {
    left: snapToDevicePixel(originLeft + anchorCell.column * metrics.cellWidth, devicePixelRatio),
    top: snapToDevicePixel(originTop + anchorCell.row * metrics.cellHeight, devicePixelRatio),
  };
}

/**
 * The anchor cell the composition owns, in viewport coordinates.
 *
 * `absY` values come from the buffer's absolute row space; `baseY` converts them
 * to the viewport rows the DOM is laid out in. Both the preview and the
 * candidate window resolve their cell through this one function, which is the
 * "same anchor contract" the issue asks for — if it were computed twice the two
 * would drift the moment either wrap rule changed.
 */
export function resolveAnchorCellFromAbsolute(
  cursorX: number,
  cursorAbsY: number,
  baseY: number,
): AnchorCell {
  return { column: cursorX, row: cursorAbsY - baseY };
}
