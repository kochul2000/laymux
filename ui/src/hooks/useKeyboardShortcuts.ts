import { useEffect } from "react";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useDockStore } from "@/stores/dock-store";
import { useGridStore } from "@/stores/grid-store";
import { useNotificationStore } from "@/stores/notification-store";
import { useUiStore } from "@/stores/ui-store";
import { useSettingsStore } from "@/stores/settings-store";
import { findPaneInDirection, type Direction } from "@/lib/pane-navigation";
import { findNotificationNavTarget } from "@/lib/notification-navigation";
import { getDockForDirection, getDockExitDirection } from "@/lib/dock-navigation";

const ARROW_TO_DIRECTION: Record<string, Direction> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

/** Switch workspace and focus the first pane (clear dock focus). */
function switchWorkspace(id: string) {
  useWorkspaceStore.getState().setActiveWorkspace(id);
  useDockStore.getState().setFocusedDock(null);
  const { focusedPaneIndex, setFocusedPane } = useGridStore.getState();
  if (focusedPaneIndex === null) {
    setFocusedPane(0);
  }
}

/** Navigate to a pane by notification direction, consuming matched notifications. */
function navigateByNotification(direction: "recent" | "oldest") {
  const { notifications, markNotificationsAsRead } = useNotificationStore.getState();
  const target = findNotificationNavTarget(notifications, direction);
  if (!target) return;

  // Switch workspace if needed
  useWorkspaceStore.getState().setActiveWorkspace(target.workspaceId);
  useDockStore.getState().setFocusedDock(null);

  // Find the pane index from terminalId (terminal-{paneId} pattern)
  const paneId = target.terminalId.replace(/^terminal-/, "");
  const ws = useWorkspaceStore.getState().getActiveWorkspace();
  if (ws) {
    const paneIndex = ws.panes.findIndex((p) => p.id === paneId);
    useGridStore.getState().setFocusedPane(paneIndex >= 0 ? paneIndex : 0);
  }

  // Mark target notifications as read so next navigation advances.
  // In workspace/paneFocus dismiss modes, auto-dismiss also fires (harmless overlap).
  // In manual mode, this is the only dismissal path.
  markNotificationsAsRead(target.notificationIds);
}

export function useKeyboardShortcuts() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Delete key: remove focused pane in edit mode (no modifier required)
      if (e.key === "Delete") {
        const { editMode, focusedPaneIndex } = useGridStore.getState();
        if (editMode && focusedPaneIndex !== null) {
          e.preventDefault();
          useWorkspaceStore.getState().removePane(focusedPaneIndex);
        }
        return;
      }

      // Alt+Arrow: pane navigation (workspace + dock)
      if (e.altKey && !e.ctrlKey && !e.shiftKey) {
        const direction = ARROW_TO_DIRECTION[e.key];
        if (direction) {
          e.preventDefault();
          const dockStore = useDockStore.getState();
          const { focusedDock } = dockStore;
          const dockArrowNav = useSettingsStore.getState().convenience.dockArrowNav;

          // If currently focused on a dock, try to exit it
          if (focusedDock !== null) {
            const exitDir = getDockExitDirection(focusedDock);
            if (direction === exitDir) {
              // Exit dock → go back to workspace
              dockStore.setFocusedDock(null);
              const { focusedPaneIndex, setFocusedPane } = useGridStore.getState();
              if (focusedPaneIndex === null) setFocusedPane(0);
              return;
            }
            // Other directions while in dock: try to navigate to another dock.
            // Note: pressing the same direction as the dock's own side (e.g., ArrowLeft
            // in Left Dock) is intentionally a no-op — there's nothing further in that direction.
            if (dockArrowNav) {
              const targetDock = getDockForDirection(direction);
              const targetState = dockStore.getDock(targetDock);
              if (
                targetState?.visible &&
                targetState.panes.length > 0 &&
                targetDock !== focusedDock
              ) {
                dockStore.setFocusedDock(targetDock);
                return;
              }
            }
            return;
          }

          // Currently in workspace: try pane navigation first
          const ws = useWorkspaceStore.getState().getActiveWorkspace();
          if (!ws) return;
          const { focusedPaneIndex, setFocusedPane } = useGridStore.getState();
          const current = focusedPaneIndex ?? 0;
          const next = findPaneInDirection(ws.panes, current, direction);
          if (next !== null) {
            setFocusedPane(next);
            dockStore.setFocusedDock(null);
          } else if (dockArrowNav) {
            // No pane in that direction → try to enter a dock
            const targetDock = getDockForDirection(direction);
            const targetState = dockStore.getDock(targetDock);
            if (targetState?.visible && targetState.panes.length > 0) {
              dockStore.setFocusedDock(targetDock);
              useGridStore.getState().setFocusedPane(null);
            }
          }
          return;
        }
      }

      if (!e.ctrlKey) return;

      const { workspaces, activeWorkspaceId, removeWorkspace, renameWorkspace } =
        useWorkspaceStore.getState();

      // Ctrl+Shift shortcuts (non-workspace: sidebar, notifications)
      if (e.shiftKey && !e.altKey) {
        const shiftKey = e.key.toUpperCase();

        // Ctrl+Shift+U: jump to most recent unread notification workspace
        if (shiftKey === "U") {
          e.preventDefault();
          const { notifications } = useNotificationStore.getState();
          const unread = [...notifications].reverse().find((n) => n.readAt === null);
          if (unread) {
            switchWorkspace(unread.workspaceId);
          }
          return;
        }

        // Ctrl+Shift+B: toggle sidebar
        if (shiftKey === "B") {
          e.preventDefault();
          useDockStore.getState().toggleDockVisible("left");
          return;
        }

        // Ctrl+Shift+I: toggle notification panel
        if (shiftKey === "I") {
          e.preventDefault();
          useUiStore.getState().toggleNotificationPanel();
          return;
        }

        return;
      }

      // Ctrl+Alt shortcuts (all workspace operations)
      if (e.altKey && !e.shiftKey) {
        const altKey = e.key.toUpperCase();

        // Ctrl+Alt+N: new workspace with default (first) layout
        if (altKey === "N") {
          e.preventDefault();
          const { layouts, addWorkspace } = useWorkspaceStore.getState();
          const defaultLayout = layouts[0];
          if (defaultLayout) {
            const wsCount = workspaces.length;
            addWorkspace(`Workspace ${wsCount + 1}`, defaultLayout.id);
            const updated = useWorkspaceStore.getState().workspaces;
            const newWs = updated[updated.length - 1];
            if (newWs) switchWorkspace(newWs.id);
          }
          return;
        }

        // Ctrl+Alt+D: duplicate current workspace
        if (altKey === "D") {
          e.preventDefault();
          const { duplicateWorkspace } = useWorkspaceStore.getState();
          duplicateWorkspace(activeWorkspaceId);
          const updated = useWorkspaceStore.getState().workspaces;
          const newWs = updated[updated.length - 1];
          if (newWs) switchWorkspace(newWs.id);
          return;
        }

        // Ctrl+Alt+W: close current workspace
        if (altKey === "W") {
          e.preventDefault();
          if (workspaces.length > 1) {
            removeWorkspace(activeWorkspaceId);
          }
          return;
        }

        // Ctrl+Alt+R: rename current workspace
        if (altKey === "R") {
          e.preventDefault();
          const current = workspaces.find((ws) => ws.id === activeWorkspaceId);
          if (current) {
            const newName = window.prompt("Rename workspace:", current.name);
            if (newName !== null && newName.trim() !== "") {
              renameWorkspace(activeWorkspaceId, newName.trim());
            }
          }
          return;
        }

        // Ctrl+Alt+1~8: switch workspace by index
        if (e.key >= "1" && e.key <= "8") {
          e.preventDefault();
          const idx = parseInt(e.key) - 1;
          if (idx < workspaces.length) {
            switchWorkspace(workspaces[idx].id);
          }
          return;
        }

        // Ctrl+Alt+9: last workspace
        if (e.key === "9") {
          e.preventDefault();
          const last = workspaces.at(-1);
          if (last) switchWorkspace(last.id);
          return;
        }

        // Ctrl+Alt+ArrowLeft: jump to most recent notification pane
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          navigateByNotification("recent");
          return;
        }

        // Ctrl+Alt+ArrowRight: jump to oldest notification pane
        if (e.key === "ArrowRight") {
          e.preventDefault();
          navigateByNotification("oldest");
          return;
        }

        // Ctrl+Alt+ArrowDown: next workspace
        if (e.key === "ArrowDown") {
          e.preventDefault();
          const currentIdx = workspaces.findIndex((ws) => ws.id === activeWorkspaceId);
          const nextIdx = (currentIdx + 1) % workspaces.length;
          switchWorkspace(workspaces[nextIdx].id);
          return;
        }

        // Ctrl+Alt+ArrowUp: previous workspace
        if (e.key === "ArrowUp") {
          e.preventDefault();
          const currentIdx = workspaces.findIndex((ws) => ws.id === activeWorkspaceId);
          const prevIdx = (currentIdx - 1 + workspaces.length) % workspaces.length;
          switchWorkspace(workspaces[prevIdx].id);
          return;
        }

        return;
      }

      // Ctrl+,: toggle settings modal
      if (e.key === ",") {
        e.preventDefault();
        useUiStore.getState().toggleSettingsModal();
        return;
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);
}
