import { create } from "zustand";
import type { Layout, Workspace, WorkspacePane, ViewInstanceConfig } from "./types";
import { persistSession } from "@/lib/persist-session";
import { removePaneAndRedistribute } from "./pane-removal";

function generateId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Return a name that doesn't collide with existing workspace names. */
function ensureUniqueName(name: string, existing: { name: string }[]): string {
  const names = new Set(existing.map((ws) => ws.name));
  if (!names.has(name)) return name;
  let n = 2;
  while (names.has(`${name} (${n})`)) n++;
  return `${name} (${n})`;
}

const defaultLayout: Layout = {
  id: "default-layout",
  name: "Default",
  panes: [{ x: 0, y: 0, w: 1, h: 1, viewType: "EmptyView" }],
};

const defaultWorkspace: Workspace = {
  id: "ws-default",
  name: "Default",
  layoutId: "default-layout",
  panes: [
    {
      id: generateId("pane"),
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      view: { type: "EmptyView" },
    },
  ],
};

interface WorkspaceState {
  layouts: Layout[];
  workspaces: Workspace[];
  activeWorkspaceId: string;

  getActiveWorkspace: () => Workspace | undefined;
  setActiveWorkspace: (id: string) => void;
  addWorkspace: (name: string, layoutId: string) => void;
  duplicateWorkspace: (id: string) => void;
  removeWorkspace: (id: string) => void;
  renameWorkspace: (id: string, name: string) => void;

  // Pane manipulation
  splitPane: (paneIndex: number, direction: "horizontal" | "vertical") => void;
  removePane: (paneIndex: number) => void;
  resizePane: (paneIndex: number, delta: Partial<Pick<WorkspacePane, "x" | "y" | "w" | "h">>) => void;
  setPaneView: (paneIndex: number, view: ViewInstanceConfig) => void;

  // Save actions
  saveWorkspace: () => void;
  saveAndPropagate: () => void;
  saveAsNewLayout: (name: string) => void;
  revertWorkspace: () => void;

  // Layout management
  renameLayout: (layoutId: string, name: string) => void;
  removeLayout: (layoutId: string) => void;
  duplicateLayout: (layoutId: string, newName: string) => void;
  setDefaultLayout: (layoutId: string) => void;
}

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => ({
  layouts: [defaultLayout],
  workspaces: [defaultWorkspace],
  activeWorkspaceId: defaultWorkspace.id,

  getActiveWorkspace: () => {
    const { workspaces, activeWorkspaceId } = get();
    return workspaces.find((ws) => ws.id === activeWorkspaceId);
  },

  setActiveWorkspace: (id) => {
    const { workspaces } = get();
    if (workspaces.some((ws) => ws.id === id)) {
      set({ activeWorkspaceId: id });
    }
  },

  addWorkspace: (name, layoutId) => {
    const { layouts, workspaces } = get();
    const layout = layouts.find((l) => l.id === layoutId);
    if (!layout) return;

    const uniqueName = ensureUniqueName(name, workspaces);

    const ws: Workspace = {
      id: generateId("ws"),
      name: uniqueName,
      layoutId,
      panes: layout.panes.map((p) => ({
        id: generateId("pane"),
        x: p.x,
        y: p.y,
        w: p.w,
        h: p.h,
        view: { type: p.viewType },
      })),
    };

    set((state) => ({ workspaces: [...state.workspaces, ws] }));
  },

  duplicateWorkspace: (id) => {
    const { workspaces } = get();
    const source = workspaces.find((ws) => ws.id === id);
    if (!source) return;

    const duplicate: Workspace = {
      id: generateId("ws"),
      name: `${source.name} Copy`,
      layoutId: source.layoutId,
      panes: source.panes.map((p) => ({
        id: generateId("pane"),
        x: p.x,
        y: p.y,
        w: p.w,
        h: p.h,
        view: { ...p.view },
      })),
    };

    set((state) => ({ workspaces: [...state.workspaces, duplicate] }));
  },

  removeWorkspace: (id) => {
    const { workspaces, activeWorkspaceId } = get();
    if (workspaces.length <= 1) return;

    const filtered = workspaces.filter((ws) => ws.id !== id);
    const newActive =
      activeWorkspaceId === id ? filtered[0].id : activeWorkspaceId;

    set({ workspaces: filtered, activeWorkspaceId: newActive });
  },

  renameWorkspace: (id, name) => {
    const { workspaces } = get();
    const others = workspaces.filter((ws) => ws.id !== id);
    const uniqueName = ensureUniqueName(name, others);
    set((state) => ({
      workspaces: state.workspaces.map((ws) =>
        ws.id === id ? { ...ws, name: uniqueName } : ws,
      ),
    }));
  },

  splitPane: (paneIndex, direction) => {
    const ws = get().getActiveWorkspace();
    if (!ws) return;
    if (paneIndex < 0 || paneIndex >= ws.panes.length) return;

    const pane = ws.panes[paneIndex];
    let updatedPane: WorkspacePane;
    let newPane: WorkspacePane;

    if (direction === "horizontal") {
      const halfH = pane.h / 2;
      updatedPane = { ...pane, h: halfH };
      newPane = {
        id: generateId("pane"),
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
        id: generateId("pane"),
        x: pane.x + halfW,
        y: pane.y,
        w: halfW,
        h: pane.h,
        view: { type: "EmptyView" },
      };
    }

    const newPanes = [...ws.panes];
    newPanes[paneIndex] = updatedPane;
    newPanes.splice(paneIndex + 1, 0, newPane);

    set((state) => ({
      workspaces: state.workspaces.map((w) =>
        w.id === ws.id ? { ...w, panes: newPanes } : w,
      ),
    }));
  },

  removePane: (paneIndex) => {
    const ws = get().getActiveWorkspace();
    if (!ws) return;

    const result = removePaneAndRedistribute(ws.panes, paneIndex);
    if (!result) return;

    set((state) => ({
      workspaces: state.workspaces.map((w) =>
        w.id === ws.id ? { ...w, panes: result } : w,
      ),
    }));
  },

  resizePane: (paneIndex, delta) => {
    const ws = get().getActiveWorkspace();
    if (!ws) return;
    if (paneIndex < 0 || paneIndex >= ws.panes.length) return;

    const newPanes = ws.panes.map((p, i) =>
      i === paneIndex ? { ...p, ...delta } : p,
    );

    set((state) => ({
      workspaces: state.workspaces.map((w) =>
        w.id === ws.id ? { ...w, panes: newPanes } : w,
      ),
    }));
  },

  setPaneView: (paneIndex, view) => {
    const ws = get().getActiveWorkspace();
    if (!ws) return;
    if (paneIndex < 0 || paneIndex >= ws.panes.length) return;

    const newPanes = ws.panes.map((p, i) =>
      i === paneIndex ? { ...p, view } : p,
    );

    set((state) => ({
      workspaces: state.workspaces.map((w) =>
        w.id === ws.id ? { ...w, panes: newPanes } : w,
      ),
    }));
  },

  // Save actions per ARCHITECTURE.md section 4.1
  saveWorkspace: () => {
    const ws = get().getActiveWorkspace();
    if (ws) {
      // Also update the layout template so new workspaces get the saved structure
      const updatedLayoutPanes = ws.panes.map((p) => ({
        x: p.x, y: p.y, w: p.w, h: p.h, viewType: p.view.type,
      }));
      set((state) => ({
        layouts: state.layouts.map((l) =>
          l.id === ws.layoutId ? { ...l, panes: updatedLayoutPanes } : l,
        ),
      }));
    }
    persistSession();
  },

  saveAndPropagate: () => {
    const ws = get().getActiveWorkspace();
    if (!ws) return;

    // Update the layout template from the current workspace panes
    const updatedLayoutPanes = ws.panes.map((p) => ({
      x: p.x,
      y: p.y,
      w: p.w,
      h: p.h,
      viewType: p.view.type,
    }));

    set((state) => ({
      layouts: state.layouts.map((l) =>
        l.id === ws.layoutId
          ? { ...l, panes: updatedLayoutPanes }
          : l,
      ),
      // Update all workspaces with the same layoutId
      workspaces: state.workspaces.map((w) => {
        if (w.layoutId !== ws.layoutId) return w;
        // Current workspace keeps its pane IDs; others get new ones
        if (w.id === ws.id) return w;
        return {
          ...w,
          panes: ws.panes.map((p) => ({
            id: generateId("pane"),
            x: p.x,
            y: p.y,
            w: p.w,
            h: p.h,
            view: { ...p.view },
          })),
        };
      }),
    }));

    persistSession();
  },

  saveAsNewLayout: (name) => {
    const ws = get().getActiveWorkspace();
    if (!ws) return;

    const newLayoutId = generateId("layout");
    const newLayout: Layout = {
      id: newLayoutId,
      name,
      panes: ws.panes.map((p) => ({
        x: p.x,
        y: p.y,
        w: p.w,
        h: p.h,
        viewType: p.view.type,
      })),
    };

    set((state) => ({
      layouts: [...state.layouts, newLayout],
      workspaces: state.workspaces.map((w) =>
        w.id === ws.id ? { ...w, layoutId: newLayoutId } : w,
      ),
    }));

    persistSession();
  },

  revertWorkspace: () => {
    const ws = get().getActiveWorkspace();
    if (!ws) return;

    const { layouts } = get();
    const layout = layouts.find((l) => l.id === ws.layoutId);
    if (!layout) return;

    const revertedPanes = layout.panes.map((p) => ({
      id: generateId("pane"),
      x: p.x,
      y: p.y,
      w: p.w,
      h: p.h,
      view: { type: p.viewType },
    }));

    set((state) => ({
      workspaces: state.workspaces.map((w) =>
        w.id === ws.id ? { ...w, panes: revertedPanes } : w,
      ),
    }));
  },

  renameLayout: (layoutId, name) => {
    set((state) => ({
      layouts: state.layouts.map((l) =>
        l.id === layoutId ? { ...l, name } : l,
      ),
    }));
  },

  removeLayout: (layoutId) => {
    const { layouts, workspaces } = get();
    if (layouts.length <= 1) return; // Can't remove last layout

    // Reassign workspaces using this layout to the first remaining layout
    const remaining = layouts.filter((l) => l.id !== layoutId);
    const fallbackId = remaining[0].id;

    set({
      layouts: remaining,
      workspaces: workspaces.map((ws) =>
        ws.layoutId === layoutId ? { ...ws, layoutId: fallbackId } : ws,
      ),
    });
  },

  duplicateLayout: (layoutId, newName) => {
    const layout = get().layouts.find((l) => l.id === layoutId);
    if (!layout) return;

    const newLayout = {
      id: generateId("layout"),
      name: newName,
      panes: layout.panes.map((p) => ({ ...p })),
    };

    set((state) => ({
      layouts: [...state.layouts, newLayout],
    }));
  },

  setDefaultLayout: (layoutId) => {
    // Move the target layout to the first position (first = default)
    set((state) => {
      const target = state.layouts.find((l) => l.id === layoutId);
      if (!target) return state;
      const rest = state.layouts.filter((l) => l.id !== layoutId);
      return { layouts: [target, ...rest] };
    });
  },
}));
