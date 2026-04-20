import { useEffect } from "react";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useDockStore } from "@/stores/dock-store";
import { useGridStore } from "@/stores/grid-store";
import { useNotificationStore } from "@/stores/notification-store";
import { useUiStore } from "@/stores/ui-store";
import { useSettingsStore } from "@/stores/settings-store";
import { sortWorkspaces, filterVisibleWorkspaces } from "@/lib/workspace-sort";
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

/** Check if the currently focused element is a text-editable field (input, textarea, contentEditable). */
function isTextInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  // Skip xterm.js helper textarea — it's always focused when a terminal is active
  if (el instanceof HTMLElement && el.classList.contains("xterm-helper-textarea")) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  if (
    el instanceof HTMLElement &&
    (el.isContentEditable || el.getAttribute("contenteditable") === "true")
  )
    return true;
  return false;
}

export function useKeyboardShortcuts() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Delete key: remove focused pane (no modifier required)
      // Skip when a text-editable element has focus (e.g. input, textarea, contentEditable)
      if (e.key === "Delete") {
        if (isTextInputFocused()) return;
        const { focusedPaneIndex } = useGridStore.getState();
        if (focusedPaneIndex !== null) {
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

          // If currently focused on a dock, try navigation within dock panes first
          if (focusedDock !== null) {
            const dock = dockStore.getDock(focusedDock);
            const { focusedDockPaneId } = dockStore;

            // Try to navigate within dock panes if multiple exist
            if (dock && dock.panes.length > 1 && focusedDockPaneId) {
              const currentIdx = dock.panes.findIndex((p) => p.id === focusedDockPaneId);
              if (currentIdx >= 0) {
                const nextIdx = findPaneInDirection(dock.panes, currentIdx, direction);
                if (nextIdx !== null) {
                  dockStore.setFocusedDock(focusedDock, dock.panes[nextIdx].id);
                  return;
                }
              }
            }

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

      const {
        workspaces: rawWorkspaces,
        activeWorkspaceId,
        workspaceDisplayOrder,
        removeWorkspace,
        renameWorkspace,
      } = useWorkspaceStore.getState();
      const { workspaceSortOrder } = useSettingsStore.getState();
      const { notifications } = useNotificationStore.getState();
      const workspaces = sortWorkspaces(
        rawWorkspaces,
        workspaceSortOrder,
        workspaceDisplayOrder,
        notifications,
      );
      const { hiddenWorkspaceIds } = useUiStore.getState();
      const visibleWorkspaces = filterVisibleWorkspaces(workspaces, hiddenWorkspaceIds);

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
          const result = duplicateWorkspace(activeWorkspaceId);
          if (result) {
            // Mirror hide state (workspace + per-pane) onto the duplicate so
            // users don't see a sudden "unhidden" copy. See issue #218.
            useUiStore
              .getState()
              .propagateHiddenOnDuplicate(
                activeWorkspaceId,
                result.newWorkspaceId,
                result.paneIdMap,
              );
            switchWorkspace(result.newWorkspaceId);
          }
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

        // Ctrl+Alt+1~8: switch workspace by index (visible only)
        if (e.key >= "1" && e.key <= "8") {
          e.preventDefault();
          const idx = parseInt(e.key) - 1;
          if (idx < visibleWorkspaces.length) {
            switchWorkspace(visibleWorkspaces[idx].id);
          }
          return;
        }

        // Ctrl+Alt+9: last visible workspace
        if (e.key === "9") {
          e.preventDefault();
          const last = visibleWorkspaces.at(-1);
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

        // Ctrl+Alt+ArrowDown: next visible workspace
        if (e.key === "ArrowDown") {
          e.preventDefault();
          if (visibleWorkspaces.length === 0) return;
          const currentIdx = visibleWorkspaces.findIndex((ws) => ws.id === activeWorkspaceId);
          if (currentIdx >= 0) {
            // Active workspace is visible — simple cyclic navigation
            const nextIdx = (currentIdx + 1) % visibleWorkspaces.length;
            switchWorkspace(visibleWorkspaces[nextIdx].id);
          } else {
            // Active workspace is hidden — find next visible after current position in full sorted order
            const fullIdx = workspaces.findIndex((ws) => ws.id === activeWorkspaceId);
            const next =
              visibleWorkspaces.find((vws) => workspaces.indexOf(vws) > fullIdx) ??
              visibleWorkspaces[0];
            switchWorkspace(next.id);
          }
          return;
        }

        // Ctrl+Alt+ArrowUp: previous visible workspace
        if (e.key === "ArrowUp") {
          e.preventDefault();
          if (visibleWorkspaces.length === 0) return;
          const currentIdx = visibleWorkspaces.findIndex((ws) => ws.id === activeWorkspaceId);
          if (currentIdx >= 0) {
            // Active workspace is visible — simple cyclic navigation
            const prevIdx = (currentIdx - 1 + visibleWorkspaces.length) % visibleWorkspaces.length;
            switchWorkspace(visibleWorkspaces[prevIdx].id);
          } else {
            // Active workspace is hidden — find previous visible before current position in full sorted order
            const fullIdx = workspaces.findIndex((ws) => ws.id === activeWorkspaceId);
            const prev =
              [...visibleWorkspaces].reverse().find((vws) => workspaces.indexOf(vws) < fullIdx) ??
              visibleWorkspaces[visibleWorkspaces.length - 1];
            switchWorkspace(prev.id);
          }
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
