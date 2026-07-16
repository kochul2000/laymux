import { useEffect } from "react";
import { ensureActiveWorkspaceVisible } from "@/lib/hidden-item-actions";
import { useUiStore } from "@/stores/ui-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

/**
 * Keep persisted hidden IDs and the active-workspace invariant synchronized
 * even when state changes outside WorkspaceSelectorView (Automation, restore,
 * session replacement, or workspace deletion).
 */
function reconcileHiddenItems(): void {
  const { workspaces } = useWorkspaceStore.getState();
  const validWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  const validPaneIds = new Set(
    workspaces.flatMap((workspace) => workspace.panes.map((pane) => pane.id)),
  );
  useUiStore.getState().pruneHiddenIds(validWorkspaceIds, validPaneIds);
  ensureActiveWorkspaceVisible();
}

export function useHiddenItemsCoordinator(): void {
  useEffect(() => {
    reconcileHiddenItems();

    const unsubscribeUi = useUiStore.subscribe((state, previous) => {
      if (
        state.hiddenWorkspaceIds !== previous.hiddenWorkspaceIds ||
        state.hiddenPaneIds !== previous.hiddenPaneIds
      ) {
        reconcileHiddenItems();
      }
    });
    const unsubscribeWorkspaces = useWorkspaceStore.subscribe((state, previous) => {
      if (
        state.workspaces !== previous.workspaces ||
        state.activeWorkspaceId !== previous.activeWorkspaceId ||
        state.workspaceDisplayOrder !== previous.workspaceDisplayOrder
      ) {
        reconcileHiddenItems();
      }
    });

    return () => {
      unsubscribeUi();
      unsubscribeWorkspaces();
    };
  }, []);
}
