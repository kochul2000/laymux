import { create } from "zustand";

const HIDDEN_PANES_KEY = "laymux-hidden-panes";
const HIDDEN_WORKSPACES_KEY = "laymux-hidden-workspaces";

function loadHiddenIds(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function saveHiddenIds(key: string, ids: Set<string>) {
  try {
    localStorage.setItem(key, JSON.stringify([...ids]));
  } catch {
    /* ignore */
  }
}

/** Value-equality for two string sets (order-independent). */
function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

interface UiState {
  settingsModalOpen: boolean;
  notificationPanelOpen: boolean;
  remoteAccessModalOpen: boolean;
  /** External navigation target for SettingsView (e.g. "startup", "profile-0", "colorSchemes") */
  settingsNavTarget: string | null;
  /** Whether the app window is currently focused (not blurred to another app). */
  isAppFocused: boolean;
  /** Whether hide mode is active in WorkspaceSelectorView (unified for workspaces + panes). */
  hideMode: boolean;
  /** Set of pane IDs hidden in WorkspaceSelectorView. */
  hiddenPaneIds: Set<string>;
  /** Set of workspace IDs hidden in WorkspaceSelectorView. */
  hiddenWorkspaceIds: Set<string>;
  /**
   * Pane IDs whose terminal has been auto-closed after staying hidden past the
   * configured timeout (issue #269). WorkspaceArea stops rendering these panes
   * so their TerminalView unmounts and the PTY is torn down. Cleared (per pane)
   * when the pane is un-hidden, which re-mounts it and spawns a fresh PTY.
   */
  evictedPaneIds: Set<string>;

  openSettingsModal: () => void;
  closeSettingsModal: () => void;
  toggleSettingsModal: () => void;
  toggleNotificationPanel: () => void;
  closeNotificationPanel: () => void;
  openRemoteAccessModal: () => void;
  toggleRemoteAccessModal: () => void;
  closeRemoteAccessModal: () => void;
  setSettingsNavTarget: (target: string | null) => void;
  setAppFocused: (focused: boolean) => void;
  toggleHideMode: () => void;
  exitHideMode: () => void;
  togglePaneHidden: (paneId: string) => void;
  toggleWorkspaceHidden: (workspaceId: string) => void;
  /**
   * Replace the set of auto-evicted pane IDs. The reference is preserved when
   * the new set is value-equal so Zustand subscribers do not re-render
   * needlessly on every timer tick.
   */
  setEvictedPaneIds: (ids: Set<string>) => void;
  /**
   * Replay hide state from a source workspace onto its freshly-created duplicate.
   * - If the source workspace is hidden, mark the new workspace hidden too.
   * - For each entry in `paneIdMap` (source pane id → new pane id) whose source
   *   pane is hidden, also mark the new pane hidden.
   * Called right after `workspaceStore.duplicateWorkspace` so the duplicate
   * mirrors the user's hide selections.
   */
  propagateHiddenOnDuplicate: (
    sourceWorkspaceId: string,
    newWorkspaceId: string,
    paneIdMap: Record<string, string>,
  ) => void;
}

export const useUiStore = create<UiState>()((set) => ({
  settingsModalOpen: false,
  notificationPanelOpen: false,
  remoteAccessModalOpen: false,
  settingsNavTarget: null,
  isAppFocused: true,
  hideMode: false,
  hiddenPaneIds: loadHiddenIds(HIDDEN_PANES_KEY),
  hiddenWorkspaceIds: loadHiddenIds(HIDDEN_WORKSPACES_KEY),
  evictedPaneIds: new Set(),

  openSettingsModal: () => set({ settingsModalOpen: true, notificationPanelOpen: false }),
  closeSettingsModal: () => set({ settingsModalOpen: false }),
  toggleSettingsModal: () =>
    set((state) => ({
      settingsModalOpen: !state.settingsModalOpen,
      notificationPanelOpen: !state.settingsModalOpen ? false : state.notificationPanelOpen,
    })),
  toggleNotificationPanel: () =>
    set((state) => ({
      notificationPanelOpen: !state.notificationPanelOpen,
      settingsModalOpen: !state.notificationPanelOpen ? false : state.settingsModalOpen,
    })),
  closeNotificationPanel: () => set({ notificationPanelOpen: false }),
  openRemoteAccessModal: () =>
    set({
      remoteAccessModalOpen: true,
      settingsModalOpen: false,
      notificationPanelOpen: false,
    }),
  toggleRemoteAccessModal: () =>
    set((state) => ({
      remoteAccessModalOpen: !state.remoteAccessModalOpen,
      settingsModalOpen: !state.remoteAccessModalOpen ? false : state.settingsModalOpen,
      notificationPanelOpen: !state.remoteAccessModalOpen ? false : state.notificationPanelOpen,
    })),
  closeRemoteAccessModal: () => set({ remoteAccessModalOpen: false }),
  setSettingsNavTarget: (target) => set({ settingsNavTarget: target }),
  setAppFocused: (focused) => set({ isAppFocused: focused }),
  toggleHideMode: () => set((state) => ({ hideMode: !state.hideMode })),
  exitHideMode: () => set({ hideMode: false }),
  togglePaneHidden: (paneId) =>
    set((state) => {
      const next = new Set(state.hiddenPaneIds);
      if (next.has(paneId)) next.delete(paneId);
      else next.add(paneId);
      saveHiddenIds(HIDDEN_PANES_KEY, next);
      return { hiddenPaneIds: next };
    }),
  toggleWorkspaceHidden: (workspaceId) =>
    set((state) => {
      const next = new Set(state.hiddenWorkspaceIds);
      if (next.has(workspaceId)) next.delete(workspaceId);
      else next.add(workspaceId);
      saveHiddenIds(HIDDEN_WORKSPACES_KEY, next);
      return { hiddenWorkspaceIds: next };
    }),
  setEvictedPaneIds: (ids) =>
    set((state) => (setsEqual(state.evictedPaneIds, ids) ? state : { evictedPaneIds: ids })),
  propagateHiddenOnDuplicate: (sourceWorkspaceId, newWorkspaceId, paneIdMap) =>
    set((state) => {
      const patch: Partial<UiState> = {};

      // Workspace-level flag: if the source is hidden, mirror onto the duplicate.
      if (state.hiddenWorkspaceIds.has(sourceWorkspaceId)) {
        const nextWs = new Set(state.hiddenWorkspaceIds);
        nextWs.add(newWorkspaceId);
        saveHiddenIds(HIDDEN_WORKSPACES_KEY, nextWs);
        patch.hiddenWorkspaceIds = nextWs;
      }

      // Pane-level flags: replay via the source→new pane ID mapping.
      const hiddenNewPanes: string[] = [];
      for (const [srcId, newId] of Object.entries(paneIdMap)) {
        if (state.hiddenPaneIds.has(srcId)) hiddenNewPanes.push(newId);
      }
      if (hiddenNewPanes.length > 0) {
        const nextPanes = new Set(state.hiddenPaneIds);
        for (const id of hiddenNewPanes) nextPanes.add(id);
        saveHiddenIds(HIDDEN_PANES_KEY, nextPanes);
        patch.hiddenPaneIds = nextPanes;
      }

      return patch;
    }),
}));
