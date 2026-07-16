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
  /** Whether the non-persistent hidden-items shelf is open. */
  hiddenShelfOpen: boolean;
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
  setHiddenShelfOpen: (open: boolean) => void;
  setPaneHidden: (paneId: string, hidden: boolean) => void;
  setWorkspaceHidden: (workspaceId: string, hidden: boolean, paneIds?: string[]) => void;
  restoreAllHidden: () => void;
  pruneHiddenIds: (validWorkspaceIds: Set<string>, validPaneIds: Set<string>) => void;
  togglePaneHidden: (paneId: string) => void;
  toggleWorkspaceHidden: (workspaceId: string, paneIds?: string[]) => void;
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
    newWorkspaceWillBeActive?: boolean,
  ) => void;
}

export const useUiStore = create<UiState>()((set, get) => ({
  settingsModalOpen: false,
  notificationPanelOpen: false,
  remoteAccessModalOpen: false,
  settingsNavTarget: null,
  isAppFocused: true,
  hiddenShelfOpen: false,
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
  setHiddenShelfOpen: (open) =>
    set((state) => (state.hiddenShelfOpen === open ? state : { hiddenShelfOpen: open })),
  setPaneHidden: (paneId, hidden) =>
    set((state) => {
      const currentlyHidden = state.hiddenPaneIds.has(paneId);
      const needsEvictionClear = !hidden && state.evictedPaneIds.has(paneId);
      const remainingHiddenPaneCount =
        currentlyHidden && !hidden ? state.hiddenPaneIds.size - 1 : state.hiddenPaneIds.size;
      const shouldCloseShelf =
        !hidden &&
        remainingHiddenPaneCount === 0 &&
        state.hiddenWorkspaceIds.size === 0 &&
        state.hiddenShelfOpen;
      if (currentlyHidden === hidden && !needsEvictionClear && !shouldCloseShelf) return state;

      let next = state.hiddenPaneIds;
      if (currentlyHidden !== hidden) {
        next = new Set(state.hiddenPaneIds);
        if (hidden) next.add(paneId);
        else next.delete(paneId);
        saveHiddenIds(HIDDEN_PANES_KEY, next);
      }

      const patch: Partial<UiState> = {};
      if (currentlyHidden !== hidden) patch.hiddenPaneIds = next;
      if (needsEvictionClear) {
        const nextEvicted = new Set(state.evictedPaneIds);
        nextEvicted.delete(paneId);
        patch.evictedPaneIds = nextEvicted;
      }
      if (shouldCloseShelf) patch.hiddenShelfOpen = false;
      return patch;
    }),
  setWorkspaceHidden: (workspaceId, hidden, paneIds = []) =>
    set((state) => {
      const currentlyHidden = state.hiddenWorkspaceIds.has(workspaceId);
      const paneIdSet = new Set(paneIds);
      const needsEvictionClear =
        !hidden && paneIds.some((paneId) => state.evictedPaneIds.has(paneId));
      const remainingHiddenWorkspaceCount =
        currentlyHidden && !hidden
          ? state.hiddenWorkspaceIds.size - 1
          : state.hiddenWorkspaceIds.size;
      const shouldCloseShelf =
        !hidden &&
        remainingHiddenWorkspaceCount === 0 &&
        state.hiddenPaneIds.size === 0 &&
        state.hiddenShelfOpen;
      if (currentlyHidden === hidden && !needsEvictionClear && !shouldCloseShelf) return state;

      let next = state.hiddenWorkspaceIds;
      if (currentlyHidden !== hidden) {
        next = new Set(state.hiddenWorkspaceIds);
        if (hidden) next.add(workspaceId);
        else next.delete(workspaceId);
        saveHiddenIds(HIDDEN_WORKSPACES_KEY, next);
      }

      const patch: Partial<UiState> = {};
      if (currentlyHidden !== hidden) patch.hiddenWorkspaceIds = next;
      if (needsEvictionClear) {
        patch.evictedPaneIds = new Set(
          [...state.evictedPaneIds].filter((paneId) => !paneIdSet.has(paneId)),
        );
      }
      if (shouldCloseShelf) patch.hiddenShelfOpen = false;
      return patch;
    }),
  restoreAllHidden: () =>
    set((state) => {
      if (state.hiddenWorkspaceIds.size > 0) saveHiddenIds(HIDDEN_WORKSPACES_KEY, new Set());
      if (state.hiddenPaneIds.size > 0) saveHiddenIds(HIDDEN_PANES_KEY, new Set());
      if (
        state.hiddenWorkspaceIds.size === 0 &&
        state.hiddenPaneIds.size === 0 &&
        state.evictedPaneIds.size === 0 &&
        !state.hiddenShelfOpen
      ) {
        return state;
      }
      return {
        hiddenWorkspaceIds: new Set<string>(),
        hiddenPaneIds: new Set<string>(),
        evictedPaneIds: new Set<string>(),
        hiddenShelfOpen: false,
      };
    }),
  pruneHiddenIds: (validWorkspaceIds, validPaneIds) =>
    set((state) => {
      const nextWorkspaces = new Set(
        [...state.hiddenWorkspaceIds].filter((id) => validWorkspaceIds.has(id)),
      );
      const nextPanes = new Set([...state.hiddenPaneIds].filter((id) => validPaneIds.has(id)));
      const nextEvicted = new Set([...state.evictedPaneIds].filter((id) => validPaneIds.has(id)));
      const workspacesChanged = !setsEqual(state.hiddenWorkspaceIds, nextWorkspaces);
      const panesChanged = !setsEqual(state.hiddenPaneIds, nextPanes);
      const evictedChanged = !setsEqual(state.evictedPaneIds, nextEvicted);
      const shouldCloseShelf = nextWorkspaces.size + nextPanes.size === 0 && state.hiddenShelfOpen;
      if (!workspacesChanged && !panesChanged && !evictedChanged && !shouldCloseShelf) return state;
      if (workspacesChanged) saveHiddenIds(HIDDEN_WORKSPACES_KEY, nextWorkspaces);
      if (panesChanged) saveHiddenIds(HIDDEN_PANES_KEY, nextPanes);
      return {
        ...(workspacesChanged ? { hiddenWorkspaceIds: nextWorkspaces } : {}),
        ...(panesChanged ? { hiddenPaneIds: nextPanes } : {}),
        ...(evictedChanged ? { evictedPaneIds: nextEvicted } : {}),
        ...(shouldCloseShelf ? { hiddenShelfOpen: false } : {}),
      };
    }),
  togglePaneHidden: (paneId) => get().setPaneHidden(paneId, !get().hiddenPaneIds.has(paneId)),
  toggleWorkspaceHidden: (workspaceId, paneIds = []) =>
    get().setWorkspaceHidden(workspaceId, !get().hiddenWorkspaceIds.has(workspaceId), paneIds),
  setEvictedPaneIds: (ids) =>
    set((state) => (setsEqual(state.evictedPaneIds, ids) ? state : { evictedPaneIds: ids })),
  propagateHiddenOnDuplicate: (
    sourceWorkspaceId,
    newWorkspaceId,
    paneIdMap,
    newWorkspaceWillBeActive = false,
  ) =>
    set((state) => {
      const patch: Partial<UiState> = {};

      // Workspace-level flag: if the source is hidden, mirror onto the duplicate.
      if (state.hiddenWorkspaceIds.has(sourceWorkspaceId) && !newWorkspaceWillBeActive) {
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
