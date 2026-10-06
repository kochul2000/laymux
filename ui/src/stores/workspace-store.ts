import { create } from "zustand";
import type {
  Layout,
  LayoutPane,
  PaneLayer,
  Workspace,
  WorkspacePane,
  ViewInstanceConfig,
} from "./types";
import { persistSession } from "@/lib/persist-session";
import { removePaneAndRedistribute } from "./pane-removal";
import { useOverridesStore } from "./overrides-store";
import { useCwdPropagateStore } from "./cwd-propagate-store";
import { useTerminalRestartStore } from "./terminal-restart-store";
import { resolvePaneCwd } from "@/lib/pane-cwd";
import { clearComposerHistoryForWorkspace } from "@/lib/terminal-input-composer-state";
import {
  activeLayer,
  activeLayerIndex,
  findSlotIndex,
  insertLayer,
  layoutPaneLayers,
  makeLayoutPane,
  makeSlot,
  moveLayerWithin,
  removeLayer,
  setActiveLayer as setActiveLayerOf,
  updateLayerView,
} from "@/lib/pane-layers";

/** A new pane copies configuration, but cannot own the source's conversation. */
function copyViewConfig(view: ViewInstanceConfig): ViewInstanceConfig {
  const copy = { ...view };
  delete copy.lastClaudeSession;
  delete copy.lastCodexSession;
  delete copy.lastGrokSession;
  delete copy.lastAgentFresh;
  return copy;
}

/** Convert a workspace slot (all of its layers) to a layout template. */
function toLayoutPane(p: WorkspacePane): LayoutPane {
  return makeLayoutPane(
    p,
    p.layers.map((layer) => ({
      viewType: layer.view.type,
      viewConfig: copyViewConfig(layer.view),
    })),
    activeLayerIndex(p),
  );
}

/** Also sanitize old persisted templates when creating an independent pane. */
function toWorkspacePane(p: LayoutPane): WorkspacePane {
  const slotId = generateId("pane");
  const { layers, activeIndex } = layoutPaneLayers(p);
  // Creation rule (ADR-0295): the first layer shares the slot id.
  const paneLayers: PaneLayer[] = layers.map((layer, index) => ({
    id: index === 0 ? slotId : generateId("pane"),
    view: layer.viewConfig ? copyViewConfig(layer.viewConfig) : { type: layer.viewType },
  }));
  return {
    id: slotId,
    x: p.x,
    y: p.y,
    w: p.w,
    h: p.h,
    layers: paneLayers,
    activeLayerId: paneLayers[activeIndex].id,
  };
}

/**
 * Drop the per-content side state a removed layer owns. When the layer shares
 * its id with a surviving slot, only the view-level override goes — the
 * pane-level override (control bar mode) belongs to the slot (ADR-0295).
 */
function forgetLayerState(layerId: string, keepSlotOverride: boolean): void {
  const overrides = useOverridesStore.getState();
  if (keepSlotOverride) overrides.clearViewOverride(layerId);
  else overrides.clearAll(layerId);
  // 1회성 CWD 전파 요청 버스 정리(issue #296 P3-a).
  useCwdPropagateStore.getState().clear(layerId);
  // 재시작 요청도 콘텐츠 수명에 묶인다(ADR-0113).
  useTerminalRestartStore.getState().forgetRestart(layerId);
}

/** Drop the side state of a removed slot and every one of its layers. */
function forgetSlotState(slot: WorkspacePane): void {
  useOverridesStore.getState().clearAll(slot.id);
  for (const layer of slot.layers) forgetLayerState(layer.id, false);
}

/** Replace one slot of one workspace. */
function replaceSlot(
  workspaces: Workspace[],
  workspaceId: string,
  slotIndex: number,
  slot: WorkspacePane,
): Workspace[] {
  return workspaces.map((w) =>
    w.id === workspaceId ? { ...w, panes: w.panes.map((p, i) => (i === slotIndex ? slot : p)) } : w,
  );
}

function generateId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function normalizeWorkspaceName(name: string): string {
  return name.trim().replace(/\s+/g, "-");
}

/** Return a name that doesn't collide with existing workspace names. */
function ensureUniqueName(name: string, existing: { name: string }[]): string {
  const names = new Set(existing.map((ws) => ws.name));
  if (!names.has(name)) return name;
  let n = 2;
  while (names.has(`${name}-${n}`)) n++;
  return `${name}-${n}`;
}

// First-install default: a two-pane, side-by-side split so the workspace
// opens ready to hold two views.
const defaultLayout: Layout = {
  id: "default-layout",
  name: "Default",
  panes: [
    { x: 0, y: 0, w: 0.5, h: 1, viewType: "EmptyView" },
    { x: 0.5, y: 0, w: 0.5, h: 1, viewType: "EmptyView" },
  ],
};

const defaultWorkspace: Workspace = {
  id: "ws-default",
  name: "Default",
  panes: [
    makeSlot(generateId("pane"), { x: 0, y: 0, w: 0.5, h: 1 }, { type: "EmptyView" }),
    makeSlot(generateId("pane"), { x: 0.5, y: 0, w: 0.5, h: 1 }, { type: "EmptyView" }),
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

  // Pane manipulation (paneIndex = slot index, ADR-0295)
  splitPane: (paneIndex: number, direction: "horizontal" | "vertical") => void;
  /**
   * Close one layer of the slot: `layerId`, or the active layer. Closing the
   * slot's last layer removes the slot and redistributes its space. The only
   * layer of the only slot cannot be closed.
   */
  removePane: (paneIndex: number, layerId?: string) => void;
  /**
   * Remove the whole slot with all of its layers and redistribute its space.
   * Used when the slot's geometry itself goes away (boundary collapse).
   */
  removeSlot: (paneIndex: number) => void;
  /**
   * Stack a new layer on the slot right after its active layer and activate it
   * (ADR-0295). Returns the new layer id, or null for an invalid slot.
   */
  stackPane: (paneIndex: number, view?: ViewInstanceConfig) => string | null;
  /**
   * Make `layerId` the active layer of its slot in `workspaceId`. A pure state
   * setter: focus commits go through `workspace-transition.activatePaneLayer`.
   */
  setActiveLayer: (workspaceId: string, layerId: string) => boolean;
  resizePane: (
    paneIndex: number,
    delta: Partial<Pick<WorkspacePane, "x" | "y" | "w" | "h">>,
  ) => void;
  swapPanes: (srcIndex: number, tgtIndex: number) => void;
  /**
   * 드래그한 pane 을 다른 워크스페이스로 이동한다 (issue #380).
   * 소스 워크스페이스에서 제거(공간은 인접 pane 이 흡수, removePane 과 동일)하고
   * 대상 워크스페이스의 가장 큰 pane 을 반으로 분할해 그 자리에 옮겨온 pane 을 둔다.
   * pane id 와 view 설정은 보존된다. 소스가 1개뿐이면(빈 워크스페이스 방지) 무시.
   */
  movePaneToWorkspace: (paneId: string, targetWorkspaceId: string) => void;
  /**
   * Move a layer to slot `targetSlotId` of the active workspace (ADR-0295).
   * `index` is the position among the target's other layers (default: after
   * its active layer). Inside one slot this reorders; across slots the moved
   * layer becomes active in the target, and a source left empty is removed
   * with its space redistributed. Returns false when nothing changed.
   */
  moveLayer: (layerId: string, targetSlotId: string, index?: number) => boolean;
  /**
   * Pull a layer out of its stack into a new slot that splits the source slot
   * like `splitPane` (ADR-0295). Returns the new slot id, or null when the
   * layer is not stacked.
   */
  extractLayer: (layerId: string, direction: "horizontal" | "vertical") => string | null;
  /**
   * Stack every layer of slot `srcSlotId` onto slot `tgtSlotId` right after the
   * target's active layer, show the source's active layer and remove the
   * source slot (ADR-0295). Returns false when nothing changed.
   */
  mergeSlotIntoStack: (srcSlotId: string, tgtSlotId: string) => boolean;
  /** Replace the view of `layerId` (default: the active layer) in the slot. */
  setPaneView: (paneIndex: number, view: ViewInstanceConfig, layerId?: string) => void;

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

    const uniqueName = ensureUniqueName(normalizeWorkspaceName(name), workspaces);

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
    // The map covers slot ids (pane overrides) and layer ids (hidden flags,
    // view overrides); a layer that shares its slot's id keeps sharing it.
    const paneIdMap: Record<string, string> = {};
    const newPanes: WorkspacePane[] = source.panes.map((p) => {
      const newSlotId = generateId("pane");
      paneIdMap[p.id] = newSlotId;
      const layers = p.layers.map((layer) => {
        const newLayerId = layer.id === p.id ? newSlotId : generateId("pane");
        paneIdMap[layer.id] = newLayerId;
        return { id: newLayerId, view: copyViewConfig(layer.view) };
      });
      return {
        id: newSlotId,
        x: p.x,
        y: p.y,
        w: p.w,
        h: p.h,
        layers,
        activeLayerId: paneIdMap[activeLayer(p).id],
      };
    });

    const duplicate: Workspace = {
      id: generateId("ws"),
      name: ensureUniqueName(source.name ? `${source.name}-Copy` : "Copy", workspaces),
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
      // 워크스페이스 단위 Composer history 버킷은 pane 보다 오래 살기 때문에
      // 워크스페이스가 사라질 때 여기서 폐기한다(ADR-0055 수명 규칙).
      clearComposerHistoryForWorkspace(id);
      // 워크스페이스 삭제도 다중 pane 제거 경로이므로 슬롯·레이어의 오버라이드,
      // 1회성 CWD 전파 요청(issue #296 P3), 재시작 요청(ADR-0113)을 정리한다.
      for (const p of victim.panes) forgetSlotState(p);
    }
  },

  renameWorkspace: (id, name) => {
    const { workspaces } = get();
    const others = workspaces.filter((ws) => ws.id !== id);
    const uniqueName = ensureUniqueName(normalizeWorkspaceName(name), others);
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
      newPane = makeSlot(
        generateId("pane"),
        { x: pane.x, y: pane.y + halfH, w: pane.w, h: halfH },
        { type: "EmptyView" },
      );
    } else {
      const halfW = pane.w / 2;
      updatedPane = { ...pane, w: halfW };
      newPane = makeSlot(
        generateId("pane"),
        { x: pane.x + halfW, y: pane.y, w: halfW, h: pane.h },
        { type: "EmptyView" },
      );
    }

    const newPanes = [...ws.panes];
    newPanes[paneIndex] = updatedPane;
    newPanes.splice(paneIndex + 1, 0, newPane);

    set((state) => ({
      workspaces: state.workspaces.map((w) => (w.id === ws.id ? { ...w, panes: newPanes } : w)),
    }));

    // 새 pane 의 첫 터미널 세션은 **분할한 그 pane** 의 CWD 에서 시작한다(ADR-0140).
    // 시드는 재시작 요청 버스에 실린다 — "이 pane 의 다음 세션을 이 CWD 로 새로
    // 시작하라"는 payload·수명이 재시작과 같기 때문이다. 새 pane 은 EmptyView 로
    // 태어나므로 시드는 사용자가 터미널을 고를 때까지 기다렸다가 소비된다.
    // 스택 슬롯이면 기준은 그 슬롯의 활성 레이어다(ADR-0295).
    const seedCwd = resolvePaneCwd(activeLayer(pane));
    if (seedCwd) {
      useTerminalRestartStore.getState().requestRestart(newPane.id, seedCwd);
    }
  },

  stackPane: (paneIndex, view = { type: "EmptyView" }) => {
    const ws = get().getActiveWorkspace();
    if (!ws) return null;
    const pane = ws.panes[paneIndex];
    if (!pane) return null;

    const layer: PaneLayer = { id: generateId("pane"), view };
    const updated = insertLayer(pane, layer);
    set((state) => ({ workspaces: replaceSlot(state.workspaces, ws.id, paneIndex, updated) }));

    // 새 레이어의 첫 터미널 세션은 누른 슬롯의 활성 레이어 CWD 에서 시작한다
    // (ADR-0140 을 ADR-0295 가 확장). 분할과 같은 재시작 요청 버스를 쓴다.
    const seedCwd = resolvePaneCwd(activeLayer(pane));
    if (seedCwd) {
      useTerminalRestartStore.getState().requestRestart(layer.id, seedCwd);
    }
    return layer.id;
  },

  setActiveLayer: (workspaceId, layerId) => {
    const ws = get().workspaces.find((w) => w.id === workspaceId);
    if (!ws) return false;
    const slotIndex = ws.panes.findIndex((p) => p.layers.some((layer) => layer.id === layerId));
    if (slotIndex < 0) return false;
    const pane = ws.panes[slotIndex];
    const updated = setActiveLayerOf(pane, layerId);
    if (updated !== pane) {
      set((state) => ({ workspaces: replaceSlot(state.workspaces, ws.id, slotIndex, updated) }));
    }
    return true;
  },

  removePane: (paneIndex, layerId) => {
    const ws = get().getActiveWorkspace();
    if (!ws) return;
    const slot = ws.panes[paneIndex];
    if (!slot) return;
    const targetLayerId = layerId ?? activeLayer(slot).id;
    if (!slot.layers.some((layer) => layer.id === targetLayerId)) return;

    // A stacked slot loses one layer and keeps its place (ADR-0295).
    const remaining = removeLayer(slot, targetLayerId);
    if (remaining) {
      set((state) => ({ workspaces: replaceSlot(state.workspaces, ws.id, paneIndex, remaining) }));
      forgetLayerState(targetLayerId, targetLayerId === slot.id);
      return;
    }

    get().removeSlot(paneIndex);
  },

  removeSlot: (paneIndex) => {
    const ws = get().getActiveWorkspace();
    if (!ws) return;
    const slot = ws.panes[paneIndex];
    if (!slot) return;

    const result = removePaneAndRedistribute(ws.panes, paneIndex);
    if (!result) return;

    set((state) => ({
      workspaces: state.workspaces.map((w) => (w.id === ws.id ? { ...w, panes: result } : w)),
    }));
    forgetSlotState(slot);
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

  movePaneToWorkspace: (paneId, targetWorkspaceId) => {
    const { workspaces } = get();
    const source = workspaces.find((w) => findSlotIndex(w.panes, paneId) >= 0);
    const target = workspaces.find((w) => w.id === targetWorkspaceId);
    if (!source || !target) return;
    // 같은 워크스페이스로의 이동은 무의미하고, 소스를 비우는 이동은 막는다.
    if (source.id === target.id) return;
    if (source.panes.length <= 1) return;

    const srcIndex = findSlotIndex(source.panes, paneId);
    const moved = source.panes[srcIndex];

    // 1) 소스에서 제거 — removePane 과 동일하게 인접 pane 이 공간을 흡수한다.
    const newSourcePanes = removePaneAndRedistribute(source.panes, srcIndex);
    if (!newSourcePanes) return;

    // 2) 대상의 가장 큰 pane 을 반으로 나눠 그 자리에 옮겨온 pane 을 둔다.
    //    (splitPane 과 같은 기하학: 더 긴 축을 따라 절반으로 가른다.)
    let hostIdx = 0;
    let hostArea = -1;
    target.panes.forEach((p, i) => {
      const area = p.w * p.h;
      if (area > hostArea) {
        hostArea = area;
        hostIdx = i;
      }
    });
    const host = target.panes[hostIdx];
    const splitVertical = host.w >= host.h; // 가로가 더 길면 좌우로 분할
    let hostSlot: Pick<WorkspacePane, "x" | "y" | "w" | "h">;
    let movedSlot: Pick<WorkspacePane, "x" | "y" | "w" | "h">;
    if (splitVertical) {
      const halfW = host.w / 2;
      hostSlot = { x: host.x, y: host.y, w: halfW, h: host.h };
      movedSlot = { x: host.x + halfW, y: host.y, w: halfW, h: host.h };
    } else {
      const halfH = host.h / 2;
      hostSlot = { x: host.x, y: host.y, w: host.w, h: halfH };
      movedSlot = { x: host.x, y: host.y + halfH, w: host.w, h: halfH };
    }

    // 슬롯 통째(모든 레이어)를 옮긴다(ADR-0295).
    const movedPane: WorkspacePane = { ...moved, ...movedSlot };
    const newTargetPanes = target.panes.map((p, i) => (i === hostIdx ? { ...p, ...hostSlot } : p));
    newTargetPanes.splice(hostIdx + 1, 0, movedPane);

    set((state) => ({
      workspaces: state.workspaces.map((w) => {
        if (w.id === source.id) return { ...w, panes: newSourcePanes };
        if (w.id === target.id) return { ...w, panes: newTargetPanes };
        return w;
      }),
    }));
  },

  moveLayer: (layerId, targetSlotId, index) => {
    const ws = get().getActiveWorkspace();
    if (!ws) return false;
    const srcIndex = ws.panes.findIndex((p) => p.layers.some((layer) => layer.id === layerId));
    const tgtIndex = ws.panes.findIndex((p) => p.id === targetSlotId);
    if (srcIndex < 0 || tgtIndex < 0) return false;
    const src = ws.panes[srcIndex];

    if (srcIndex === tgtIndex) {
      if (index === undefined) return false;
      const reordered = moveLayerWithin(src, layerId, index);
      if (reordered === src) return false;
      set((state) => ({ workspaces: replaceSlot(state.workspaces, ws.id, srcIndex, reordered) }));
      return true;
    }

    const layer = src.layers.find((candidate) => candidate.id === layerId)!;
    let panes = [...ws.panes];
    panes[tgtIndex] = insertLayer(ws.panes[tgtIndex], layer, { index });
    const remaining = removeLayer(src, layerId);
    if (remaining) {
      panes[srcIndex] = remaining;
    } else {
      const redistributed = removePaneAndRedistribute(panes, srcIndex);
      if (!redistributed) return false;
      panes = redistributed;
    }
    set((state) => ({
      workspaces: state.workspaces.map((w) => (w.id === ws.id ? { ...w, panes } : w)),
    }));
    // An emptied source slot is gone; its layer lives on in the target.
    if (!remaining) useOverridesStore.getState().clearPaneOverride(src.id);
    return true;
  },

  extractLayer: (layerId, direction) => {
    const ws = get().getActiveWorkspace();
    if (!ws) return null;
    const srcIndex = ws.panes.findIndex((p) => p.layers.some((layer) => layer.id === layerId));
    if (srcIndex < 0) return null;
    const src = ws.panes[srcIndex];
    const remaining = removeLayer(src, layerId);
    if (!remaining || remaining === src) return null;
    const layer = src.layers.find((candidate) => candidate.id === layerId)!;

    // Creation rule: the new slot shares its layer's id when that id is free.
    const newSlotId = ws.panes.some((p) => p.id === layerId) ? generateId("pane") : layerId;
    let kept: Pick<WorkspacePane, "x" | "y" | "w" | "h">;
    let rect: Pick<WorkspacePane, "x" | "y" | "w" | "h">;
    if (direction === "horizontal") {
      const halfH = src.h / 2;
      kept = { x: src.x, y: src.y, w: src.w, h: halfH };
      rect = { x: src.x, y: src.y + halfH, w: src.w, h: halfH };
    } else {
      const halfW = src.w / 2;
      kept = { x: src.x, y: src.y, w: halfW, h: src.h };
      rect = { x: src.x + halfW, y: src.y, w: halfW, h: src.h };
    }
    const newSlot: WorkspacePane = {
      id: newSlotId,
      ...rect,
      layers: [layer],
      activeLayerId: layer.id,
    };
    const panes = [...ws.panes];
    panes[srcIndex] = { ...remaining, ...kept };
    panes.splice(srcIndex + 1, 0, newSlot);
    set((state) => ({
      workspaces: state.workspaces.map((w) => (w.id === ws.id ? { ...w, panes } : w)),
    }));
    return newSlotId;
  },

  mergeSlotIntoStack: (srcSlotId, tgtSlotId) => {
    const ws = get().getActiveWorkspace();
    if (!ws || srcSlotId === tgtSlotId) return false;
    const srcIndex = ws.panes.findIndex((p) => p.id === srcSlotId);
    const tgtIndex = ws.panes.findIndex((p) => p.id === tgtSlotId);
    if (srcIndex < 0 || tgtIndex < 0) return false;
    const src = ws.panes[srcIndex];

    let target = ws.panes[tgtIndex];
    let at = activeLayerIndex(target) + 1;
    for (const layer of src.layers) {
      target = insertLayer(target, layer, { index: at, activate: false });
      at += 1;
    }
    target = setActiveLayerOf(target, activeLayer(src).id);
    const panes = [...ws.panes];
    panes[tgtIndex] = target;
    const redistributed = removePaneAndRedistribute(panes, srcIndex);
    if (!redistributed) return false;
    set((state) => ({
      workspaces: state.workspaces.map((w) =>
        w.id === ws.id ? { ...w, panes: redistributed } : w,
      ),
    }));
    useOverridesStore.getState().clearPaneOverride(src.id);
    return true;
  },

  setPaneView: (paneIndex, view, layerId) => {
    const ws = get().getActiveWorkspace();
    if (!ws) return;
    if (paneIndex < 0 || paneIndex >= ws.panes.length) return;

    const slot = ws.panes[paneIndex];
    const prev = layerId ? slot.layers.find((layer) => layer.id === layerId) : activeLayer(slot);
    if (!prev) return;
    const viewTypeChanged = prev.view.type !== view.type;
    const updated = updateLayerView(slot, prev.id, view);

    set((state) => ({ workspaces: replaceSlot(state.workspaces, ws.id, paneIndex, updated) }));

    // View 타입이 바뀌면 view 인스턴스 오버라이드는 의미가 없어지므로 비운다.
    // Pane 인스턴스 오버라이드(controlBar 모드 등)는 슬롯 속성이라 유지.
    if (viewTypeChanged) {
      useOverridesStore.getState().clearViewOverride(prev.id);
      // 미소비 재시작 요청도 같이 버린다(ADR-0113). pane id 는 살아 있으므로
      // 기동 시 gcStale 이 잡지 못하고, 나중에 다시 TerminalView 로 바꾸면
      // 옛 cwd 로 fresh 재시작이 걸려 세션 복원을 건너뛴다.
      if (prev.view.type === "TerminalView") {
        useTerminalRestartStore.getState().forgetRestart(prev.id);
      }
    }
  },

  // Layout actions per docs/architecture/overview.md §4.1
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
        ...(p.viewConfig ? { viewConfig: copyViewConfig(p.viewConfig) } : {}),
        ...(p.layers
          ? {
              layers: p.layers.map((layer) => ({
                ...layer,
                ...(layer.viewConfig ? { viewConfig: copyViewConfig(layer.viewConfig) } : {}),
              })),
            }
          : {}),
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
