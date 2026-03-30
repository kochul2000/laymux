import { create } from "zustand";

export type ControlBarMode = "hover" | "pinned" | "minimized";

const BAR_MODES_KEY = "laymux-bar-modes";

function loadBarModes(): Record<string, ControlBarMode> {
  try {
    const raw = localStorage.getItem(BAR_MODES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveBarModes(modes: Record<string, ControlBarMode>) {
  try {
    localStorage.setItem(BAR_MODES_KEY, JSON.stringify(modes));
  } catch {
    /* ignore */
  }
}

interface UiState {
  settingsModalOpen: boolean;
  notificationPanelOpen: boolean;
  /** External navigation target for SettingsView (e.g. "startup", "profile-0", "colorSchemes") */
  settingsNavTarget: string | null;
  /** Per-pane control bar mode, keyed by pane ID. Persisted via localStorage. */
  barModes: Record<string, ControlBarMode>;

  openSettingsModal: () => void;
  closeSettingsModal: () => void;
  toggleSettingsModal: () => void;
  toggleNotificationPanel: () => void;
  closeNotificationPanel: () => void;
  setSettingsNavTarget: (target: string | null) => void;
  setBarMode: (paneId: string, mode: ControlBarMode) => void;
  getBarMode: (paneId: string) => ControlBarMode;
}

export const useUiStore = create<UiState>()((set, get) => ({
  settingsModalOpen: false,
  notificationPanelOpen: false,
  settingsNavTarget: null,
  barModes: loadBarModes(),

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
  setSettingsNavTarget: (target) => set({ settingsNavTarget: target }),
  setBarMode: (paneId, mode) => {
    set((state) => {
      const barModes = { ...state.barModes, [paneId]: mode };
      saveBarModes(barModes);
      return { barModes };
    });
  },
  getBarMode: (paneId) => get().barModes[paneId] ?? "hover",
}));
