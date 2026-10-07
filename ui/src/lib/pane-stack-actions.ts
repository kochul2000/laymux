/**
 * User-facing pane stack actions (ADR-0297) shared by the control bar, the
 * stack strip, keyboard shortcuts and Automation. Each one resolves its target
 * from raw state and commits focus through `activatePaneLayer`, the single
 * owner of the layer-activation + focus transition.
 */
import { activeLayerIndex } from "@/lib/pane-layers";
import { activatePaneLayer } from "@/lib/workspace-transition";
import { useDockStore } from "@/stores/dock-store";
import { useGridStore } from "@/stores/grid-store";
import type { ViewInstanceConfig } from "@/stores/types";
import { useWorkspaceStore } from "@/stores/workspace-store";

/**
 * Stack a new layer on slot `paneIndex` of the active workspace and focus it.
 * Returns the new layer id, or null for an invalid slot.
 */
export function stackPaneAt(paneIndex: number, view?: ViewInstanceConfig): string | null {
  const state = useWorkspaceStore.getState();
  const layerId = state.stackPane(paneIndex, view);
  if (layerId) activatePaneLayer(state.activeWorkspaceId, layerId);
  return layerId;
}

/** Index of the focused grid slot in the active workspace, or null when a dock owns focus. */
function focusedSlotIndex(): number | null {
  if (useDockStore.getState().focusedDock !== null) return null;
  const index = useGridStore.getState().focusedPaneIndex;
  const workspace = useWorkspaceStore.getState().getActiveWorkspace();
  return index !== null && workspace?.panes[index] ? index : null;
}

/** `pane.stack`: stack a new layer on the focused slot. */
export function stackFocusedPane(): string | null {
  const index = focusedSlotIndex();
  return index === null ? null : stackPaneAt(index);
}

/**
 * Step the focused slot's active layer around its stack ring (`pane.layer`,
 * and `pane.focus` on a blocked direction). Returns false when nothing is
 * focused or the slot is not stacked.
 */
export function cycleFocusedLayer(delta: number): boolean {
  const index = focusedSlotIndex();
  if (index === null) return false;
  const workspace = useWorkspaceStore.getState().getActiveWorkspace()!;
  const slot = workspace.panes[index];
  if (slot.layers.length < 2) return false;
  const count = slot.layers.length;
  const next = (((activeLayerIndex(slot) + delta) % count) + count) % count;
  return activatePaneLayer(workspace.id, slot.layers[next].id);
}

/** Arrow direction → ring step: Right/Down move forward, Left/Up backward. */
export function layerStepForDirection(direction: "left" | "right" | "up" | "down"): 1 | -1 {
  return direction === "right" || direction === "down" ? 1 : -1;
}

/**
 * Move a layer onto slot `targetSlotId` (drag a tab onto another slot or tab).
 * Inside one stack it only reorders; a layer moved to another slot is shown
 * and focused there.
 */
export function moveLayerTo(layerId: string, targetSlotId: string, index?: number): boolean {
  const state = useWorkspaceStore.getState();
  const workspace = state.getActiveWorkspace();
  if (!workspace) return false;
  const fromSlot = workspace.panes.find((pane) => pane.layers.some((l) => l.id === layerId));
  if (!state.moveLayer(layerId, targetSlotId, index)) return false;
  if (fromSlot?.id !== targetSlotId) activatePaneLayer(workspace.id, layerId);
  return true;
}

/** Pull a stacked layer out into its own split slot and focus it. */
export function extractLayerToSplit(
  layerId: string,
  direction: "horizontal" | "vertical",
): string | null {
  const state = useWorkspaceStore.getState();
  const workspaceId = state.activeWorkspaceId;
  const newSlotId = state.extractLayer(layerId, direction);
  if (newSlotId) activatePaneLayer(workspaceId, layerId);
  return newSlotId;
}

/** Drop a whole slot onto another slot's stack band: merge and show what was dragged. */
export function mergeSlotIntoStack(srcSlotId: string, tgtSlotId: string): boolean {
  const state = useWorkspaceStore.getState();
  const workspace = state.getActiveWorkspace();
  const src = workspace?.panes.find((pane) => pane.id === srcSlotId);
  if (!workspace || !src) return false;
  const shownLayerId = src.layers[activeLayerIndex(src)].id;
  if (!state.mergeSlotIntoStack(srcSlotId, tgtSlotId)) return false;
  activatePaneLayer(workspace.id, shownLayerId);
  return true;
}
