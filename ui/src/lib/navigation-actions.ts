import { findNotificationNavTarget } from "@/lib/notification-navigation";
import { findPaneInDirection, type Direction } from "@/lib/pane-navigation";
import { toPaneId, toTerminalId } from "@/lib/pane-ids";
import { paneNumberFor } from "@/lib/pane-numbers";
import {
  buildSpatialOrder,
  findSpatialStepTarget,
  type SpatialDirection,
} from "@/lib/spatial-navigation";
import { filterVisibleWorkspaces, sortWorkspaces } from "@/lib/workspace-sort";
import { activatePaneLayer, focusWorkspacePane } from "@/lib/workspace-transition";
import { activeLayer, findLayerEntry } from "@/lib/pane-layers";
import { useDockStore } from "@/stores/dock-store";
import { useGridStore } from "@/stores/grid-store";
import { useNotificationStore } from "@/stores/notification-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useUiStore } from "@/stores/ui-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

/**
 * Shared step-navigation orchestration (issue #474, ADR-0039, ADR-0046, ADR-0047).
 *
 * Notification navigation is shared with desktop keyboard shortcuts. Spatial
 * navigation is a Remote-only action and applies the controlling Remote
 * client's surface-local exclusions at both pane and whole-workspace
 * granularity. Direction navigation is the Remote form of the desktop
 * `pane.focus` shortcut (ADR-0269).
 */

export type NotificationDirection = "recent" | "oldest";

export interface NavigationStepTarget {
  workspaceId: string;
  workspaceName: string;
  terminalId: string;
  paneId: string;
  paneIndex: number;
  paneNumber: number | null;
  switchedWorkspace: boolean;
}

export type NavigationStepResult =
  | { moved: true; target: NavigationStepTarget; consumedNotificationIds?: string[] }
  | {
      moved: false;
      reason:
        | "no_terminal_panes"
        | "no_included_panes"
        | "no_other_target"
        | "no_focused_pane"
        | "no_unread_notifications";
    };

/** Sorted (display-order) workspaces + the visible subset, derived from current store state. */
export function getSortedWorkspaces() {
  const { workspaces: rawWorkspaces, workspaceDisplayOrder } = useWorkspaceStore.getState();
  const workspaceSortOrder = useSettingsStore.getState().workspaceSelector.sortOrder;
  const { notifications } = useNotificationStore.getState();
  const workspaces = sortWorkspaces(
    rawWorkspaces,
    workspaceSortOrder,
    workspaceDisplayOrder,
    notifications,
  );
  const { hiddenWorkspaceIds } = useUiStore.getState();
  const visibleWorkspaces = filterVisibleWorkspaces(workspaces, hiddenWorkspaceIds);
  return { workspaces, visibleWorkspaces };
}

/**
 * Step to the previous/next pane in the global spatial order, crossing
 * workspace boundaries (cyclic). Lands with dock focus cleared and the target
 * pane focused, mirroring the desktop workspace-switch invariant.
 */
export function spatialStep(
  direction: SpatialDirection,
  excludedPaneIds: ReadonlySet<string> = new Set(),
  excludedWorkspaceIds: ReadonlySet<string> = new Set(),
): NavigationStepResult {
  const { workspaces, visibleWorkspaces } = getSortedWorkspaces();
  const entries = buildSpatialOrder(visibleWorkspaces, excludedPaneIds, excludedWorkspaceIds);
  if (entries.length === 0) {
    const hasExclusions = excludedPaneIds.size > 0 || excludedWorkspaceIds.size > 0;
    const hasEligiblePane = hasExclusions && buildSpatialOrder(visibleWorkspaces).length > 0;
    return {
      moved: false,
      reason: hasEligiblePane ? "no_included_panes" : "no_terminal_panes",
    };
  }

  const workspaceState = useWorkspaceStore.getState();
  const activeWorkspaceId = workspaceState.activeWorkspaceId;
  const activeWorkspace = workspaceState.getActiveWorkspace();
  const { focusedPaneIndex } = useGridStore.getState();
  const dockFocused = useDockStore.getState().focusedDock !== null;

  let anchorPaneNumber: number | null = null;
  if (!dockFocused && activeWorkspace && focusedPaneIndex !== null) {
    const focusedPane = activeWorkspace.panes[focusedPaneIndex];
    if (focusedPane) {
      anchorPaneNumber = paneNumberFor(activeWorkspace.panes, activeLayer(focusedPane).id);
    }
  }

  const target = findSpatialStepTarget(
    entries,
    workspaces.map((ws) => ws.id),
    { workspaceId: activeWorkspaceId, paneNumber: anchorPaneNumber },
    direction,
  );
  if (!target) return { moved: false, reason: "no_other_target" };

  const switchedWorkspace = target.workspaceId !== activeWorkspaceId;
  // The target may sit on an inactive stacked layer (ADR-0297).
  activatePaneLayer(target.workspaceId, target.paneId);

  return {
    moved: true,
    target: {
      workspaceId: target.workspaceId,
      workspaceName: target.workspaceName,
      terminalId: toTerminalId(target.paneId),
      paneId: target.paneId,
      paneIndex: target.paneIndex,
      paneNumber: target.paneNumber,
      switchedWorkspace,
    },
  };
}

/**
 * Move to the terminal pane in a grid direction inside the active workspace,
 * with the same geometry as the desktop  shortcut (ADR-0269).
 * Only TerminalView panes are candidates because Remote can only show those.
 * It stops at the workspace edge, never enters a dock (ADR-0020), and ignores
 * the Remote cycle exclusions, which belong to spatialStep (ADR-0046).
 */
export function directionStep(direction: Direction): NavigationStepResult {
  const workspace = useWorkspaceStore.getState().getActiveWorkspace();
  // Direction moves between slots; each slot shows its active layer (ADR-0297).
  const terminalIndexes = (workspace?.panes ?? []).flatMap((pane, index) =>
    activeLayer(pane).view.type === "TerminalView" ? [index] : [],
  );
  if (!workspace || terminalIndexes.length === 0) {
    return { moved: false, reason: "no_terminal_panes" };
  }

  const { focusedPaneIndex } = useGridStore.getState();
  const dockFocused = useDockStore.getState().focusedDock !== null;
  const anchor =
    dockFocused || focusedPaneIndex === null ? -1 : terminalIndexes.indexOf(focusedPaneIndex);
  if (anchor < 0) return { moved: false, reason: "no_focused_pane" };

  const candidates = terminalIndexes.map((index) => workspace.panes[index]);
  const next = findPaneInDirection(candidates, anchor, direction);
  if (next === null) return { moved: false, reason: "no_other_target" };

  const paneIndex = terminalIndexes[next];
  const layer = activeLayer(workspace.panes[paneIndex]);
  focusWorkspacePane(workspace.id, paneIndex);

  return {
    moved: true,
    target: {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      terminalId: toTerminalId(layer.id),
      paneId: layer.id,
      paneIndex,
      paneNumber: paneNumberFor(workspace.panes, layer.id),
      switchedWorkspace: false,
    },
  };
}

/**
 * Navigate to a pane by notification direction, consuming matched
 * notifications. Moved verbatim from the keyboard shortcut handler — the
 * remote bridge reuses the exact same semantics (unread only, createdAt
 * order, consecutive same-terminal group consumption).
 */
export function notificationStep(direction: NotificationDirection): NavigationStepResult {
  const { notifications, markNotificationsAsRead } = useNotificationStore.getState();
  const target = findNotificationNavTarget(notifications, direction);
  if (!target) return { moved: false, reason: "no_unread_notifications" };

  const switchedWorkspace = useWorkspaceStore.getState().activeWorkspaceId !== target.workspaceId;

  // Find the pane index from terminalId (terminal-{paneId} pattern)
  const paneId = toPaneId(target.terminalId);
  const ws = useWorkspaceStore
    .getState()
    .workspaces.find((workspace) => workspace.id === target.workspaceId);
  let paneIndex = 0;
  let paneNumber: number | null = null;
  if (ws) {
    // paneId is a layer id; it may be an inactive stacked layer (ADR-0297).
    const entry = findLayerEntry(ws.panes, paneId);
    paneIndex = entry ? entry.slotIndex : 0;
    if (entry) activatePaneLayer(target.workspaceId, paneId);
    else focusWorkspacePane(target.workspaceId, paneIndex);
    paneNumber = entry ? paneNumberFor(ws.panes, paneId) : null;
  }

  // Mark target notifications as read so next navigation advances.
  // In workspace/paneFocus dismiss modes, auto-dismiss also fires (harmless overlap).
  // In manual mode, this is the only dismissal path.
  markNotificationsAsRead(target.notificationIds);

  return {
    moved: true,
    target: {
      workspaceId: target.workspaceId,
      workspaceName: ws?.name ?? "",
      terminalId: target.terminalId,
      paneId,
      paneIndex,
      paneNumber,
      switchedWorkspace,
    },
    consumedNotificationIds: target.notificationIds,
  };
}
