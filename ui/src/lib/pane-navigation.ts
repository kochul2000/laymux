export type Direction = "left" | "right" | "up" | "down";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Find the pane index in the given direction from the current pane.
 * Uses center-to-center distance with directional filtering.
 * Returns null if no pane exists in that direction.
 */
export function findPaneInDirection(
  panes: Rect[],
  currentIndex: number,
  direction: Direction,
): number | null {
  if (currentIndex < 0 || currentIndex >= panes.length) return null;

  const current = panes[currentIndex];
  const cx = current.x + current.w / 2;
  const cy = current.y + current.h / 2;

  let bestIndex: number | null = null;
  let bestDist = Infinity;

  for (let i = 0; i < panes.length; i++) {
    if (i === currentIndex) continue;

    const p = panes[i];
    const px = p.x + p.w / 2;
    const py = p.y + p.h / 2;

    // Filter: candidate must be in the correct direction
    const isInDirection =
      direction === "left"
        ? px < cx
        : direction === "right"
          ? px > cx
          : direction === "up"
            ? py < cy
            : /* down */ py > cy;

    if (!isInDirection) continue;

    // Prefer candidates that share an edge along the cross axis.
    // For left/right: vertical overlap; for up/down: horizontal overlap.
    const isHorizontal = direction === "left" || direction === "right";
    const overlap = isHorizontal
      ? Math.max(0, Math.min(current.y + current.h, p.y + p.h) - Math.max(current.y, p.y))
      : Math.max(0, Math.min(current.x + current.w, p.x + p.w) - Math.max(current.x, p.x));
    const hasOverlap = overlap > 0.001;

    const primary = isHorizontal ? Math.abs(px - cx) : Math.abs(py - cy);
    const secondary = isHorizontal ? Math.abs(py - cy) : Math.abs(px - cx);

    // Panes without cross-axis overlap get a large penalty
    const dist = primary + (hasOverlap ? secondary * 0.1 : secondary + 10);

    if (dist < bestDist) {
      bestDist = dist;
      bestIndex = i;
    }
  }

  return bestIndex;
}
