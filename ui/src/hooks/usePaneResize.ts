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
              if (!existing.leftPaneIndices.includes(i)) existing.leftPaneIndices.push(i);
              if (!existing.rightPaneIndices.includes(j)) existing.rightPaneIndices.push(j);
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
              if (!existing.leftPaneIndices.includes(j)) existing.leftPaneIndices.push(j);
              if (!existing.rightPaneIndices.includes(i)) existing.rightPaneIndices.push(i);
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
              if (!existing.leftPaneIndices.includes(i)) existing.leftPaneIndices.push(i);
              if (!existing.rightPaneIndices.includes(j)) existing.rightPaneIndices.push(j);
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
              if (!existing.leftPaneIndices.includes(j)) existing.leftPaneIndices.push(j);
              if (!existing.rightPaneIndices.includes(i)) existing.rightPaneIndices.push(i);
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

  return boundaries;
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
