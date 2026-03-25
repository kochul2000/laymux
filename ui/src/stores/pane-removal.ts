/**
 * Pure utility for removing a pane and redistributing its space to adjacent panes.
 *
 * Algorithm:
 * For each of 4 directions (top, bottom, left, right), find panes adjacent to the
 * removed pane on that side. If those panes together tile the removed pane's full
 * edge AND each fits within the removed pane's perpendicular extent, they can
 * expand to absorb the removed space. Among valid directions, prefer the one
 * involving the fewest pane modifications.
 */

const EPSILON = 0.001;

interface PaneRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Direction = "top" | "bottom" | "left" | "right";

/**
 * Find pane indices adjacent to `removed` in the given direction,
 * where each adjacent pane fits entirely within the removed pane's
 * perpendicular extent.
 */
function findAdjacentIndices(
  removed: PaneRect,
  remaining: PaneRect[],
  direction: Direction,
): number[] {
  const indices: number[] = [];

  for (let i = 0; i < remaining.length; i++) {
    const p = remaining[i];

    switch (direction) {
      case "top":
        // Panes above: their bottom edge meets removed's top edge
        if (
          Math.abs(p.y + p.h - removed.y) < EPSILON &&
          p.x >= removed.x - EPSILON &&
          p.x + p.w <= removed.x + removed.w + EPSILON
        ) {
          indices.push(i);
        }
        break;

      case "bottom":
        // Panes below: their top edge meets removed's bottom edge
        if (
          Math.abs(p.y - (removed.y + removed.h)) < EPSILON &&
          p.x >= removed.x - EPSILON &&
          p.x + p.w <= removed.x + removed.w + EPSILON
        ) {
          indices.push(i);
        }
        break;

      case "left":
        // Panes to the left: their right edge meets removed's left edge
        if (
          Math.abs(p.x + p.w - removed.x) < EPSILON &&
          p.y >= removed.y - EPSILON &&
          p.y + p.h <= removed.y + removed.h + EPSILON
        ) {
          indices.push(i);
        }
        break;

      case "right":
        // Panes to the right: their left edge meets removed's right edge
        if (
          Math.abs(p.x - (removed.x + removed.w)) < EPSILON &&
          p.y >= removed.y - EPSILON &&
          p.y + p.h <= removed.y + removed.h + EPSILON
        ) {
          indices.push(i);
        }
        break;
    }
  }

  return indices;
}

/**
 * Check if the adjacent panes together tile the full edge of the removed pane
 * (no gaps in coverage).
 */
function coversFullEdge(
  adjacentPanes: PaneRect[],
  removed: PaneRect,
  direction: Direction,
): boolean {
  if (adjacentPanes.length === 0) return false;

  if (direction === "left" || direction === "right") {
    // Must cover removed's full vertical extent [removed.y, removed.y + removed.h]
    const sorted = [...adjacentPanes].sort((a, b) => a.y - b.y);
    let covered = removed.y;
    for (const p of sorted) {
      if (p.y > covered + EPSILON) return false; // gap
      covered = Math.max(covered, p.y + p.h);
    }
    return covered >= removed.y + removed.h - EPSILON;
  } else {
    // Must cover removed's full horizontal extent [removed.x, removed.x + removed.w]
    const sorted = [...adjacentPanes].sort((a, b) => a.x - b.x);
    let covered = removed.x;
    for (const p of sorted) {
      if (p.x > covered + EPSILON) return false; // gap
      covered = Math.max(covered, p.x + p.w);
    }
    return covered >= removed.x + removed.w - EPSILON;
  }
}

/**
 * Remove a pane and redistribute its space to adjacent panes.
 * Returns the updated pane list, or null if removal is not possible.
 *
 * Does NOT mutate the input array.
 */
export function removePaneAndRedistribute<T extends PaneRect>(
  panes: readonly T[],
  removeIndex: number,
): T[] | null {
  if (panes.length <= 1) return null;
  if (removeIndex < 0 || removeIndex >= panes.length) return null;

  const removed = panes[removeIndex];
  const remaining = panes.filter((_, i) => i !== removeIndex).map((p) => ({ ...p }));

  // Try each direction, collect valid expansion options
  const directions: Direction[] = ["top", "bottom", "left", "right"];
  let bestDirection: Direction | null = null;
  let bestIndices: number[] = [];
  let bestCount = Infinity;

  for (const dir of directions) {
    const adjIndices = findAdjacentIndices(removed, remaining, dir);
    if (adjIndices.length === 0) continue;

    const adjPanes = adjIndices.map((i) => remaining[i]);
    if (coversFullEdge(adjPanes, removed, dir)) {
      if (adjIndices.length < bestCount) {
        bestCount = adjIndices.length;
        bestDirection = dir;
        bestIndices = adjIndices;
      }
    }
  }

  if (bestDirection === null) {
    // Fallback: no clean direction found.
    // Pick closest pane and do best-effort bounding box expansion.
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const p = remaining[i];
      const dist = Math.abs(p.x - removed.x) + Math.abs(p.y - removed.y);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    const absorber = remaining[bestIdx];
    const newX = Math.min(absorber.x, removed.x);
    const newY = Math.min(absorber.y, removed.y);
    absorber.w = Math.max(absorber.x + absorber.w, removed.x + removed.w) - newX;
    absorber.h = Math.max(absorber.y + absorber.h, removed.y + removed.h) - newY;
    absorber.x = newX;
    absorber.y = newY;
    return remaining;
  }

  // Apply expansion to all adjacent panes in the chosen direction
  for (const idx of bestIndices) {
    const p = remaining[idx];
    switch (bestDirection) {
      case "top":
        // Expand downward: increase height by removed's height
        p.h += removed.h;
        break;
      case "bottom":
        // Expand upward: move y up and increase height
        p.y = removed.y;
        p.h += removed.h;
        break;
      case "left":
        // Expand rightward: increase width
        p.w += removed.w;
        break;
      case "right":
        // Expand leftward: move x left and increase width
        p.x = removed.x;
        p.w += removed.w;
        break;
    }
  }

  return remaining;
}
