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
  /** Stacked content (ADR-0297); each layer gets its own number. */
  layers?: readonly { id: string }[];
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
 *
 * Numbers belong to **content** (ADR-0297): a stacked workspace slot numbers
 * each of its layers consecutively in stack order, so the map is keyed by layer
 * id — never by slot id. Look a slot's visible number up with its active layer
 * id. Panes without `layers` (dock panes) are keyed by their own id.
 * Does not mutate the input.
 */
export function computePaneNumbers(panes: readonly NumberablePane[]): Map<string, number> {
  const sorted = [...panes].sort((a, b) => {
    if (Math.abs(a.y - b.y) < GRID_EPS) return a.x - b.x;
    return a.y - b.y;
  });

  const numbers = new Map<string, number>();
  let next = 1;
  for (const pane of sorted) {
    if (pane.layers && pane.layers.length > 0) {
      for (const layer of pane.layers) numbers.set(layer.id, next++);
    } else {
      numbers.set(pane.id, next++);
    }
  }
  return numbers;
}

/** Convenience: the spatial number for one content id (layer id), or null if not found. */
export function paneNumberFor(panes: readonly NumberablePane[], contentId: string): number | null {
  return computePaneNumbers(panes).get(contentId) ?? null;
}

/**
 * Build the clipboard string copied when a user clicks a pane-number badge (issue #276).
 *
 * The string identifies a pane by **workspace id + spatial pane number** — the exact
 * pair the automation bridge's `terminals.resolveByNumber` (and MCP
 * `write_to_terminal`/`read_terminal_output`/`focus_terminal`) accepts as
 * `workspace_id` + `pane_number`. So an LLM that receives this can act on it directly.
 *
 * The `lx:pane:` prefix makes it self-describing for both humans and LLMs.
 * `paneNumber` is volatile (recomputed on layout change), so the copied value is
 * a point-in-time reference, not a persistent handle.
 *
 * Example: `lx:pane:Backend:3`
 */
export function formatPaneIdentifier({
  paneNumber,
  workspaceName,
}: {
  paneNumber: number;
  workspaceName: string;
}): string {
  if (!workspaceName) {
    throw new Error("workspaceName is required");
  }
  if (/\s/.test(workspaceName)) {
    throw new Error("workspaceName must not contain whitespace");
  }
  return `lx:pane:${workspaceName}:${paneNumber}`;
}
