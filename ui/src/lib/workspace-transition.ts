import { resolveWorkspaceLandingPane, type WorkspaceLandingPane } from "@/lib/workspace-switch";
import { useDockStore } from "@/stores/dock-store";
import { useGridStore } from "@/stores/grid-store";
import type { DockPosition } from "@/stores/types";
import { useWorkspaceStore } from "@/stores/workspace-store";

/**
 * Outcome of a workspace transition. `switched: false` means the id does not
 * exist and no store was touched. A successful transition can still have no
 * grid landing when the workspace is empty or dock focus is preserved.
 */
export type WorkspaceSwitchResult =
  | { switched: true; landing: WorkspaceLandingPane | null }
  | { switched: false; reason: "workspace_not_found" };

export interface WorkspaceSwitchOptions {
  /** Keep an existing dock focus instead of transferring ownership to the grid. */
  preserveDockFocus?: boolean;
}

/**
 * Focus an exact pane in a workspace.
 *
 * The target is validated before any store is touched, then workspace, dock
 * and grid focus are committed together. Callers must not reproduce this
 * three-store transition in UI event handlers or transport adapters.
 */
export function focusWorkspacePane(workspaceId: string, paneIndex: number): boolean {
  const workspaceState = useWorkspaceStore.getState();
  const workspace = workspaceState.workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace || !Number.isInteger(paneIndex) || !workspace.panes[paneIndex]) return false;

  workspaceState.setActiveWorkspace(workspaceId);
  useDockStore.getState().setFocusedDock(null);
  useGridStore.getState().setFocusedPane(paneIndex);
  return true;
}

/** Focus an exact dock pane and relinquish workspace-grid focus. */
export function focusDockPane(position: DockPosition, paneId?: string): boolean {
  const dockState = useDockStore.getState();
  const dock = dockState.getDock(position);
  const resolvedPaneId = paneId ?? dock?.panes[0]?.id;
  if (!resolvedPaneId || !dock?.panes.some((pane) => pane.id === resolvedPaneId)) {
    return false;
  }

  dockState.setFocusedDock(position, resolvedPaneId);
  useGridStore.getState().setFocusedPane(null);
  return true;
}

/**
 * Atomically activate a workspace and resolve the pane-focus owner.
 *
 * This is the single stateful workspace transition entry point. UI event
 * handlers, keyboard navigation and Automation/Remote adapters call it instead
 * of coordinating workspace, dock and grid stores independently.
 */
export function switchActiveWorkspace(
  workspaceId: string,
  options: WorkspaceSwitchOptions = {},
): WorkspaceSwitchResult {
  const workspaceState = useWorkspaceStore.getState();
  const targetWorkspace = workspaceState.workspaces.find(
    (workspace) => workspace.id === workspaceId,
  );
  if (!targetWorkspace) return { switched: false, reason: "workspace_not_found" };

  const wasDockFocused = useDockStore.getState().focusedDock !== null;
  workspaceState.setActiveWorkspace(workspaceId);

  if (options.preserveDockFocus && wasDockFocused) {
    return { switched: true, landing: null };
  }

  useDockStore.getState().setFocusedDock(null);
  const landing = resolveWorkspaceLandingPane(targetWorkspace.panes, {
    wasDockFocused,
    focusedPaneIndex: useGridStore.getState().focusedPaneIndex,
  });
  useGridStore.getState().setFocusedPane(landing ? landing.paneIndex : null);
  return { switched: true, landing };
}
