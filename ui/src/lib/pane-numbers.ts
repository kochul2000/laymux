/**
 * Spatial pane numbering (issue #256).
 *
 * Assigns each pane a 1-based **paneNumber** in screen reading order
 * (top-to-bottom, then left-to-right). This is a stateless derived value used
 * for display (control bar badge) and for humans/AIs to refer to a pane by a
 * short number ("send to pane 3").
 *
 * IMPORTANT: paneNumber is NOT the array index (`paneIndex`). The
 * `WorkspacePane[]` array order depends on split insertion order and can
 * diverge from the visual reading order. Layout-manipulation tools keep using
 * the array index; this module is the single source of the spatial number.
 * Never cache the result — it is derived purely from pane geometry and is
 * recomputed whenever the layout changes.
 */

/** Minimal shape needed to compute a spatial number. Both `WorkspacePane` and `GridPane` satisfy it. */
export interface NumberablePane {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Floating-point tolerance for normalized (0-1) grid geometry comparisons.
 * Two coordinates within this epsilon are treated as equal (same row/edge).
 * Shared by the spatial numbering here and the neighbor adjacency logic in
 * `useAutomationBridge.ts` (`rangesOverlap`, edge-meeting checks) so the two
 * stay in lockstep instead of duplicating a magic number.
 */
export const GRID_EPS = 0.01;

/**
 * Compute the spatial reading-order number (1..N) for each pane.
 * Sort by y ascending; panes within EPS on y are the same row, sorted by x ascending.
 * Returns a map of paneId -> number. Does not mutate the input.
 */
export function computePaneNumbers(panes: readonly NumberablePane[]): Map<string, number> {
  const sorted = [...panes].sort((a, b) => {
    if (Math.abs(a.y - b.y) < GRID_EPS) return a.x - b.x;
    return a.y - b.y;
  });

  const numbers = new Map<string, number>();
  sorted.forEach((pane, i) => numbers.set(pane.id, i + 1));
  return numbers;
}

/** Convenience: the spatial number for a single pane id, or null if not found. */
export function paneNumberFor(panes: readonly NumberablePane[], paneId: string): number | null {
  return computePaneNumbers(panes).get(paneId) ?? null;
}
