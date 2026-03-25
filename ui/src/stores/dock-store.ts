import { create } from "zustand";
import type { DockPosition, DockPane, ViewType, ViewInstanceConfig } from "./types";
import { removePaneAndRedistribute } from "./pane-removal";

export const DOCK_MIN_SIZE = 100;
export const DOCK_MAX_SIZE = 600;

function generateId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

interface DockState {
  position: DockPosition;
  activeView: ViewType | null;
  views: ViewType[];
  visible: boolean;
  size: number;
  panes: DockPane[];
}

export type DockLayoutMode = "horizontal" | "vertical";

interface DockStoreState {
  docks: DockState[];
  layoutMode: DockLayoutMode;
  focusedDock: DockPosition | null;

  getDock: (position: DockPosition) => DockState | undefined;
  setDockActiveView: (position: DockPosition, view: ViewType, viewConfig?: ViewInstanceConfig) => void;
  toggleDockVisible: (position: DockPosition) => void;
  toggleLayoutMode: () => void;
  setDockSize: (position: DockPosition, size: number) => void;
  setFocusedDock: (position: DockPosition | null) => void;

  // Pane management (2D grid, same model as workspace)
  splitDockPane: (position: DockPosition, direction: "horizontal" | "vertical", paneId?: string) => void;
  removeDockPane: (position: DockPosition, paneId: string) => void;
  setDockPaneView: (position: DockPosition, paneId: string, view: ViewInstanceConfig) => void;
  resizeDockPane: (position: DockPosition, paneId: string, delta: Partial<Pick<DockPane, "x" | "y" | "w" | "h">>) => void;
}

function makeDock(
  position: DockPosition,
  activeView: ViewType | null,
  size: number,
): DockState {
  return {
    position,
    activeView,
    views: [],
    visible: true,
    size,
    panes: activeView
      ? [{ id: generateId("dp"), view: { type: activeView }, x: 0, y: 0, w: 1, h: 1 }]
      : [],
  };
}

export const useDockStore = create<DockStoreState>()((set, get) => ({
  layoutMode: "horizontal" as DockLayoutMode,
  focusedDock: null,
  docks: [
    makeDock("top", null, 200),
    makeDock("bottom", null, 200),
    makeDock("left", "WorkspaceSelectorView", 240),
    makeDock("right", null, 240),
  ],

  getDock: (position) => {
    return get().docks.find((d) => d.position === position);
  },

  setDockActiveView: (position, view, viewConfig) => {
    const effectiveView: ViewInstanceConfig = viewConfig ?? { type: view };
    set((state) => ({
      docks: state.docks.map((d) => {
        if (d.position !== position) return d;
        const panes = d.panes ?? [];
        if (panes.length > 0) {
          const newPanes = [...panes];
          newPanes[0] = { ...newPanes[0], view: effectiveView };
          return { ...d, activeView: view, panes: newPanes };
        }
        return {
          ...d,
          activeView: view,
          panes: [{ id: generateId("dp"), view: effectiveView, x: 0, y: 0, w: 1, h: 1 }],
        };
      }),
    }));
  },

  toggleDockVisible: (position) => {
    set((state) => ({
      docks: state.docks.map((d) =>
        d.position === position ? { ...d, visible: !d.visible } : d,
      ),
    }));
  },

  toggleLayoutMode: () => {
    set((state) => ({
      layoutMode: state.layoutMode === "horizontal" ? "vertical" : "horizontal",
    }));
  },

  setDockSize: (position, size) => {
    const clamped = Math.max(DOCK_MIN_SIZE, Math.min(DOCK_MAX_SIZE, size));
    set((state) => ({
      docks: state.docks.map((d) =>
        d.position === position ? { ...d, size: clamped } : d,
      ),
    }));
  },

  setFocusedDock: (position) => {
    set({ focusedDock: position });
  },

  splitDockPane: (position, direction, paneId) => {
    set((state) => ({
      docks: state.docks.map((d) => {
        if (d.position !== position) return d;

        const panes = d.panes ?? [];
        if (panes.length === 0) {
          // No panes yet — create two from activeView
          if (direction === "horizontal") {
            return {
              ...d,
              panes: [
                { id: generateId("dp"), view: { type: d.activeView ?? "EmptyView" }, x: 0, y: 0, w: 1, h: 0.5 },
                { id: generateId("dp"), view: { type: "EmptyView" }, x: 0, y: 0.5, w: 1, h: 0.5 },
              ],
            };
          }
          return {
            ...d,
            panes: [
              { id: generateId("dp"), view: { type: d.activeView ?? "EmptyView" }, x: 0, y: 0, w: 0.5, h: 1 },
              { id: generateId("dp"), view: { type: "EmptyView" }, x: 0.5, y: 0, w: 0.5, h: 1 },
            ],
          };
        }

        const idx = paneId ? panes.findIndex((p) => p.id === paneId) : 0;
        if (idx < 0) return d;

        const pane = panes[idx];
        let updatedPane: DockPane;
        let newPane: DockPane;

        if (direction === "horizontal") {
          const halfH = pane.h / 2;
          updatedPane = { ...pane, h: halfH };
          newPane = {
            id: generateId("dp"),
            x: pane.x,
            y: pane.y + halfH,
            w: pane.w,
            h: halfH,
            view: { type: "EmptyView" },
          };
        } else {
          const halfW = pane.w / 2;
          updatedPane = { ...pane, w: halfW };
          newPane = {
            id: generateId("dp"),
            x: pane.x + halfW,
            y: pane.y,
            w: halfW,
            h: pane.h,
            view: { type: "EmptyView" },
          };
        }

        const newPanes = [...panes];
        newPanes[idx] = updatedPane;
        newPanes.splice(idx + 1, 0, newPane);
        return { ...d, panes: newPanes };
      }),
    }));
  },

  removeDockPane: (position, paneId) => {
    set((state) => ({
      docks: state.docks.map((d) => {
        if (d.position !== position) return d;
        const panes = d.panes ?? [];

        const idx = panes.findIndex((p) => p.id === paneId);
        if (idx < 0) return d;

        const result = removePaneAndRedistribute(panes, idx);
        if (!result) return d;

        const newActive = result[0]?.view.type ?? null;
        return { ...d, panes: result, activeView: newActive };
      }),
    }));
  },

  setDockPaneView: (position, paneId, view) => {
    set((state) => ({
      docks: state.docks.map((d) => {
        if (d.position !== position) return d;
        const panes = d.panes ?? [];
        const newPanes = panes.map((p) =>
          p.id === paneId ? { ...p, view } : p,
        );
        return {
          ...d,
          panes: newPanes,
          activeView: newPanes[0]?.view.type ?? d.activeView,
        };
      }),
    }));
  },

  resizeDockPane: (position, paneId, delta) => {
    set((state) => ({
      docks: state.docks.map((d) => {
        if (d.position !== position) return d;
        return {
          ...d,
          panes: d.panes.map((p) =>
            p.id === paneId ? { ...p, ...delta } : p,
          ),
        };
      }),
    }));
  },
}));
