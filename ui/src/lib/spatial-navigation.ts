import type { Workspace } from "@/stores/types";

import { computePaneNumbers } from "./pane-numbers";

/**
 * Global spatial pane order (issue #474, ADR-0039, ADR-0046).
 *
 * Defines the single 1D traversal used by remote step navigation:
 * (visible workspaces in display order) × (terminal panes in paneNumber order),
 * walked cyclically. Remote-client exclusions are removed from that order;
 * with no exclusions every eligible pane remains included. Hidden workspaces
 * contribute no entries but can still act as an anchor (the active workspace
 * may be hidden); non-terminal panes are excluded because the remote viewport
 * cannot attach to them.
 */

export interface SpatialEntry {
  workspaceId: string;
  workspaceName: string;
  paneId: string;
  /** Original WorkspacePane[] index (grid focus index), not the sorted position. */
  paneIndex: number;
  /** Spatial reading-order number — same numbering as the pane badge. */
  paneNumber: number;
}

export type SpatialDirection = "prev" | "next";

/**
 * Where the walk starts. `paneNumber` is the focused pane's spatial number
 * (valid for non-terminal panes too), or null when nothing in the grid is
 * focused (dock focus, empty workspace).
 */
export interface SpatialAnchor {
  workspaceId: string;
  paneNumber: number | null;
}

/**
 * Flatten visible workspaces into the global remote spatial order.
 * Pane numbers are computed over ALL panes of a workspace (badge consistency)
 * and non-terminal panes are then dropped from the traversal. The optional
 * exclusion set is a denylist supplied by the Remote client: missing and stale
 * ids have no effect, while every matching pane is removed.
 */
export function buildSpatialOrder(
  visibleWorkspaces: readonly Workspace[],
  excludedPaneIds?: ReadonlySet<string>,
): SpatialEntry[] {
  const entries: SpatialEntry[] = [];
  for (const workspace of visibleWorkspaces) {
    const numbers = computePaneNumbers(workspace.panes);
    workspace.panes
      .map((pane, paneIndex) => ({ pane, paneIndex }))
      .filter(({ pane }) => pane.view.type === "TerminalView")
      .sort((a, b) => (numbers.get(a.pane.id) ?? 0) - (numbers.get(b.pane.id) ?? 0))
      .forEach(({ pane, paneIndex }) => {
        entries.push({
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          paneId: pane.id,
          paneIndex,
          paneNumber: numbers.get(pane.id) ?? 0,
        });
      });
  }
  if (!excludedPaneIds || excludedPaneIds.size === 0) return entries;
  return entries.filter((entry) => !excludedPaneIds.has(entry.paneId));
}

/**
 * Resolve the landing entry for one step from `anchor` in `direction`.
 *
 * `entries` must be in global spatial order (from `buildSpatialOrder`).
 * `workspaceOrder` is the FULL sorted workspace id list (hidden included) so a
 * hidden active workspace can anchor between its visible neighbors — the same
 * rule the desktop `workspace.prev/next` cycle uses.
 *
 * Returns null when there is nowhere to go (no entries, or the anchor is the
 * only entry).
 */
export function findSpatialStepTarget(
  entries: readonly SpatialEntry[],
  workspaceOrder: readonly string[],
  anchor: SpatialAnchor,
  direction: SpatialDirection,
): SpatialEntry | null {
  const count = entries.length;
  if (count === 0) return null;

  const orderIndex = new Map(workspaceOrder.map((id, i) => [id, i]));
  const anchorOrder = orderIndex.get(anchor.workspaceId);
  if (anchorOrder === undefined) {
    // Anchor workspace vanished — restart the walk from the boundary.
    return direction === "next" ? entries[0] : entries[count - 1];
  }

  // Exact entry match — plain cyclic step.
  const exact = entries.findIndex(
    (e) => e.workspaceId === anchor.workspaceId && e.paneNumber === anchor.paneNumber,
  );
  if (exact >= 0) {
    const step = direction === "next" ? 1 : -1;
    const target = (exact + step + count) % count;
    return target === exact ? null : entries[target];
  }

  // Virtual anchor (non-terminal pane, dock/no focus, hidden workspace):
  // compare (workspaceOrderIndex, paneNumber) keys against the sorted entries.
  // A null paneNumber sorts before every pane of the anchor workspace.
  const anchorPane = anchor.paneNumber ?? Number.NEGATIVE_INFINITY;
  const isAfterAnchor = (e: SpatialEntry) => {
    const ws = orderIndex.get(e.workspaceId) ?? Number.POSITIVE_INFINITY;
    return ws !== anchorOrder ? ws > anchorOrder : e.paneNumber > anchorPane;
  };
  if (direction === "next") {
    return entries.find(isAfterAnchor) ?? entries[0];
  }
  for (let i = count - 1; i >= 0; i--) {
    if (!isAfterAnchor(entries[i])) return entries[i];
  }
  return entries[count - 1];
}
