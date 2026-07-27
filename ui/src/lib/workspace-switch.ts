import type { WorkspacePane } from "@/stores/types";

import { computePaneNumbers } from "./pane-numbers";

/**
 * Workspace-switch landing rules (issue #311, issue #578).
 *
 * `focusedPaneIndex` in the grid store is a single global index interpreted
 * against whichever workspace is active, so it is meaningless the moment the
 * active workspace changes: the old index can point at a different pane in the
 * target workspace, or past its last pane. Every switch therefore has to
 * re-resolve the landing pane instead of inheriting the raw index.
 *
 * These functions are pure so both switch paths — desktop keyboard shortcuts
 * and the Automation/Remote `workspaces.switchActive` action — land by the same
 * rule instead of each re-deriving it (ADR-0005).
 */

export interface WorkspaceLandingInput {
  /** Whether a dock pane held focus before the switch (no valid grid index then). */
  wasDockFocused: boolean;
  /** The grid store's index, still describing the *previous* workspace. */
  focusedPaneIndex: number | null;
  /** Pane count of the workspace being switched to. */
  paneCount: number;
}

/**
 * The pane index to focus after switching, or null when the target workspace
 * has no pane to focus.
 *
 * A switch always ends on a valid focused pane: with no usable reference (dock
 * focus or nothing focused) it lands on the first pane, and an index that falls
 * outside the target workspace is clamped to its last pane (#311). Otherwise
 * the current position is kept.
 */
export function resolveWorkspaceLandingPaneIndex({
  wasDockFocused,
  focusedPaneIndex,
  paneCount,
}: WorkspaceLandingInput): number | null {
  if (paneCount <= 0) return null;
  if (wasDockFocused || focusedPaneIndex === null || focusedPaneIndex < 0) return 0;
  return Math.min(focusedPaneIndex, paneCount - 1);
}

export interface WorkspaceLandingPane {
  paneIndex: number;
  paneId: string;
  /** Spatial reading-order number of the landing pane — same numbering as the pane badge. */
  paneNumber: number | null;
  /** Deterministic terminal id, or null when the landing pane is not a TerminalView. */
  terminalId: string | null;
}

/**
 * Resolve the landing pane of a switch into `panes` together with the terminal
 * the surface will attach to. `terminalId` is the deterministic
 * `terminal-<paneId>` handle, which exists as a session only once the pane has
 * been mounted — callers that must attach to it wait for session readiness.
 */
export function resolveWorkspaceLandingPane(
  panes: readonly WorkspacePane[],
  input: Omit<WorkspaceLandingInput, "paneCount">,
): WorkspaceLandingPane | null {
  const paneIndex = resolveWorkspaceLandingPaneIndex({ ...input, paneCount: panes.length });
  if (paneIndex === null) return null;
  const pane = panes[paneIndex];
  if (!pane) return null;
  return {
    paneIndex,
    paneId: pane.id,
    paneNumber: computePaneNumbers(panes).get(pane.id) ?? null,
    terminalId: pane.view.type === "TerminalView" ? `terminal-${pane.id}` : null,
  };
}
