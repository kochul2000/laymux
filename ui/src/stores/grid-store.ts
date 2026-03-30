import { create } from "zustand";

interface GridState {
  editMode: boolean;
  focusedPaneIndex: number | null;
  /** Automation-only: force hover on a pane index for screenshot verification. */
  automationHoverIndex: number | null;

  toggleEditMode: () => void;
  setEditMode: (enabled: boolean) => void;
  setFocusedPane: (index: number | null) => void;
  setAutomationHover: (index: number | null) => void;
}

export const useGridStore = create<GridState>()((set) => ({
  editMode: false,
  focusedPaneIndex: null,
  automationHoverIndex: null,

  toggleEditMode: () => set((state) => ({ editMode: !state.editMode })),

  setEditMode: (enabled) => set({ editMode: enabled }),

  setFocusedPane: (index) => set({ focusedPaneIndex: index }),

  setAutomationHover: (index) => set({ automationHoverIndex: index }),
}));
