import { create } from "zustand";
import type { Layout, LayoutPane, Workspace, WorkspacePane, ViewInstanceConfig } from "./types";
import { persistSession } from "@/lib/persist-session";
import { removePaneAndRedistribute } from "./pane-removal";
import { useOverridesStore } from "./overrides-store";

/** Convert a workspace pane to a layout pane (preserving view config). */
function toLayoutPane(p: WorkspacePane): LayoutPane {
  return {
    x: p.x,
    y: p.y,
    w: p.w,
    h: p.h,
    viewType: p.view.type,
    viewConfig: { ...p.view },
  };
}

/** Convert a layout pane to a workspace pane (restoring view config). */
function toWorkspacePane(p: LayoutPane): WorkspacePane {
  return {
    id: generateId("pane"),
    x: p.x,
    y: p.y,
    w: p.w,
    h: p.h,
    view: p.viewConfig ? { ...p.viewConfig } : { type: p.viewType },
  };
}

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
  /** Display order for WorkspaceSelectorView. Empty = natural workspaces array order. */
  workspaceDisplayOrder: string[];

  getActiveWorkspace: () => Workspace | undefined;
  /** Return workspaces sorted by display order (respects DnD reordering). */
  getOrderedWorkspaces: () => Workspace[];
  setActiveWorkspace: (id: string) => void;
  addWorkspace: (name: string, layoutId: string) => void;
  /**
   * Clone a workspace and return the IDs needed to propagate per-pane UI state
   * (e.g. `ui-store.hiddenPaneIds`). Returns `null` if the source does not exist.
   * `paneIdMap` is keyed by the source pane ID and maps to the freshly-minted
   * duplicate pane ID, so callers can replay ID-keyed state onto the copy.
   */
  duplicateWorkspace: (
    id: string,
  ) => { newWorkspaceId: string; paneIdMap: Record<string, string> } | null;
  removeWorkspace: (id: string) => void;
  renameWorkspace: (id: string, name: string) => void;
  reorderWorkspaces: (fromId: string, toId: string, position?: "top" | "bottom") => void;

  // Pane manipulation
  splitPane: (paneIndex: number, direction: "horizontal" | "vertical") => void;
  removePane: (paneIndex: number) => void;
  resizePane: (
    paneIndex: number,
    delta: Partial<Pick<WorkspacePane, "x" | "y" | "w" | "h">>,
  ) => void;
  swapPanes: (srcIndex: number, tgtIndex: number) => void;
  setPaneView: (paneIndex: number, view: ViewInstanceConfig) => void;

  // Layout actions
  exportAsNewLayout: (name: string) => void;
  exportToLayout: (layoutId: string) => boolean;

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
  workspaceDisplayOrder: [] as string[],

  getActiveWorkspace: () => {
    const { workspaces, activeWorkspaceId } = get();
    return workspaces.find((ws) => ws.id === activeWorkspaceId);
  },

  getOrderedWorkspaces: () => {
    const { workspaces, workspaceDisplayOrder } = get();
    if (workspaceDisplayOrder.length === 0) return workspaces;
    const orderMap = new Map(workspaceDisplayOrder.map((id, i) => [id, i]));
    return [...workspaces].sort(
      (a, b) => (orderMap.get(a.id) ?? Infinity) - (orderMap.get(b.id) ?? Infinity),
    );
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
      panes: layout.panes.map(toWorkspacePane),
    };

    set((state) => ({
      workspaces: [...state.workspaces, ws],
      workspaceDisplayOrder:
        state.workspaceDisplayOrder.length > 0 ? [...state.workspaceDisplayOrder, ws.id] : [],
    }));
  },

  duplicateWorkspace: (id) => {
    const { workspaces } = get();
    const source = workspaces.find((ws) => ws.id === id);
    if (!source) return null;

    // Build the new panes alongside a source→new pane ID map so the caller can
    // replay ID-keyed state (hidden flags, bar modes, etc.) onto the duplicate.
    const paneIdMap: Record<string, string> = {};
    const newPanes: WorkspacePane[] = source.panes.map((p) => {
      const newId = generateId("pane");
      paneIdMap[p.id] = newId;
      return {
        id: newId,
        x: p.x,
        y: p.y,
        w: p.w,
        h: p.h,
        view: { ...p.view },
      };
    });

    const duplicate: Workspace = {
      id: generateId("ws"),
      name: `${source.name} Copy`,
      panes: newPanes,
    };

    set((state) => ({
      workspaces: [...state.workspaces, duplicate],
      workspaceDisplayOrder:
        state.workspaceDisplayOrder.length > 0
          ? [...state.workspaceDisplayOrder, duplicate.id]
          : [],
    }));

    return { newWorkspaceId: duplicate.id, paneIdMap };
  },

  removeWorkspace: (id) => {
    const { workspaces, activeWorkspaceId } = get();
    if (workspaces.length <= 1) return;

    const victim = workspaces.find((ws) => ws.id === id);
    const filtered = workspaces.filter((ws) => ws.id !== id);
    const newActive = activeWorkspaceId === id ? filtered[0].id : activeWorkspaceId;

    set((state) => ({
      workspaces: filtered,
      activeWorkspaceId: newActive,
      workspaceDisplayOrder: state.workspaceDisplayOrder.filter((wsId) => wsId !== id),
    }));

    if (victim) {
      const overrides = useOverridesStore.getState();
      for (const p of victim.panes) overrides.clearAll(p.id);
    }
  },

  renameWorkspace: (id, name) => {
    const { workspaces } = get();
    const others = workspaces.filter((ws) => ws.id !== id);
    const uniqueName = ensureUniqueName(name, others);
    set((state) => ({
      workspaces: state.workspaces.map((ws) => (ws.id === id ? { ...ws, name: uniqueName } : ws)),
    }));
  },

  reorderWorkspaces: (fromId, toId, position = "top") => {
    if (fromId === toId) return;
    const { workspaces, workspaceDisplayOrder } = get();
    // Materialise display order if empty (first reorder)
    const order =
      workspaceDisplayOrder.length > 0 ? [...workspaceDisplayOrder] : workspaces.map((ws) => ws.id);
    const fromIdx = order.indexOf(fromId);
    const toIdx = order.indexOf(toId);
    if (fromIdx === -1 || toIdx === -1) return;

    order.splice(fromIdx, 1);
    const insertIdx = order.indexOf(toId);
    order.splice(position === "bottom" ? insertIdx + 1 : insertIdx, 0, fromId);
    set({ workspaceDisplayOrder: order });
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
      workspaces: state.workspaces.map((w) => (w.id === ws.id ? { ...w, panes: newPanes } : w)),
    }));
  },

  removePane: (paneIndex) => {
    const ws = get().getActiveWorkspace();
    if (!ws) return;

    const removedPaneId = ws.panes[paneIndex]?.id;
    const result = removePaneAndRedistribute(ws.panes, paneIndex);
    if (!result) return;

    set((state) => ({
      workspaces: state.workspaces.map((w) => (w.id === ws.id ? { ...w, panes: result } : w)),
    }));

    if (removedPaneId) useOverridesStore.getState().clearAll(removedPaneId);
  },

  resizePane: (paneIndex, delta) => {
    const ws = get().getActiveWorkspace();
    if (!ws) return;
    if (paneIndex < 0 || paneIndex >= ws.panes.length) return;

    const newPanes = ws.panes.map((p, i) => (i === paneIndex ? { ...p, ...delta } : p));

    set((state) => ({
      workspaces: state.workspaces.map((w) => (w.id === ws.id ? { ...w, panes: newPanes } : w)),
    }));
  },

  swapPanes: (srcIndex, tgtIndex) => {
    const ws = get().getActiveWorkspace();
    if (!ws) return;
    if (srcIndex < 0 || srcIndex >= ws.panes.length) return;
    if (tgtIndex < 0 || tgtIndex >= ws.panes.length) return;

    const src = ws.panes[srcIndex];
    const tgt = ws.panes[tgtIndex];
    const srcPos = { x: src.x, y: src.y, w: src.w, h: src.h };
    const tgtPos = { x: tgt.x, y: tgt.y, w: tgt.w, h: tgt.h };

    const newPanes = ws.panes.map((p, i) => {
      if (i === srcIndex) return { ...p, ...tgtPos };
      if (i === tgtIndex) return { ...p, ...srcPos };
      return p;
    });

    set((state) => ({
      workspaces: state.workspaces.map((w) => (w.id === ws.id ? { ...w, panes: newPanes } : w)),
    }));
  },

  setPaneView: (paneIndex, view) => {
    const ws = get().getActiveWorkspace();
    if (!ws) return;
    if (paneIndex < 0 || paneIndex >= ws.panes.length) return;

    const prev = ws.panes[paneIndex];
    const viewTypeChanged = prev.view.type !== view.type;
    const newPanes = ws.panes.map((p, i) => (i === paneIndex ? { ...p, view } : p));

    set((state) => ({
      workspaces: state.workspaces.map((w) => (w.id === ws.id ? { ...w, panes: newPanes } : w)),
    }));

    // View 타입이 바뀌면 view 인스턴스 오버라이드는 의미가 없어지므로 비운다.
    // Pane 인스턴스 오버라이드(controlBar 모드 등)는 슬롯 속성이라 유지.
    if (viewTypeChanged) useOverridesStore.getState().clearViewOverride(prev.id);
  },

  // Layout actions per ARCHITECTURE.md section 4.1
  exportAsNewLayout: (name) => {
    const ws = get().getActiveWorkspace();
    if (!ws) return;

    const newLayout: Layout = {
      id: generateId("layout"),
      name,
      panes: ws.panes.map(toLayoutPane),
    };

    set((state) => ({ layouts: [...state.layouts, newLayout] }));
    persistSession();
  },

  exportToLayout: (layoutId) => {
    const ws = get().getActiveWorkspace();
    if (!ws) return false;

    const { layouts } = get();
    if (!layouts.some((l) => l.id === layoutId)) return false;

    const updatedPanes = ws.panes.map(toLayoutPane);

    set((state) => ({
      layouts: state.layouts.map((l) => (l.id === layoutId ? { ...l, panes: updatedPanes } : l)),
    }));
    persistSession();
    return true;
  },

  renameLayout: (layoutId, name) => {
    set((state) => ({
      layouts: state.layouts.map((l) => (l.id === layoutId ? { ...l, name } : l)),
    }));
  },

  removeLayout: (layoutId) => {
    const { layouts } = get();
    if (layouts.length <= 1) return; // Can't remove last layout

    set({ layouts: layouts.filter((l) => l.id !== layoutId) });
  },

  duplicateLayout: (layoutId, newName) => {
    const layout = get().layouts.find((l) => l.id === layoutId);
    if (!layout) return;

    const newLayout = {
      id: generateId("layout"),
      name: newName,
      panes: layout.panes.map((p) => ({
        ...p,
        ...(p.viewConfig ? { viewConfig: { ...p.viewConfig } } : {}),
      })),
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
