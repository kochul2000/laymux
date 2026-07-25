import { describe, expect, it } from "vitest";

import {
  clampAnchorCell,
  computeCellMetrics,
  computeHelperAnchorStyle,
  resolveAnchorCellFromAbsolute,
  shouldSyncHelperAnchor,
  snapToDevicePixel,
} from "./ime-anchor";

describe("computeCellMetrics", () => {
  it("derives cell size from the rendered rect", () => {
    expect(computeCellMetrics(800, 400, 80, 25)).toEqual({ cellWidth: 10, cellHeight: 16 });
  });

  it("keeps fractional cell sizes instead of rounding them away", () => {
    // Fractional cell sizes are the normal case on non-integer DPR displays; the
    // rounding belongs at the device-pixel step, not here.
    const metrics = computeCellMetrics(801, 401, 80, 25);
    expect(metrics?.cellWidth).toBeCloseTo(10.0125, 6);
    expect(metrics?.cellHeight).toBeCloseTo(16.04, 6);
  });

  it("returns null for geometry that is not usable yet", () => {
    expect(computeCellMetrics(800, 400, 0, 25)).toBeNull();
    expect(computeCellMetrics(800, 400, 80, 0)).toBeNull();
    expect(computeCellMetrics(0, 400, 80, 25)).toBeNull();
    expect(computeCellMetrics(800, 0, 80, 25)).toBeNull();
    expect(computeCellMetrics(Number.NaN, 400, 80, 25)).toBeNull();
    expect(computeCellMetrics(800, Number.POSITIVE_INFINITY, 80, 25)).toBeNull();
  });
});

describe("shouldSyncHelperAnchor", () => {
  it("does not sync when the public cursor already sits on the anchor", () => {
    // Ordinary shell: xterm's own placement is correct, so the textarea is left
    // exactly where xterm put it.
    expect(shouldSyncHelperAnchor({ column: 5, row: 3 }, { column: 5, row: 3 })).toBe(false);
  });

  it("syncs when the row differs (TUI footer repaint)", () => {
    expect(shouldSyncHelperAnchor({ column: 5, row: 24 }, { column: 5, row: 3 })).toBe(true);
  });

  it("syncs when only the column differs", () => {
    expect(shouldSyncHelperAnchor({ column: 0, row: 3 }, { column: 12, row: 3 })).toBe(true);
  });
});

describe("clampAnchorCell", () => {
  it("leaves a cell inside the viewport untouched", () => {
    expect(clampAnchorCell({ column: 10, row: 4 }, 80, 25)).toEqual({ column: 10, row: 4 });
  });

  it("clamps a cell past the last row or column", () => {
    // A shadow cursor can resolve to a row that has since scrolled away; the
    // popup must stay attached to the pane rather than fly outside it.
    expect(clampAnchorCell({ column: 200, row: 900 }, 80, 25)).toEqual({ column: 79, row: 24 });
  });

  it("clamps negative coordinates to the first cell", () => {
    expect(clampAnchorCell({ column: -3, row: -7 }, 80, 25)).toEqual({ column: 0, row: 0 });
  });

  it("survives a degenerate viewport without producing negative cells", () => {
    expect(clampAnchorCell({ column: 4, row: 4 }, 0, 0)).toEqual({ column: 0, row: 0 });
  });
});

describe("snapToDevicePixel", () => {
  it("snaps to the device pixel grid at fractional DPR", () => {
    // 1.5 DPR: the grid step is 2/3 CSS px.
    expect(snapToDevicePixel(10.4, 1.5)).toBeCloseTo(10.666666, 5);
    expect(snapToDevicePixel(10.1, 1.5)).toBeCloseTo(10, 5);
  });

  it("rounds to whole pixels at DPR 1", () => {
    expect(snapToDevicePixel(10.4, 1)).toBe(10);
    expect(snapToDevicePixel(10.6, 1)).toBe(11);
  });

  it("keeps half-pixel precision at DPR 2", () => {
    expect(snapToDevicePixel(10.4, 2)).toBe(10.5);
  });

  it("falls back to 1 for a nonsense ratio", () => {
    expect(snapToDevicePixel(10.6, 0)).toBe(11);
    expect(snapToDevicePixel(10.6, Number.NaN)).toBe(11);
    expect(snapToDevicePixel(10.6, -2)).toBe(11);
  });
});

describe("computeHelperAnchorStyle", () => {
  const metrics = { cellWidth: 10, cellHeight: 16 };

  it("places the textarea on the anchor cell origin", () => {
    expect(
      computeHelperAnchorStyle({
        anchorCell: { column: 4, row: 3 },
        metrics,
        originLeft: 0,
        originTop: 0,
        devicePixelRatio: 1,
      }),
    ).toEqual({ left: 40, top: 48 });
  });

  it("adds the screen origin offset", () => {
    expect(
      computeHelperAnchorStyle({
        anchorCell: { column: 4, row: 3 },
        metrics,
        originLeft: 7,
        originTop: 11,
        devicePixelRatio: 1,
      }),
    ).toEqual({ left: 47, top: 59 });
  });

  it("snaps fractional cell positions to device pixels", () => {
    const result = computeHelperAnchorStyle({
      anchorCell: { column: 3, row: 2 },
      metrics: { cellWidth: 10.0125, cellHeight: 16.04 },
      originLeft: 0.5,
      originTop: 0.25,
      devicePixelRatio: 2,
    });
    // 0.5 + 30.0375 = 30.5375 → nearest half pixel = 30.5
    expect(result.left).toBe(30.5);
    // 0.25 + 32.08 = 32.33 → nearest half pixel = 32.5
    expect(result.top).toBe(32.5);
  });

  it("returns the origin itself for the first cell", () => {
    expect(
      computeHelperAnchorStyle({
        anchorCell: { column: 0, row: 0 },
        metrics,
        originLeft: 6,
        originTop: 9,
        devicePixelRatio: 1,
      }),
    ).toEqual({ left: 6, top: 9 });
  });
});

describe("resolveAnchorCellFromAbsolute", () => {
  it("converts an absolute buffer row to a viewport row", () => {
    expect(resolveAnchorCellFromAbsolute(12, 140, 130)).toEqual({ column: 12, row: 10 });
  });

  it("reports a negative row for a cell scrolled above the viewport", () => {
    // Left unclamped on purpose: the caller decides whether to clamp or skip, and
    // conflating the two here would hide a scrollback case from the caller.
    expect(resolveAnchorCellFromAbsolute(0, 100, 130)).toEqual({ column: 0, row: -30 });
  });
});

describe("preview and candidate window share one anchor", () => {
  it("resolves the same cell for both consumers from one input", () => {
    // The point of the contract: given a composition layout result, the cell the
    // preview paints and the cell the textarea moves to are the same value, not
    // two independent derivations.
    const previewLayout = { cursorX: 7, cursorAbsY: 143 };
    const baseY = 140;

    const anchorCell = resolveAnchorCellFromAbsolute(
      previewLayout.cursorX,
      previewLayout.cursorAbsY,
      baseY,
    );
    expect(anchorCell).toEqual({ column: 7, row: 3 });

    const metrics = computeCellMetrics(800, 400, 80, 25);
    expect(metrics).not.toBeNull();
    const style = computeHelperAnchorStyle({
      anchorCell,
      metrics: metrics!,
      originLeft: 0,
      originTop: 0,
      devicePixelRatio: 1,
    });
    // Same cell → same pixel origin the overlay caret uses (column * cellWidth).
    expect(style).toEqual({ left: 70, top: 48 });
  });
});
