import { useCallback, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { PaneLayer, ViewInstanceConfig, WorkspacePane } from "@/stores/types";
import { activeLayerIndex } from "@/lib/pane-layers";
import type { TerminalLocation } from "@/stores/settings-store";
import { ViewRenderer } from "@/components/views/ViewRenderer";
import { PaneBoundaryHandles } from "./PaneBoundaryHandles";
import { PaneControlBar } from "./PaneControlBar";
import { PaneStackStrip } from "./PaneStackStrip";
import { FocusIndicator } from "./FocusIndicator";
import { useContainerSize } from "@/hooks/useContainerSize";
import { useHoverTimer } from "@/hooks/useHoverTimer";
import { useSettingsStore } from "@/stores/settings-store";
import { computePaneNumbers } from "@/lib/pane-numbers";
import { propagateCwdOnceForPane } from "@/lib/propagate-cwd-once";
import { supportsCwdReceive, supportsCwdSend } from "@/lib/view-cwd-capability";
import { PANE_DND_MIME, setPaneDragData } from "@/lib/pane-dnd";
import { PaneLoadingPlaceholder } from "@/components/ui/PaneLoadingPlaceholder";
import { useTerminalStartupStore } from "@/stores/terminal-startup-store";
import {
  useTerminalRestartStore,
  type TerminalRestartRequest,
} from "@/stores/terminal-restart-store";
import { resolvePaneCwd } from "@/lib/pane-cwd";
import { runPaneClearFromUi } from "@/lib/pane-clear-action";

/**
 * A grid slot: geometry plus stacked content layers (ADR-0297). Dock panes are
 * passed as single-layer slots whose layer shares the pane id.
 */
export type GridPane = WorkspacePane;

/** Height of the top band that turns a slot drop into "stack onto this slot". */
const STACK_DROP_BAND_PX = 40;

interface CwdDefaults {
  send: boolean;
  receive: boolean;
}

export interface PaneGridProps {
  panes: GridPane[];
  /** Generates data-testid for each pane. */
  testIdFn: (pane: GridPane, index: number) => string | undefined;

  // Focus management (core difference between workspace and dock). Ids are slot ids.
  isFocused: (paneId: string) => boolean;
  onPaneFocus: (paneId: string) => void;

  // Pane operations. `paneId` is the slot id; `layerId` names the content layer
  // the control acted on (ADR-0297). For dock panes both are the pane id.
  onSetPaneView?: (paneId: string, config: ViewInstanceConfig, layerId: string) => void;
  onSplitPane?: (paneId: string, dir: "horizontal" | "vertical") => void;
  onRemovePane?: (paneId: string, layerId: string) => void;
  /**
   * 그리드 안에서 pane 위치를 드래그&드롭으로 교환한다 (issue #377).
   * 제공되면 각 pane 컨트롤바에 드래그 핸들이 나타나고, 다른 pane 위로 드롭하면
   * srcPaneId·tgtPaneId 로 호출된다. 실제 위치 교환은 workspace-store.swapPanes 가 담당.
   * 미제공이면(예: dock) 드래그 핸들/드롭 타겟이 비활성화된다.
   */
  onSwapPanes?: (srcPaneId: string, tgtPaneId: string) => void;
  /**
   * Pane stack (ADR-0297). `onStackPane` adds a layer to the slot (control bar
   * Stack button and the strip `+`); `onActivateLayer` shows one of its layers.
   * Omitted (dock) → no Stack button and no strip interaction.
   */
  onStackPane?: (paneId: string) => void;
  onActivateLayer?: (paneId: string, layerId: string) => void;
  /**
   * Layer rearrangement (ADR-0297). `onMoveLayer` takes a dragged tab to slot
   * `targetPaneId` (optionally at `index` among its other layers);
   * `onExtractLayer` splits a layer out of its stack; `onMergeSlot` stacks a
   * dragged slot onto another one.
   */
  onMoveLayer?: (layerId: string, targetPaneId: string, index?: number) => void;
  onExtractLayer?: (layerId: string, direction: "horizontal" | "vertical") => void;
  onMergeSlot?: (srcPaneId: string, tgtPaneId: string) => void;

  // CWD toggle defaults
  getCwdDefaults?: (view: ViewInstanceConfig) => CwdDefaults;

  // ViewRenderer common props
  workspaceId: string;
  workspaceName: string;
  emptyViewContext?: "pane" | "dock";
  location?: TerminalLocation;

  // Optional: visibility (WorkspaceArea uses display:none for inactive ws)
  isActive?: boolean;

  // Optional: external hover override (automationHoverIndex)
  isHoveredOverride?: (paneId: string) => boolean;

  // Optional: show spatial pane-number badges in the control bar (issue #256).
  // Off by default so the dock (which reuses PaneGrid) stays unnumbered.
  showPaneNumbers?: boolean;

  // PaneBoundaryHandles override props
  boundaryHandlesProps?: {
    panes?: Array<{ x: number; y: number; w: number; h: number }>;
    getLatestPanes?: () => Array<{ x: number; y: number; w: number; h: number }>;
    onResizePane?: (
      index: number,
      delta: Partial<{ x: number; y: number; w: number; h: number }>,
    ) => void;
    onRemovePane?: (index: number) => void;
  };

  // Container props
  containerTestId?: string;
  containerClassName?: string;
  containerStyle?: React.CSSProperties;
}

export function PaneGrid({
  panes,
  testIdFn,
  isFocused,
  onPaneFocus,
  onSetPaneView,
  onSplitPane,
  onRemovePane,
  onSwapPanes,
  onStackPane,
  onActivateLayer,
  onMoveLayer,
  onExtractLayer,
  onMergeSlot,
  getCwdDefaults,
  workspaceId,
  workspaceName,
  emptyViewContext,
  location,
  isActive = true,
  isHoveredOverride,
  showPaneNumbers = false,
  boundaryHandlesProps,
  containerTestId,
  containerClassName = "relative h-full w-full",
  containerStyle,
}: PaneGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const size = useContainerSize(containerRef);
  const hoverIdleSeconds = useSettingsStore((s) => s.controlBar.hoverIdleSeconds);
  const hover = useHoverTimer(hoverIdleSeconds, isActive);
  // Spatial reading-order pane numbers (issue #256). Derived from geometry, never cached.
  const paneNumbers = showPaneNumbers ? computePaneNumbers(panes) : null;

  // The app-global coordinator reveals only one starting terminal at a time.
  // Other view types do not allocate a PTY/xterm renderer and mount immediately.
  const startupRevealedPaneIds = useTerminalStartupStore((state) => state.revealedPaneIds);
  // Every content layer is rendered as its own box keyed by layer id, sharing
  // its slot's rect; only the active layer is shown (ADR-0297). Keying by layer
  // id keeps a terminal mounted when its layer is activated, reordered or moved.
  const boxes = useMemo(
    () =>
      panes.flatMap((slot, slotIndex) => {
        const activeIndex = activeLayerIndex(slot);
        return slot.layers.map((layer, layerIndex) => ({
          slot,
          slotIndex,
          layer,
          layerIndex,
          active: layerIndex === activeIndex,
        }));
      }),
    [panes],
  );
  const revealed = useMemo(() => {
    const paneIds = new Set<string>();
    for (const { layer } of boxes) {
      if (layer.view.type !== "TerminalView" || startupRevealedPaneIds.has(layer.id)) {
        paneIds.add(layer.id);
      }
    }
    return paneIds;
  }, [boxes, startupRevealedPaneIds]);

  // Drag-to-swap (issue #377). Native HTML5 DnD, same pattern as workspace reorder
  // in WorkspaceSelectorView. dragSrcId 는 현재 드래그 중인 pane, dragOverId 는
  // 드롭 타겟 하이라이트용. dataTransfer 에도 id 를 실어 jsdom/실제 양쪽에서 동작.
  const dndEnabled = isActive && !!onSwapPanes;
  const dragSrcRef = useRef<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  // Restart requests live in a store, not local state, so the workspace-wide
  // clear can request one from outside this component (ADR-0113). The store is
  // app-wide but a grid only cares about its own panes — subscribing to the
  // whole record would re-render every mounted workspace and dock on any
  // restart, which the previous per-component state never did.
  const terminalRestarts = useTerminalRestartStore(
    useShallow((s) => {
      const mine: Record<string, TerminalRestartRequest> = {};
      for (const pane of panes) {
        for (const layer of pane.layers) {
          const request = s.requests[layer.id];
          if (request) mine[layer.id] = request;
        }
      }
      return mine;
    }),
  );
  const consumeTerminalRestart = useTerminalRestartStore((s) => s.consumeRestart);

  const restartTerminalView = useCallback((pane: PaneLayer) => {
    useTerminalRestartStore.getState().requestRestart(pane.id, resolvePaneCwd(pane));
  }, []);

  // Pane stack DnD (ADR-0297). A slot dragged by its control bar swaps with the
  // target, or — dropped on the target's top band — merges into its stack. A
  // stack tab dragged onto another slot joins that slot's stack.
  const [dragZone, setDragZone] = useState<"swap" | "stack">("swap");
  const [draggingLayerId, setDraggingLayerId] = useState<string | null>(null);
  const layerDragEnabled = isActive && !!onMoveLayer;

  /** Top band of a slot box means "stack onto it"; needs real layout to tell. */
  const zoneFor = (e: React.DragEvent): "swap" | "stack" => {
    if (!onMergeSlot) return "swap";
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.height <= 0) return "swap";
    const band = Math.min(STACK_DROP_BAND_PX, rect.height / 3);
    return e.clientY - rect.top < band ? "stack" : "swap";
  };

  const handleDragStart = (e: React.DragEvent, paneId: string) => {
    dragSrcRef.current = paneId;
    setPaneDragData(e, paneId);
  };
  const handleDragOver = (e: React.DragEvent, paneId: string) => {
    if (draggingLayerId) {
      // A tab can join any other slot; its own slot reorders in the strip.
      const ownSlot = panes.find((pane) => pane.layers.some((l) => l.id === draggingLayerId));
      if (!layerDragEnabled || ownSlot?.id === paneId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDragZone("stack");
      setDragOverId(paneId);
      return;
    }
    if (!dndEnabled || !dragSrcRef.current) return;
    // preventDefault 를 호출해야 drop 이 허용된다(HTML5 DnD 규약).
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragSrcRef.current !== paneId) {
      setDragZone(zoneFor(e));
      setDragOverId(paneId);
    }
  };
  const handleDrop = (e: React.DragEvent, paneId: string) => {
    if (draggingLayerId) {
      const layerId = draggingLayerId;
      e.preventDefault();
      setDraggingLayerId(null);
      setDragOverId(null);
      if (layerDragEnabled) onMoveLayer?.(layerId, paneId);
      return;
    }
    if (!dndEnabled) return;
    e.preventDefault();
    const srcId = dragSrcRef.current ?? (e.dataTransfer.getData(PANE_DND_MIME) || null);
    const zone = zoneFor(e);
    dragSrcRef.current = null;
    setDragOverId(null);
    if (!srcId || srcId === paneId) return;
    if (zone === "stack") onMergeSlot?.(srcId, paneId);
    else onSwapPanes?.(srcId, paneId);
  };
  const handleDragEnd = () => {
    dragSrcRef.current = null;
    setDragOverId(null);
  };

  return (
    <div
      ref={containerRef}
      data-testid={containerTestId}
      data-pane-revealed-count={revealed.size}
      className={containerClassName}
      style={containerStyle}
    >
      {boxes.map(({ slot: pane, slotIndex: i, layer, active }) => {
        // Slot-level state (focus, hover, drag, geometry) keys on the slot id;
        // content-level state (view, terminal, restart, reveal) on the layer id.
        const focused = active && isFocused(pane.id);
        const isHovered =
          active && (hover.hoveredId === pane.id || (isHoveredOverride?.(pane.id) ?? false));
        const shown = isActive && active;

        const canSendCwd = supportsCwdSend(layer.view.type);
        const canReceiveCwd = supportsCwdReceive(layer.view.type);

        // Effective CWD send/receive: per-pane override beats getCwdDefaults cascade.
        // This is the same precedence the backend applies via ViewRenderer → resolveSyncCwd,
        // so the indicator and the actual propagation stay in sync.
        const cwdDefaults = canReceiveCwd && getCwdDefaults ? getCwdDefaults(layer.view) : null;
        const cwdSendOn =
          cwdDefaults && canSendCwd
            ? ((layer.view.cwdSend as boolean | undefined) ?? cwdDefaults.send)
            : undefined;
        const cwdReceiveOn = cwdDefaults
          ? ((layer.view.cwdReceive as boolean | undefined) ?? cwdDefaults.receive)
          : undefined;

        return (
          <div
            key={layer.id}
            data-testid={active ? testIdFn(pane, i) : undefined}
            data-pane-index={i}
            data-layer-id={layer.id}
            data-layer-active={active ? "true" : "false"}
            className="absolute overflow-hidden"
            onMouseDown={(e) => {
              e.stopPropagation();
              if (!isActive) return;
              onPaneFocus(pane.id);
            }}
            onMouseEnter={() => isActive && hover.activate(pane.id)}
            onMouseMove={() => isActive && hover.activate(pane.id)}
            onMouseLeave={hover.clear}
            onDragOver={
              dndEnabled || layerDragEnabled ? (e) => handleDragOver(e, pane.id) : undefined
            }
            onDrop={dndEnabled || layerDragEnabled ? (e) => handleDrop(e, pane.id) : undefined}
            style={{
              left: `${pane.x * 100}%`,
              top: `${pane.y * 100}%`,
              width: `${pane.w * 100}%`,
              height: `${pane.h * 100}%`,
              display: shown ? undefined : "none",
              // Dark backstop so a freshly-committed pane box is never painted
              // browser-default white before its view renders its own background
              // (the white-flash source when many panes mount in one commit).
              background: "var(--bg-base)",
              borderRight: "2px solid var(--border)",
              borderBottom: "2px solid var(--border)",
            }}
          >
            {focused && <FocusIndicator testId="pane-focus-indicator" />}
            {active &&
              (dndEnabled || layerDragEnabled) &&
              dragOverId === pane.id &&
              (dragZone === "stack" ? (
                <div
                  data-testid={`pane-stack-drop-target-${i}`}
                  className="pointer-events-none absolute inset-0 z-20"
                  style={{ border: "2px solid var(--accent)" }}
                >
                  <div className="pane-stack-drop-band">Stack here</div>
                </div>
              ) : (
                <div
                  data-testid={`pane-drop-target-${i}`}
                  className="pointer-events-none absolute inset-0 z-20"
                  style={{
                    border: "2px solid var(--accent)",
                    background: "var(--accent-20)",
                  }}
                />
              ))}
            {/* The column wrapper and content slot are always rendered so that a
                slot turning into a stack only inserts the strip — the control bar
                and view keep their place and never remount (ADR-0297). */}
            <div className="flex h-full w-full min-w-0 flex-col">
              {active && pane.layers.length > 1 && (
                <PaneStackStrip
                  layers={pane.layers}
                  activeLayerId={layer.id}
                  paneNumbers={paneNumbers}
                  onActivate={(layerId) =>
                    onActivateLayer ? onActivateLayer(pane.id, layerId) : undefined
                  }
                  onClose={onRemovePane ? (layerId) => onRemovePane(pane.id, layerId) : undefined}
                  onAdd={onStackPane ? () => onStackPane(pane.id) : undefined}
                  onSplitOut={onExtractLayer}
                  onTabDragStart={layerDragEnabled ? setDraggingLayerId : undefined}
                  onTabDragEnd={() => {
                    setDraggingLayerId(null);
                    setDragOverId(null);
                  }}
                  draggingLayerId={draggingLayerId}
                  onDropLayer={
                    layerDragEnabled
                      ? (layerId, index) => {
                          setDraggingLayerId(null);
                          setDragOverId(null);
                          onMoveLayer?.(layerId, pane.id, index);
                        }
                      : undefined
                  }
                />
              )}
              <div className="relative min-h-0 min-w-0 flex-1">
                <PaneControlBar
                  paneId={pane.id}
                  contentPaneId={layer.id}
                  currentView={layer.view}
                  hovered={shown && isHovered}
                  isActive={isActive}
                  cwdSendOn={cwdSendOn}
                  cwdReceiveOn={cwdReceiveOn}
                  paneNumber={paneNumbers?.get(layer.id)}
                  workspaceId={workspaceId}
                  workspaceName={workspaceName}
                  dndEnabled={dndEnabled}
                  onPaneDragStart={(e) => handleDragStart(e, pane.id)}
                  onPaneDragEnd={handleDragEnd}
                  showListHideToggle={location === "workspace"}
                  actions={{
                    onChangeView: onSetPaneView
                      ? (config) => onSetPaneView(pane.id, config, layer.id)
                      : undefined,
                    onSplitH: onSplitPane ? () => onSplitPane(pane.id, "horizontal") : undefined,
                    onSplitV: onSplitPane ? () => onSplitPane(pane.id, "vertical") : undefined,
                    onStack: onStackPane ? () => onStackPane(pane.id) : undefined,
                    onClearTerminal:
                      layer.view.type === "TerminalView"
                        ? () => {
                            void runPaneClearFromUi(layer.id);
                          }
                        : undefined,
                    onClear: onSetPaneView
                      ? () => onSetPaneView(pane.id, { type: "EmptyView" }, layer.id)
                      : undefined,
                    onRestart:
                      layer.view.type === "TerminalView"
                        ? () => restartTerminalView(layer)
                        : undefined,
                    onDelete:
                      (panes.length > 1 || pane.layers.length > 1) && onRemovePane
                        ? () => onRemovePane(pane.id, layer.id)
                        : undefined,
                    deleteTitle: pane.layers.length > 1 ? "Close layer" : "Delete pane",
                    onToggleCwdSend:
                      canSendCwd && onSetPaneView && cwdDefaults
                        ? () => {
                            const current =
                              (layer.view.cwdSend as boolean | undefined) ?? cwdDefaults.send;
                            onSetPaneView(pane.id, { ...layer.view, cwdSend: !current }, layer.id);
                          }
                        : undefined,
                    onToggleCwdReceive:
                      canReceiveCwd && onSetPaneView && cwdDefaults
                        ? () => {
                            const current =
                              (layer.view.cwdReceive as boolean | undefined) ?? cwdDefaults.receive;
                            onSetPaneView(
                              pane.id,
                              { ...layer.view, cwdReceive: !current },
                              layer.id,
                            );
                          }
                        : undefined,
                    // 1회성 CWD 전파 (issue #293). 디스패치 로직은 키바인딩
                    // (`pane.propagateCwdOnce`, issue #324)과 공유하는 propagate-cwd-once 헬퍼에 있다.
                    onPropagateCwdOnce: canSendCwd
                      ? () => {
                          propagateCwdOnceForPane(layer);
                        }
                      : undefined,
                  }}
                >
                  {revealed.has(layer.id) ? (
                    <ViewRenderer
                      viewType={layer.view.type}
                      viewConfig={layer.view}
                      onSelectView={
                        onSetPaneView
                          ? (config) => onSetPaneView(pane.id, config, layer.id)
                          : undefined
                      }
                      workspaceName={workspaceName}
                      workspaceId={workspaceId}
                      paneId={layer.id}
                      isFocused={focused}
                      emptyViewContext={emptyViewContext}
                      location={location}
                      onKeyboardActivity={hover.clear}
                      terminalRestartEpoch={terminalRestarts[layer.id]?.epoch}
                      terminalRestartCwd={terminalRestarts[layer.id]?.cwd}
                      terminalRestartFresh={terminalRestarts[layer.id]?.fresh}
                      onTerminalRestartConsumed={() => consumeTerminalRestart(layer.id)}
                      onTerminalRestart={
                        layer.view.type === "TerminalView"
                          ? () => restartTerminalView(layer)
                          : undefined
                      }
                    />
                  ) : (
                    <PaneLoadingPlaceholder
                      data-testid={`pane-loading-placeholder-${i}${active ? "" : `-${layer.id}`}`}
                    />
                  )}
                </PaneControlBar>
              </div>
            </div>
          </div>
        );
      })}
      {isActive && (
        <PaneBoundaryHandles
          containerWidth={size.w}
          containerHeight={size.h}
          panes={boundaryHandlesProps?.panes}
          getLatestPanes={boundaryHandlesProps?.getLatestPanes}
          onResizePane={boundaryHandlesProps?.onResizePane}
          onRemovePane={boundaryHandlesProps?.onRemovePane}
        />
      )}
    </div>
  );
}
