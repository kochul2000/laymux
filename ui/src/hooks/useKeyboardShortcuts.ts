import { useEffect } from "react";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useDockStore } from "@/stores/dock-store";
import { useGridStore } from "@/stores/grid-store";
import { useNotificationStore } from "@/stores/notification-store";
import { useUiStore } from "@/stores/ui-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useFileViewerStore } from "@/stores/file-viewer-store";
import { resolveViewer } from "@/lib/file-viewer";
import { matchesKeybinding } from "@/lib/keybinding-registry";
import { propagateCwdOnceForPane } from "@/lib/propagate-cwd-once";
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

/**
 * Switch workspace and (by default) hand focus to a workspace pane.
 *
 * #311: When a dock is focused and the user changes workspace by arrow, the
 * dock would keep visual focus while no pane was focused. The fix is to always
 * re-focus a pane on switch — falling back to pane 0 when there is no valid
 * reference. The `convenience.dockArrowFocusPane` setting (default true) lets
 * users opt out: when false, an active dock focus is preserved (memo-style).
 */
function switchWorkspace(id: string) {
  const wasDockFocused = useDockStore.getState().focusedDock !== null;
  const focusPane = useSettingsStore.getState().dock.arrowFocusPane;

  useWorkspaceStore.getState().setActiveWorkspace(id);

  // Opt-out (dockArrowFocusPane=false): when the dock was the focus source,
  // preserve dock focus across the switch (memo-style). When already in the
  // grid, fall through to pane focusing.
  if (!focusPane && wasDockFocused) return;

  useDockStore.getState().setFocusedDock(null);
  const { focusedPaneIndex, setFocusedPane } = useGridStore.getState();
  // Always end with a focused pane. When the dock was focused the grid index is
  // null → focus pane 0. When already in the grid, keep the current pane unless
  // there is no valid reference (null) → fall back to pane 0.
  if (wasDockFocused || focusedPaneIndex === null) {
    setFocusedPane(0);
    return;
  }
  // grid→grid: the global focusedPaneIndex is retained across switches, so a
  // larger index can fall outside a smaller target workspace. Clamp to the last
  // pane so we always stay on a valid, focused pane (#311 review).
  const paneCount = useWorkspaceStore.getState().getActiveWorkspace()?.panes.length ?? 0;
  if (paneCount > 0 && focusedPaneIndex > paneCount - 1) {
    setFocusedPane(paneCount - 1);
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

      // pane.propagateCwdOnce (default Ctrl+Alt+P): 포커스된 pane 의 CWD 를
      // sync group 에 1회 전파한다 (issue #324). 레지스트리 기반이라 Settings 에서
      // 재바인딩 가능. 디스패치 로직은 컨트롤 바 버튼과 공유(propagate-cwd-once).
      if (matchesKeybinding(e, "pane.propagateCwdOnce")) {
        const ws = useWorkspaceStore.getState().getActiveWorkspace();
        const { focusedPaneIndex } = useGridStore.getState();
        const pane = ws && focusedPaneIndex !== null ? ws.panes[focusedPaneIndex] : undefined;
        // 헬퍼가 실제로 전파를 디스패치했을 때만 preventDefault — CWD 없는
        // view(Memo 등)에서는 no-op 이므로 기본 동작을 막지 않는다 (PR #331 리뷰).
        if (pane && propagateCwdOnceForPane(pane)) {
          e.preventDefault();
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
          const dockArrowNav = useSettingsStore.getState().dock.arrowNav;

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

        // fileViewer.open (default Ctrl+Shift+O): open a file anywhere in the
        // unified viewer (#279). Registered in keybinding-registry so it is
        // user-overridable and shown in Settings. Opens the floating viewer in
        // empty (inline path input) mode (#283) — the overlay shows a path
        // field instead of a native window.prompt, so it works on every
        // platform (Windows/WebView2) and is driveable via the Automation API.
        if (matchesKeybinding(e, "fileViewer.open")) {
          e.preventDefault();
          // Don't tear down an in-progress terminal viewer (.txt→vi, video→mpv):
          // like Esc and a backdrop click (see FileViewerOverlay), the "open
          // anywhere" shortcut must not silently discard a live PTY session —
          // the user closes such viewers with the explicit ✕. Web viewers have
          // no session, so re-prompting is fine.
          const fv = useFileViewerStore.getState();
          if (fv.open && fv.path) {
            const { extensionViewers } = useSettingsStore.getState().fileExplorer;
            if (resolveViewer(fv.path, extensionViewers).viewerType === "terminal") {
              return;
            }
          }
          fv.openEmptyFileViewer();
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
