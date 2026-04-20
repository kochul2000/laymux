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

interface UiState {
  settingsModalOpen: boolean;
  notificationPanelOpen: boolean;
  connectionInfoModalOpen: boolean;
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

  openSettingsModal: () => void;
  closeSettingsModal: () => void;
  toggleSettingsModal: () => void;
  toggleNotificationPanel: () => void;
  closeNotificationPanel: () => void;
  toggleConnectionInfoModal: () => void;
  closeConnectionInfoModal: () => void;
  setSettingsNavTarget: (target: string | null) => void;
  setAppFocused: (focused: boolean) => void;
  toggleHideMode: () => void;
  exitHideMode: () => void;
  togglePaneHidden: (paneId: string) => void;
  toggleWorkspaceHidden: (workspaceId: string) => void;
}

export const useUiStore = create<UiState>()((set) => ({
  settingsModalOpen: false,
  notificationPanelOpen: false,
  connectionInfoModalOpen: false,
  settingsNavTarget: null,
  isAppFocused: true,
  hideMode: false,
  hiddenPaneIds: loadHiddenIds(HIDDEN_PANES_KEY),
  hiddenWorkspaceIds: loadHiddenIds(HIDDEN_WORKSPACES_KEY),

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
  toggleConnectionInfoModal: () =>
    set((state) => ({
      connectionInfoModalOpen: !state.connectionInfoModalOpen,
      settingsModalOpen: !state.connectionInfoModalOpen ? false : state.settingsModalOpen,
      notificationPanelOpen: !state.connectionInfoModalOpen ? false : state.notificationPanelOpen,
    })),
  closeConnectionInfoModal: () => set({ connectionInfoModalOpen: false }),
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
}));
