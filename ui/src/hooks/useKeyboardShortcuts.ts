import { useEffect } from "react";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useDockStore } from "@/stores/dock-store";
import { useGridStore } from "@/stores/grid-store";
import { useNotificationStore } from "@/stores/notification-store";
import { useUiStore } from "@/stores/ui-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useFileViewerStore } from "@/stores/file-viewer-store";
import { useRenameWorkspaceStore } from "@/stores/rename-workspace-store";
import { resolveViewer } from "@/lib/file-viewer";
import { matchesKeybinding } from "@/lib/keybinding-registry";
import { formatPaneIdentifier, paneNumberFor } from "@/lib/pane-numbers";
import { propagateCwdOnceForPane } from "@/lib/propagate-cwd-once";
import { findPaneInDirection, type Direction } from "@/lib/pane-navigation";
import { getSortedWorkspaces, notificationStep } from "@/lib/navigation-actions";
import { getDockForDirection, getDockExitDirection } from "@/lib/dock-navigation";
import { clipboardWriteText } from "@/lib/tauri-api";

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
 * reference. The `dock.arrowFocusPane` setting (default true) lets
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

/** Switch to the nth visible workspace (0-based display order). */
function switchToWorkspaceIndex(idx: number) {
  const { visibleWorkspaces } = getSortedWorkspaces();
  if (idx < visibleWorkspaces.length) {
    switchWorkspace(visibleWorkspaces[idx].id);
  }
}

/** Cycle to the next (+1) / previous (-1) visible workspace, skipping hidden ones. */
function cycleVisibleWorkspace(step: 1 | -1) {
  const { workspaces, visibleWorkspaces } = getSortedWorkspaces();
  const { activeWorkspaceId } = useWorkspaceStore.getState();
  if (visibleWorkspaces.length === 0) return;
  const currentIdx = visibleWorkspaces.findIndex((ws) => ws.id === activeWorkspaceId);
  if (currentIdx >= 0) {
    // Active workspace is visible — simple cyclic navigation
    const nextIdx = (currentIdx + step + visibleWorkspaces.length) % visibleWorkspaces.length;
    switchWorkspace(visibleWorkspaces[nextIdx].id);
    return;
  }
  // Active workspace is hidden — find the adjacent visible workspace relative
  // to the current position in the full sorted order (wrapping at the ends).
  const fullIdx = workspaces.findIndex((ws) => ws.id === activeWorkspaceId);
  if (step === 1) {
    const next =
      visibleWorkspaces.find((vws) => workspaces.indexOf(vws) > fullIdx) ?? visibleWorkspaces[0];
    switchWorkspace(next.id);
  } else {
    const prev =
      [...visibleWorkspaces].reverse().find((vws) => workspaces.indexOf(vws) < fullIdx) ??
      visibleWorkspaces[visibleWorkspaces.length - 1];
    switchWorkspace(prev.id);
  }
}

function copyFocusedPaneIdentifier(): boolean {
  const ws = useWorkspaceStore.getState().getActiveWorkspace();
  const { focusedPaneIndex } = useGridStore.getState();
  if (!ws || focusedPaneIndex === null) return false;

  const pane = ws.panes[focusedPaneIndex];
  if (!pane) return false;

  const paneNumber = paneNumberFor(ws.panes, pane.id);
  if (paneNumber === null) return false;

  try {
    const text = formatPaneIdentifier({ workspaceName: ws.name, paneNumber });
    void clipboardWriteText(text).catch(() => {});
    return true;
  } catch {
    return false;
  }
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

/** pane.focus: directional pane/dock navigation. Direction comes from the pressed arrow key. */
function navigatePaneFocus(e: KeyboardEvent) {
  // `pane.focus` is bound to the `Arrow` wildcard (any direction); the actual
  // direction is derived from the event key. A non-arrow key (possible only
  // via a hand-edited non-wildcard override) is a no-op.
  const direction = ARROW_TO_DIRECTION[e.key];
  if (!direction) return;
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
      if (targetState?.visible && targetState.panes.length > 0 && targetDock !== focusedDock) {
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
}

/**
 * Action ID → handler table for every document-level shortcut (#337).
 *
 * Combos are matched exclusively through `matchesKeybinding()` (user override >
 * `DEFAULT_KEYBINDINGS` default) — no hardcoded key checks. Rebinding an action
 * in Settings therefore moves the document handler together with the terminal
 * pass-through (`lx-shortcuts.ts`, #332/#333): the new combo works and the old
 * default goes inert, symmetrically.
 *
 * Each handler decides its own `preventDefault()` (e.g. `pane.delete` skips it
 * while a text input is focused; `pane.propagateCwdOnce` only on dispatch).
 * Terminal/Memo/Issue Reporter actions are handled inside their focused views,
 * not here.
 */
// workspace.1 ~ workspace.8: switch workspace by visible display index.
// Built before SHORTCUT_HANDLERS and spread in place so the dispatch order
// stays pane.* → workspace.* → UI actions (the documented tie-break contract).
const WORKSPACE_INDEX_HANDLERS: Record<string, (e: KeyboardEvent) => void> = {};
for (let n = 1; n <= 8; n++) {
  WORKSPACE_INDEX_HANDLERS[`workspace.${n}`] = (e) => {
    e.preventDefault();
    switchToWorkspaceIndex(n - 1);
  };
}

const SHORTCUT_HANDLERS: Record<string, (e: KeyboardEvent) => void> = {
  // pane.delete (default: plain Delete): remove focused pane.
  // Skip when a text-editable element has focus (e.g. input, textarea, contentEditable)
  "pane.delete": (e) => {
    if (isTextInputFocused()) return;
    const { focusedPaneIndex } = useGridStore.getState();
    if (focusedPaneIndex !== null) {
      e.preventDefault();
      useWorkspaceStore.getState().removePane(focusedPaneIndex);
    }
  },

  // pane.propagateCwdOnce (default Ctrl+Alt+P): 포커스된 pane 의 CWD 를
  // sync group 에 1회 전파한다 (issue #324). 디스패치 로직은 컨트롤 바 버튼과
  // 공유(propagate-cwd-once).
  "pane.propagateCwdOnce": (e) => {
    const ws = useWorkspaceStore.getState().getActiveWorkspace();
    const { focusedPaneIndex } = useGridStore.getState();
    const pane = ws && focusedPaneIndex !== null ? ws.panes[focusedPaneIndex] : undefined;
    // 헬퍼가 실제로 전파를 디스패치했을 때만 preventDefault — CWD 없는
    // view(Memo 등)에서는 no-op 이므로 기본 동작을 막지 않는다 (PR #331 리뷰).
    if (pane && propagateCwdOnceForPane(pane)) {
      e.preventDefault();
    }
  },

  "pane.copyIdentifier": (e) => {
    if (copyFocusedPaneIdentifier()) {
      e.preventDefault();
    }
  },

  // pane.focus (default Alt+Arrow wildcard): pane navigation (workspace + dock)
  "pane.focus": navigatePaneFocus,

  ...WORKSPACE_INDEX_HANDLERS,

  // workspace.last: last visible workspace
  "workspace.last": (e) => {
    e.preventDefault();
    const { visibleWorkspaces } = getSortedWorkspaces();
    const last = visibleWorkspaces.at(-1);
    if (last) switchWorkspace(last.id);
  },

  // workspace.next / workspace.prev: cycle visible workspaces
  "workspace.next": (e) => {
    e.preventDefault();
    cycleVisibleWorkspace(1);
  },
  "workspace.prev": (e) => {
    e.preventDefault();
    cycleVisibleWorkspace(-1);
  },

  // workspace.new: new workspace with default (first) layout
  "workspace.new": (e) => {
    e.preventDefault();
    const { layouts, addWorkspace, workspaces } = useWorkspaceStore.getState();
    const defaultLayout = layouts[0];
    if (defaultLayout) {
      addWorkspace(`Workspace ${workspaces.length + 1}`, defaultLayout.id);
      const updated = useWorkspaceStore.getState().workspaces;
      const newWs = updated[updated.length - 1];
      if (newWs) switchWorkspace(newWs.id);
    }
  },

  // workspace.duplicate: duplicate current workspace
  "workspace.duplicate": (e) => {
    e.preventDefault();
    const { duplicateWorkspace, activeWorkspaceId } = useWorkspaceStore.getState();
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
          true,
        );
      switchWorkspace(result.newWorkspaceId);
    }
  },

  // workspace.close: close current workspace (never the last one)
  "workspace.close": (e) => {
    e.preventDefault();
    const { workspaces, activeWorkspaceId, removeWorkspace } = useWorkspaceStore.getState();
    if (workspaces.length > 1) {
      removeWorkspace(activeWorkspaceId);
    }
  },

  // workspace.rename: rename current workspace.
  // Opens the inline rename overlay (#339) instead of a native window.prompt,
  // which does not work on Windows/WebView2 (the #283 root cause) and is not
  // driveable via the Automation API.
  "workspace.rename": (e) => {
    e.preventDefault();
    const { workspaces, activeWorkspaceId } = useWorkspaceStore.getState();
    const current = workspaces.find((ws) => ws.id === activeWorkspaceId);
    if (current) {
      useRenameWorkspaceStore.getState().openRename(current.id, current.name);
    }
  },

  // notifications.unread: jump to most recent unread notification workspace
  "notifications.unread": (e) => {
    e.preventDefault();
    const { notifications } = useNotificationStore.getState();
    const unread = [...notifications].reverse().find((n) => n.readAt === null);
    if (unread) {
      switchWorkspace(unread.workspaceId);
    }
  },

  // notifications.recent / notifications.oldest: jump to notification pane (consume)
  "notifications.recent": (e) => {
    e.preventDefault();
    notificationStep("recent");
  },
  "notifications.oldest": (e) => {
    e.preventDefault();
    notificationStep("oldest");
  },

  // sidebar.toggle: toggle left dock sidebar
  "sidebar.toggle": (e) => {
    e.preventDefault();
    useDockStore.getState().toggleDockVisible("left");
  },

  // notifications.toggle: toggle notification panel
  "notifications.toggle": (e) => {
    e.preventDefault();
    useUiStore.getState().toggleNotificationPanel();
  },

  // fileViewer.open: open a file anywhere in the unified viewer (#279).
  // Opens the floating viewer in empty (inline path input) mode (#283) — the
  // overlay shows a path field instead of a native window.prompt, so it works
  // on every platform (Windows/WebView2) and is driveable via the Automation API.
  "fileViewer.open": (e) => {
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
  },

  // settings.open: toggle settings modal
  "settings.open": (e) => {
    e.preventDefault();
    useUiStore.getState().toggleSettingsModal();
  },
};

const SHORTCUT_ACTION_IDS = Object.keys(SHORTCUT_HANDLERS);

/**
 * True when the event's combo is bound (default or user-rebound) to any
 * document-level laymux action this hook dispatches (pane/workspace navigation,
 * notifications, UI toggles). Focused surfaces that forward raw keys to a PTY
 * (e.g. the terminal Composer) must check this FIRST and let matching events
 * bubble — laymux controls consume before passthrough, and rebinding moves
 * this check together with the dispatcher automatically.
 */
export function matchesGlobalShortcut(e: KeyboardEvent): boolean {
  return SHORTCUT_ACTION_IDS.some((actionId) => matchesKeybinding(e, actionId));
}

export function useKeyboardShortcuts() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Dispatch the first action whose (possibly user-overridden) combo
      // matches. Default combos are collision-free; after rebinding, table
      // order decides ties (pane.* before workspace.* before UI actions).
      // A match consumes the event even when the handler no-ops (e.g.
      // pane.delete with a text input focused) — later actions sharing the
      // same combo never run.
      for (const actionId of SHORTCUT_ACTION_IDS) {
        if (matchesKeybinding(e, actionId)) {
          SHORTCUT_HANDLERS[actionId](e);
          return;
        }
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);
}
