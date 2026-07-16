import { findNextVisibleWorkspaceId } from "@/lib/hidden-items";
import { sortWorkspaces } from "@/lib/workspace-sort";
import { useNotificationStore } from "@/stores/notification-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useUiStore } from "@/stores/ui-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

export interface SetWorkspaceHiddenResult {
  hidden: boolean;
  blocked: boolean;
  fallbackWorkspaceId: string | null;
}

function getOrderedWorkspaces() {
  const workspaceState = useWorkspaceStore.getState();
  return sortWorkspaces(
    workspaceState.workspaces,
    useSettingsStore.getState().workspaceSelector.sortOrder,
    workspaceState.workspaceDisplayOrder,
    useNotificationStore.getState().notifications,
  );
}

/**
 * Apply workspace hidden state while preserving the active-workspace invariant.
 * Both desktop quick actions and Automation compatibility toggles use this path.
 */
export function setWorkspaceHiddenWithFallback(
  workspaceId: string,
  hidden: boolean,
): SetWorkspaceHiddenResult {
  const workspaceState = useWorkspaceStore.getState();
  const workspace = workspaceState.workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) return { hidden: false, blocked: true, fallbackWorkspaceId: null };

  let fallbackWorkspaceId: string | null = null;
  if (hidden && workspaceState.activeWorkspaceId === workspaceId) {
    fallbackWorkspaceId = findNextVisibleWorkspaceId({
      orderedWorkspaces: getOrderedWorkspaces(),
      activeWorkspaceId: workspaceId,
      hiddenWorkspaceIds: useUiStore.getState().hiddenWorkspaceIds,
    });
    if (!fallbackWorkspaceId) {
      return { hidden: false, blocked: true, fallbackWorkspaceId: null };
    }
    // Switch first so active content never disappears between store transitions.
    workspaceState.setActiveWorkspace(fallbackWorkspaceId);
  }

  useUiStore.getState().setWorkspaceHidden(
    workspaceId,
    hidden,
    workspace.panes.map((pane) => pane.id),
  );
  return { hidden, blocked: false, fallbackWorkspaceId };
}

/** Repair raw state loaded or injected outside the coordinated action path. */
export function ensureActiveWorkspaceVisible(): void {
  const workspaceState = useWorkspaceStore.getState();
  const uiState = useUiStore.getState();
  const activeId = workspaceState.activeWorkspaceId;
  if (!uiState.hiddenWorkspaceIds.has(activeId)) return;

  const fallbackWorkspaceId = findNextVisibleWorkspaceId({
    orderedWorkspaces: getOrderedWorkspaces(),
    activeWorkspaceId: activeId,
    hiddenWorkspaceIds: uiState.hiddenWorkspaceIds,
  });
  if (fallbackWorkspaceId) {
    workspaceState.setActiveWorkspace(fallbackWorkspaceId);
    return;
  }

  const activeWorkspace = workspaceState.workspaces.find((workspace) => workspace.id === activeId);
  uiState.setWorkspaceHidden(activeId, false, activeWorkspace?.panes.map((pane) => pane.id) ?? []);
}
