import { findNotificationNavTarget } from "@/lib/notification-navigation";
import { paneNumberFor } from "@/lib/pane-numbers";
import {
  buildSpatialOrder,
  findSpatialStepTarget,
  type SpatialDirection,
} from "@/lib/spatial-navigation";
import { filterVisibleWorkspaces, sortWorkspaces } from "@/lib/workspace-sort";
import { useDockStore } from "@/stores/dock-store";
import { useGridStore } from "@/stores/grid-store";
import { useNotificationStore } from "@/stores/notification-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useUiStore } from "@/stores/ui-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

/**
 * Shared step-navigation orchestration (issue #474, ADR-0039, ADR-0046).
 *
 * Notification navigation is shared with desktop keyboard shortcuts. Spatial
 * navigation is a Remote-only action and applies the controlling Remote
 * client's surface-local pane exclusions.
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
        | "no_unread_notifications";
    };

const toTerminalId = (paneId: string) => `terminal-${paneId}`;

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
): NavigationStepResult {
  const { workspaces, visibleWorkspaces } = getSortedWorkspaces();
  const entries = buildSpatialOrder(visibleWorkspaces, excludedPaneIds);
  if (entries.length === 0) {
    const hasEligiblePane =
      excludedPaneIds.size > 0 && buildSpatialOrder(visibleWorkspaces).length > 0;
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
    if (focusedPane) anchorPaneNumber = paneNumberFor(activeWorkspace.panes, focusedPane.id);
  }

  const target = findSpatialStepTarget(
    entries,
    workspaces.map((ws) => ws.id),
    { workspaceId: activeWorkspaceId, paneNumber: anchorPaneNumber },
    direction,
  );
  if (!target) return { moved: false, reason: "no_other_target" };

  const switchedWorkspace = target.workspaceId !== activeWorkspaceId;
  workspaceState.setActiveWorkspace(target.workspaceId);
  useDockStore.getState().setFocusedDock(null);
  useGridStore.getState().setFocusedPane(target.paneIndex);

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

  // Switch workspace if needed
  useWorkspaceStore.getState().setActiveWorkspace(target.workspaceId);
  useDockStore.getState().setFocusedDock(null);

  // Find the pane index from terminalId (terminal-{paneId} pattern)
  const paneId = target.terminalId.replace(/^terminal-/, "");
  const ws = useWorkspaceStore.getState().getActiveWorkspace();
  let paneIndex = 0;
  let paneNumber: number | null = null;
  if (ws) {
    const idx = ws.panes.findIndex((p) => p.id === paneId);
    paneIndex = idx >= 0 ? idx : 0;
    useGridStore.getState().setFocusedPane(paneIndex);
    paneNumber = idx >= 0 ? paneNumberFor(ws.panes, paneId) : null;
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
