/**
 * Pane stack model helpers (ADR-0295).
 *
 * A workspace pane is a **slot**: it owns the geometry and an ordered list of
 * content **layers**, exactly one of which is active (shown). Every read of a
 * slot's content and every structural layer mutation goes through this module,
 * so the slot invariants — at least one layer, `activeLayerId` names a layer —
 * live in one place instead of being re-derived by callers.
 *
 * All functions are pure: they never touch a store and never mutate input.
 */
import type {
  LayoutLayer,
  LayoutPane,
  PaneLayer,
  ViewInstanceConfig,
  Workspace,
  WorkspacePane,
} from "@/stores/types";

export interface SlotRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Build a single-layer slot whose layer shares the slot id (the creation rule). */
export function makeSlot(id: string, rect: SlotRect, view: ViewInstanceConfig): WorkspacePane {
  return {
    id,
    x: rect.x,
    y: rect.y,
    w: rect.w,
    h: rect.h,
    layers: [{ id, view }],
    activeLayerId: id,
  };
}

/**
 * Adapt a plain `{ id, view, x, y, w, h }` pane (a dock pane) to a single-layer
 * slot so it can be drawn by the slot-based grid. Dock stacking is out of scope.
 */
export function singleLayerSlot(pane: SlotRect & { id: string; view: ViewInstanceConfig }) {
  return makeSlot(pane.id, pane, pane.view);
}

/** Index of the active layer. Falls back to 0 when `activeLayerId` is stale. */
export function activeLayerIndex(pane: WorkspacePane): number {
  const index = pane.layers.findIndex((layer) => layer.id === pane.activeLayerId);
  return index >= 0 ? index : 0;
}

/** The slot's visible content. */
export function activeLayer(pane: WorkspacePane): PaneLayer {
  return pane.layers[activeLayerIndex(pane)];
}

/** True when the slot holds two or more layers (the stack UI is shown). */
export function isStacked(pane: WorkspacePane): boolean {
  return pane.layers.length > 1;
}

/** One content layer together with the slot that holds it. */
export interface LayerEntry {
  slot: WorkspacePane;
  /** Slot index in `Workspace.panes` (the Automation `paneIndex`). */
  slotIndex: number;
  layer: PaneLayer;
  /** Position of the layer inside its slot stack. */
  layerIndex: number;
  /** Whether this layer is the slot's active (visible) layer. */
  active: boolean;
}

/** Flatten slots into content layers, in slot array order then stack order. */
export function layerEntries(panes: readonly WorkspacePane[]): LayerEntry[] {
  const entries: LayerEntry[] = [];
  panes.forEach((slot, slotIndex) => {
    const activeIndex = activeLayerIndex(slot);
    slot.layers.forEach((layer, layerIndex) => {
      entries.push({ slot, slotIndex, layer, layerIndex, active: layerIndex === activeIndex });
    });
  });
  return entries;
}

/** Every layer id in the slots, in `layerEntries` order. */
export function allLayerIds(panes: readonly WorkspacePane[]): string[] {
  return layerEntries(panes).map((entry) => entry.layer.id);
}

/** The active layer of every slot, in slot order. */
export function activeLayers(panes: readonly WorkspacePane[]): PaneLayer[] {
  return panes.map(activeLayer);
}

/** Find the entry for a layer id, or null. */
export function findLayerEntry(
  panes: readonly WorkspacePane[],
  layerId: string,
): LayerEntry | null {
  return layerEntries(panes).find((entry) => entry.layer.id === layerId) ?? null;
}

/**
 * Resolve a slot from either its slot id or one of its layer ids (ADR-0295:
 * id-based entry points accept both). Returns -1 when nothing matches.
 */
export function findSlotIndex(panes: readonly WorkspacePane[], id: string): number {
  const bySlot = panes.findIndex((pane) => pane.id === id);
  if (bySlot >= 0) return bySlot;
  return panes.findIndex((pane) => pane.layers.some((layer) => layer.id === id));
}

/** Locate a layer across workspaces. */
export function findLayerInWorkspaces(
  workspaces: readonly Workspace[],
  layerId: string,
): { workspace: Workspace; entry: LayerEntry } | null {
  for (const workspace of workspaces) {
    const entry = findLayerEntry(workspace.panes, layerId);
    if (entry) return { workspace, entry };
  }
  return null;
}

// ─── Pure slot mutations ────────────────────────────────────────────

/**
 * Insert `layer` into the slot. By default it goes right after the active
 * layer and becomes active (the Stack action).
 */
export function insertLayer(
  pane: WorkspacePane,
  layer: PaneLayer,
  options: { index?: number; activate?: boolean } = {},
): WorkspacePane {
  const { activate = true } = options;
  const index = clampIndex(options.index ?? activeLayerIndex(pane) + 1, pane.layers.length);
  const layers = [...pane.layers];
  layers.splice(index, 0, layer);
  return { ...pane, layers, activeLayerId: activate ? layer.id : pane.activeLayerId };
}

/**
 * Remove a layer. Returns `null` when it was the slot's only layer (the caller
 * removes the slot). When the active layer is removed, the next layer — or the
 * previous one when it was last — becomes active. Unknown ids return the slot
 * unchanged.
 */
export function removeLayer(pane: WorkspacePane, layerId: string): WorkspacePane | null {
  const index = pane.layers.findIndex((layer) => layer.id === layerId);
  if (index < 0) return pane;
  if (pane.layers.length === 1) return null;
  const layers = pane.layers.filter((layer) => layer.id !== layerId);
  const activeLayerId =
    layerId === activeLayer(pane).id
      ? layers[Math.min(index, layers.length - 1)].id
      : pane.activeLayerId;
  return { ...pane, layers, activeLayerId };
}

/** Make `layerId` active. Unknown ids and no-op changes return the same object. */
export function setActiveLayer(pane: WorkspacePane, layerId: string): WorkspacePane {
  if (pane.activeLayerId === layerId) return pane;
  if (!pane.layers.some((layer) => layer.id === layerId)) return pane;
  return { ...pane, activeLayerId: layerId };
}

/** Step the active layer around the stack ring. Single-layer slots are unchanged. */
export function cycleActiveLayer(pane: WorkspacePane, delta: number): WorkspacePane {
  if (pane.layers.length < 2) return pane;
  const count = pane.layers.length;
  const next = (((activeLayerIndex(pane) + delta) % count) + count) % count;
  return setActiveLayer(pane, pane.layers[next].id);
}

/** Replace one layer's view. Unknown ids return the same object. */
export function updateLayerView(
  pane: WorkspacePane,
  layerId: string,
  view: ViewInstanceConfig,
): WorkspacePane {
  if (!pane.layers.some((layer) => layer.id === layerId)) return pane;
  return {
    ...pane,
    layers: pane.layers.map((layer) => (layer.id === layerId ? { ...layer, view } : layer)),
  };
}

/** Move a layer to `toIndex` inside the same stack. The active layer is unchanged. */
export function moveLayerWithin(
  pane: WorkspacePane,
  layerId: string,
  toIndex: number,
): WorkspacePane {
  const from = pane.layers.findIndex((layer) => layer.id === layerId);
  if (from < 0) return pane;
  const layers = [...pane.layers];
  const [moved] = layers.splice(from, 1);
  const to = clampIndex(toIndex, layers.length);
  if (to === from) return pane;
  layers.splice(to, 0, moved);
  return { ...pane, layers };
}

function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(index)) return length;
  return Math.max(0, Math.min(length, Math.trunc(index)));
}

// ─── Persistence (ADR-0295 §영속과 호환) ─────────────────────────────

/** On-disk pane: the legacy compact form or the stacked form. */
export interface PersistedWorkspacePane {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  view?: ViewInstanceConfig;
  layers?: PaneLayer[];
  activeLayerId?: string;
}

/**
 * Serialize a slot. A single layer whose id equals the slot id is written in the
 * legacy compact `{ id, x, y, w, h, view }` form, so files of users who never
 * stack stay byte-for-byte the same shape and remain readable by older builds.
 */
export function toPersistedPane(
  pane: WorkspacePane,
  mapView: (view: ViewInstanceConfig, layer: PaneLayer) => ViewInstanceConfig = (view) => view,
): PersistedWorkspacePane {
  const rect = { id: pane.id, x: pane.x, y: pane.y, w: pane.w, h: pane.h };
  if (pane.layers.length === 1 && pane.layers[0].id === pane.id) {
    return { ...rect, view: mapView(pane.layers[0].view, pane.layers[0]) };
  }
  return {
    ...rect,
    layers: pane.layers.map((layer) => ({ id: layer.id, view: mapView(layer.view, layer) })),
    activeLayerId: activeLayer(pane).id,
  };
}

function isViewConfig(value: unknown): value is ViewInstanceConfig {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

/**
 * Read either on-disk form into a canonical slot. Returns `null` when the pane
 * carries no usable content (the caller drops it, as lenient loading did).
 * `newId` mints ids for layers that arrive without one.
 */
export function normalizeWorkspacePane(
  raw: PersistedWorkspacePane,
  newId: () => string,
): WorkspacePane | null {
  const rect = { x: raw.x, y: raw.y, w: raw.w, h: raw.h };
  const id = raw.id || newId();
  const rawLayers = Array.isArray(raw.layers) ? raw.layers : [];
  const layers: PaneLayer[] = rawLayers
    .filter((layer) => layer && isViewConfig(layer.view))
    .map((layer) => ({ id: layer.id || newId(), view: { ...layer.view } }));
  if (layers.length > 0) {
    const activeLayerId = layers.some((layer) => layer.id === raw.activeLayerId)
      ? (raw.activeLayerId as string)
      : layers[0].id;
    return { id, ...rect, layers, activeLayerId };
  }
  if (isViewConfig(raw.view)) {
    return makeSlot(id, rect, { ...raw.view });
  }
  return null;
}

// ─── Layout templates ────────────────────────────────────────────────

/** The layers a template slot describes, plus which one starts active. */
export function layoutPaneLayers(pane: LayoutPane): {
  layers: LayoutLayer[];
  activeIndex: number;
} {
  if (pane.layers && pane.layers.length > 0) {
    const activeIndex = pane.activeLayerIndex ?? 0;
    return {
      layers: pane.layers,
      activeIndex: activeIndex >= 0 && activeIndex < pane.layers.length ? activeIndex : 0,
    };
  }
  return { layers: [{ viewType: pane.viewType, viewConfig: pane.viewConfig }], activeIndex: 0 };
}

/**
 * Build a template slot from layers. A single layer uses the compact
 * `viewType`/`viewConfig` form; a stack also writes `layers`/`activeLayerIndex`
 * and keeps `viewType` as the active layer's type for older readers.
 */
export function makeLayoutPane(
  rect: SlotRect,
  layers: LayoutLayer[],
  activeIndex: number,
): LayoutPane {
  const active = layers[activeIndex] ?? layers[0];
  const base: LayoutPane = {
    x: rect.x,
    y: rect.y,
    w: rect.w,
    h: rect.h,
    viewType: active.viewType,
    ...(active.viewConfig ? { viewConfig: active.viewConfig } : {}),
  };
  if (layers.length < 2) return base;
  return { ...base, layers, activeLayerIndex: activeIndex };
}
