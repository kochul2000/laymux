// Minimum pane size as ratio (100px / 1000px assumed container = 0.1, but we use a safer universal value)
export const PANE_MIN_RATIO = 0.05;

/** Any object with grid coordinates — shared by WorkspacePane, DockPane, GridPane, etc. */
export type GridRect = { x: number; y: number; w: number; h: number };

export interface PaneBoundary {
  direction: "vertical" | "horizontal";
  /** Position of the boundary line (x for vertical, y for horizontal) as 0.0-1.0 */
  position: number;
  /** Indices of panes to the left/top of this boundary */
  leftPaneIndices: number[];
  /** Indices of panes to the right/bottom of this boundary */
  rightPaneIndices: number[];
  /** Start of the boundary range (y for vertical, x for horizontal) */
  start: number;
  /** End of the boundary range */
  end: number;
}

const EPSILON = 0.001;

function pushUnique(indices: number[], value: number): void {
  if (!indices.includes(value)) indices.push(value);
}

function mergeBoundarySegments(boundaries: PaneBoundary[]): PaneBoundary[] {
  const sorted = [...boundaries].sort((a, b) => {
    if (a.direction !== b.direction) return a.direction.localeCompare(b.direction);
    if (Math.abs(a.position - b.position) >= EPSILON) return a.position - b.position;
    return a.start - b.start;
  });

  const merged: PaneBoundary[] = [];

  for (const boundary of sorted) {
    const current = merged[merged.length - 1];
    const canMerge =
      current &&
      current.direction === boundary.direction &&
      Math.abs(current.position - boundary.position) < EPSILON &&
      boundary.start <= current.end + EPSILON;

    if (!canMerge) {
      merged.push({
        ...boundary,
        leftPaneIndices: [...boundary.leftPaneIndices],
        rightPaneIndices: [...boundary.rightPaneIndices],
      });
      continue;
    }

    current.start = Math.min(current.start, boundary.start);
    current.end = Math.max(current.end, boundary.end);
    for (const idx of boundary.leftPaneIndices) pushUnique(current.leftPaneIndices, idx);
    for (const idx of boundary.rightPaneIndices) pushUnique(current.rightPaneIndices, idx);
  }

  return merged;
}

/**
 * Find all shared boundaries between panes.
 */
export function findPaneBoundaries(panes: GridRect[]): PaneBoundary[] {
  if (panes.length <= 1) return [];

  const boundaries: PaneBoundary[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < panes.length; i++) {
    for (let j = i + 1; j < panes.length; j++) {
      const a = panes[i];
      const b = panes[j];

      // Check for vertical boundary (a's right edge = b's left edge or vice versa)
      const aRight = a.x + a.w;
      const bRight = b.x + b.w;

      if (Math.abs(aRight - b.x) < EPSILON) {
        // a is left, b is right, boundary at aRight
        const overlapStart = Math.max(a.y, b.y);
        const overlapEnd = Math.min(a.y + a.h, b.y + b.h);
        if (overlapEnd - overlapStart > EPSILON) {
          const key = `v-${aRight.toFixed(4)}-${overlapStart.toFixed(4)}-${overlapEnd.toFixed(4)}`;
          if (!seen.has(key)) {
            seen.add(key);
            const existing = boundaries.find(
              (bd) =>
                bd.direction === "vertical" &&
                Math.abs(bd.position - aRight) < EPSILON &&
                Math.abs(bd.start - overlapStart) < EPSILON &&
                Math.abs(bd.end - overlapEnd) < EPSILON,
            );
            if (existing) {
              pushUnique(existing.leftPaneIndices, i);
              pushUnique(existing.rightPaneIndices, j);
            } else {
              boundaries.push({
                direction: "vertical",
                position: aRight,
                leftPaneIndices: [i],
                rightPaneIndices: [j],
                start: overlapStart,
                end: overlapEnd,
              });
            }
          }
        }
      } else if (Math.abs(bRight - a.x) < EPSILON) {
        // b is left, a is right
        const overlapStart = Math.max(a.y, b.y);
        const overlapEnd = Math.min(a.y + a.h, b.y + b.h);
        if (overlapEnd - overlapStart > EPSILON) {
          const key = `v-${bRight.toFixed(4)}-${overlapStart.toFixed(4)}-${overlapEnd.toFixed(4)}`;
          if (!seen.has(key)) {
            seen.add(key);
            const existing = boundaries.find(
              (bd) =>
                bd.direction === "vertical" &&
                Math.abs(bd.position - bRight) < EPSILON &&
                Math.abs(bd.start - overlapStart) < EPSILON &&
                Math.abs(bd.end - overlapEnd) < EPSILON,
            );
            if (existing) {
              pushUnique(existing.leftPaneIndices, j);
              pushUnique(existing.rightPaneIndices, i);
            } else {
              boundaries.push({
                direction: "vertical",
                position: bRight,
                leftPaneIndices: [j],
                rightPaneIndices: [i],
                start: overlapStart,
                end: overlapEnd,
              });
            }
          }
        }
      }

      // Check for horizontal boundary (a's bottom edge = b's top edge or vice versa)
      const aBottom = a.y + a.h;
      const bBottom = b.y + b.h;

      if (Math.abs(aBottom - b.y) < EPSILON) {
        // a is top, b is bottom
        const overlapStart = Math.max(a.x, b.x);
        const overlapEnd = Math.min(a.x + a.w, b.x + b.w);
        if (overlapEnd - overlapStart > EPSILON) {
          const key = `h-${aBottom.toFixed(4)}-${overlapStart.toFixed(4)}-${overlapEnd.toFixed(4)}`;
          if (!seen.has(key)) {
            seen.add(key);
            const existing = boundaries.find(
              (bd) =>
                bd.direction === "horizontal" &&
                Math.abs(bd.position - aBottom) < EPSILON &&
                Math.abs(bd.start - overlapStart) < EPSILON &&
                Math.abs(bd.end - overlapEnd) < EPSILON,
            );
            if (existing) {
              pushUnique(existing.leftPaneIndices, i);
              pushUnique(existing.rightPaneIndices, j);
            } else {
              boundaries.push({
                direction: "horizontal",
                position: aBottom,
                leftPaneIndices: [i],
                rightPaneIndices: [j],
                start: overlapStart,
                end: overlapEnd,
              });
            }
          }
        }
      } else if (Math.abs(bBottom - a.y) < EPSILON) {
        // b is top, a is bottom
        const overlapStart = Math.max(a.x, b.x);
        const overlapEnd = Math.min(a.x + a.w, b.x + b.w);
        if (overlapEnd - overlapStart > EPSILON) {
          const key = `h-${bBottom.toFixed(4)}-${overlapStart.toFixed(4)}-${overlapEnd.toFixed(4)}`;
          if (!seen.has(key)) {
            seen.add(key);
            const existing = boundaries.find(
              (bd) =>
                bd.direction === "horizontal" &&
                Math.abs(bd.position - bBottom) < EPSILON &&
                Math.abs(bd.start - overlapStart) < EPSILON &&
                Math.abs(bd.end - overlapEnd) < EPSILON,
            );
            if (existing) {
              pushUnique(existing.leftPaneIndices, j);
              pushUnique(existing.rightPaneIndices, i);
            } else {
              boundaries.push({
                direction: "horizontal",
                position: bBottom,
                leftPaneIndices: [j],
                rightPaneIndices: [i],
                start: overlapStart,
                end: overlapEnd,
              });
            }
          }
        }
      }
    }
  }

  return mergeBoundarySegments(boundaries);
}

/**
 * Calculate clamped resize delta to enforce minimum pane size.
 * @param boundary The boundary being dragged
 * @param rawDelta Raw delta in ratio (0.0-1.0)
 * @param panes Current panes (for min-size clamping)
 * @returns Clamped delta
 */
export function calcResizeDelta(
  boundary: PaneBoundary,
  rawDelta: number,
  panes?: GridRect[],
): number {
  if (!panes) return rawDelta;

  let delta = rawDelta;

  // For positive delta (moving boundary right/down):
  // Right/bottom panes get smaller — clamp so they don't go below min
  if (delta > 0) {
    for (const idx of boundary.rightPaneIndices) {
      const p = panes[idx];
      const currentSize = boundary.direction === "vertical" ? p.w : p.h;
      const maxDelta = Math.max(0, currentSize - PANE_MIN_RATIO);
      if (delta > maxDelta) delta = maxDelta;
    }
  }

  // For negative delta (moving boundary left/up):
  // Left/top panes get smaller — clamp
  if (delta < 0) {
    for (const idx of boundary.leftPaneIndices) {
      const p = panes[idx];
      const currentSize = boundary.direction === "vertical" ? p.w : p.h;
      const maxDelta = -Math.max(0, currentSize - PANE_MIN_RATIO);
      if (delta < maxDelta) delta = maxDelta;
    }
  }

  return delta;
}

/** One pane's new absolute rect fields, shaped for `resizePane(index, rect)`. */
export type PaneResizeUpdate = { index: number; rect: Partial<GridRect> };

/** Axis a resize request targets: `w` moves a vertical boundary, `h` a horizontal one. */
export type PaneResizeAxis = "w" | "h";

export type PaneResizePlan =
  | { ok: true; updates: PaneResizeUpdate[] }
  | { ok: false; error: string };

/**
 * Translate a boundary move into per-pane absolute rects: the left/top group
 * grows by `delta`, the right/bottom group shifts by the same amount and gives
 * up the same size. The two sides stay flush, so panes can neither overlap nor
 * leave a gap. `rawDelta` is clamped by {@link calcResizeDelta} first.
 *
 * This is the single owner of the "move a boundary" verdict — both the drag
 * handles and the automation `panes.resize` action go through it (issue #590).
 */
export function boundaryResizeUpdates(
  boundary: PaneBoundary,
  rawDelta: number,
  panes: GridRect[],
): PaneResizeUpdate[] {
  const delta = calcResizeDelta(boundary, rawDelta, panes);
  if (Math.abs(delta) < EPSILON) return [];

  const vertical = boundary.direction === "vertical";
  const updates: PaneResizeUpdate[] = [];

  for (const index of boundary.leftPaneIndices) {
    const p = panes[index];
    updates.push({ index, rect: vertical ? { w: p.w + delta } : { h: p.h + delta } });
  }
  for (const index of boundary.rightPaneIndices) {
    const p = panes[index];
    updates.push({
      index,
      rect: vertical ? { x: p.x + delta, w: p.w - delta } : { y: p.y + delta, h: p.h - delta },
    });
  }

  return updates;
}

/** Apply {@link PaneResizeUpdate}s to a pane list, returning a new array. */
export function applyPaneResizeUpdates<T extends GridRect>(
  panes: T[],
  updates: PaneResizeUpdate[],
): T[] {
  if (updates.length === 0) return panes;
  const next = [...panes];
  for (const { index, rect } of updates) next[index] = { ...next[index], ...rect };
  return next;
}

/**
 * The boundary that a "resize pane N along `axis`" request has to move, plus
 * the sign converting the requested size delta into a boundary delta.
 *
 * Prefers the pane's trailing edge (right/bottom), where moving the boundary
 * outward grows the pane (`sign = 1`). A pane flush against the grid edge owns
 * no such boundary, so it falls back to its leading edge, where moving the
 * boundary toward the origin is what grows it (`sign = -1`).
 */
export function findPaneAxisBoundary(
  panes: GridRect[],
  paneIndex: number,
  axis: PaneResizeAxis,
): { boundary: PaneBoundary; sign: 1 | -1 } | null {
  if (paneIndex < 0 || paneIndex >= panes.length) return null;

  const direction = axis === "w" ? "vertical" : "horizontal";
  const boundaries = findPaneBoundaries(panes).filter((b) => b.direction === direction);

  const trailing = boundaries.find((b) => b.leftPaneIndices.includes(paneIndex));
  if (trailing) return { boundary: trailing, sign: 1 };

  const leading = boundaries.find((b) => b.rightPaneIndices.includes(paneIndex));
  if (leading) return { boundary: leading, sign: -1 };

  return null;
}

/**
 * Plan a neighbor-aware pane resize from a size delta (the automation
 * `dw`/`dh` contract). Each axis is resolved independently against the state
 * left by the previous one, so `w` and `h` never fight over the same boundary.
 *
 * Fails loudly instead of breaking the tiling: a pane that spans the full grid
 * on the requested axis has nothing to resize against.
 */
export function planPaneResize(
  panes: GridRect[],
  paneIndex: number,
  delta: { w?: number; h?: number },
): PaneResizePlan {
  if (paneIndex < 0 || paneIndex >= panes.length) {
    return { ok: false, error: `Pane index out of range (0-${panes.length - 1})` };
  }

  const axes = (["w", "h"] as const).filter((axis) => delta[axis] != null);
  if (axes.length === 0) {
    return { ok: false, error: "Resize delta requires at least one of 'w' or 'h'" };
  }

  let current: GridRect[] = panes;
  const updates: PaneResizeUpdate[] = [];

  for (const axis of axes) {
    const resolved = findPaneAxisBoundary(current, paneIndex, axis);
    if (!resolved) {
      const span = axis === "w" ? "width" : "height";
      const kind = axis === "w" ? "vertical" : "horizontal";
      return {
        ok: false,
        error: `Pane ${paneIndex} spans the full grid ${span} — no ${kind} boundary to resize against`,
      };
    }

    const axisUpdates = boundaryResizeUpdates(
      resolved.boundary,
      resolved.sign * (delta[axis] as number),
      current,
    );
    if (axisUpdates.length === 0) continue; // clamped to a no-op

    updates.push(...axisUpdates);
    current = applyPaneResizeUpdates(current, axisUpdates);
  }

  return { ok: true, updates };
}

/**
 * Check if a pane should be merged after drag ends.
 * Returns the indices of panes to remove (the side at minimum size),
 * or null if no merge should happen.
 */
export function shouldMergeOnDragEnd(boundary: PaneBoundary, panes: GridRect[]): number[] | null {
  const tolerance = PANE_MIN_RATIO + EPSILON;

  // Check if right/bottom panes are at minimum size
  const rightAtMin = boundary.rightPaneIndices.every((idx) => {
    const p = panes[idx];
    const size = boundary.direction === "vertical" ? p.w : p.h;
    return size <= tolerance;
  });

  if (rightAtMin) {
    return boundary.rightPaneIndices;
  }

  // Check if left/top panes are at minimum size
  const leftAtMin = boundary.leftPaneIndices.every((idx) => {
    const p = panes[idx];
    const size = boundary.direction === "vertical" ? p.w : p.h;
    return size <= tolerance;
  });

  if (leftAtMin) {
    return boundary.leftPaneIndices;
  }

  return null;
}
