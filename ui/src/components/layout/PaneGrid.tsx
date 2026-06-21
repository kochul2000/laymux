import { useRef, useState } from "react";
import type { ViewInstanceConfig } from "@/stores/types";
import type { TerminalLocation } from "@/stores/settings-store";
import { ViewRenderer } from "@/components/views/ViewRenderer";
import { PaneBoundaryHandles } from "./PaneBoundaryHandles";
import { PaneControlBar } from "./PaneControlBar";
import { FocusIndicator } from "./FocusIndicator";
import { useContainerSize } from "@/hooks/useContainerSize";
import { useHoverTimer } from "@/hooks/useHoverTimer";
import { useSettingsStore } from "@/stores/settings-store";
import { computePaneNumbers } from "@/lib/pane-numbers";
import { propagateCwdOnceForPane } from "@/lib/propagate-cwd-once";

/** dataTransfer MIME for pane drag-to-swap (issue #377). */
const PANE_DND_MIME = "application/x-laymux-pane";

export interface GridPane {
  id: string;
  view: ViewInstanceConfig;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface CwdDefaults {
  send: boolean;
  receive: boolean;
}

export interface PaneGridProps {
  panes: GridPane[];
  /** Generates data-testid for each pane. */
  testIdFn: (pane: GridPane, index: number) => string | undefined;

  // Focus management (core difference between workspace and dock)
  isFocused: (paneId: string) => boolean;
  onPaneFocus: (paneId: string) => void;

  // Pane operations
  onSetPaneView?: (paneId: string, config: ViewInstanceConfig) => void;
  onSplitPane?: (paneId: string, dir: "horizontal" | "vertical") => void;
  onRemovePane?: (paneId: string) => void;
  /**
   * 그리드 안에서 pane 위치를 드래그&드롭으로 교환한다 (issue #377).
   * 제공되면 각 pane 컨트롤바에 드래그 핸들이 나타나고, 다른 pane 위로 드롭하면
   * srcPaneId·tgtPaneId 로 호출된다. 실제 위치 교환은 workspace-store.swapPanes 가 담당.
   * 미제공이면(예: dock) 드래그 핸들/드롭 타겟이 비활성화된다.
   */
  onSwapPanes?: (srcPaneId: string, tgtPaneId: string) => void;

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
  const hover = useHoverTimer(hoverIdleSeconds);
  // Spatial reading-order pane numbers (issue #256). Derived from geometry, never cached.
  const paneNumbers = showPaneNumbers ? computePaneNumbers(panes) : null;

  // Drag-to-swap (issue #377). Native HTML5 DnD, same pattern as workspace reorder
  // in WorkspaceSelectorView. dragSrcId 는 현재 드래그 중인 pane, dragOverId 는
  // 드롭 타겟 하이라이트용. dataTransfer 에도 id 를 실어 jsdom/실제 양쪽에서 동작.
  const dndEnabled = isActive && !!onSwapPanes;
  const dragSrcRef = useRef<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const handleDragStart = (e: React.DragEvent, paneId: string) => {
    dragSrcRef.current = paneId;
    e.dataTransfer.setData(PANE_DND_MIME, paneId);
    e.dataTransfer.effectAllowed = "move";
  };
  const handleDragOver = (e: React.DragEvent, paneId: string) => {
    if (!dndEnabled || !dragSrcRef.current) return;
    // preventDefault 를 호출해야 drop 이 허용된다(HTML5 DnD 규약).
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragSrcRef.current !== paneId) setDragOverId(paneId);
  };
  const handleDrop = (e: React.DragEvent, paneId: string) => {
    if (!dndEnabled) return;
    e.preventDefault();
    const srcId = dragSrcRef.current ?? (e.dataTransfer.getData(PANE_DND_MIME) || null);
    dragSrcRef.current = null;
    setDragOverId(null);
    if (srcId && srcId !== paneId) onSwapPanes?.(srcId, paneId);
  };
  const handleDragEnd = () => {
    dragSrcRef.current = null;
    setDragOverId(null);
  };

  return (
    <div
      ref={containerRef}
      data-testid={containerTestId}
      className={containerClassName}
      style={containerStyle}
    >
      {panes.map((pane, i) => {
        const focused = isFocused(pane.id);
        const isHovered = hover.hoveredId === pane.id || (isHoveredOverride?.(pane.id) ?? false);

        const hasCwdView =
          pane.view.type === "TerminalView" || pane.view.type === "FileExplorerView";

        // Effective CWD send/receive: per-pane override beats getCwdDefaults cascade.
        // This is the same precedence the backend applies via ViewRenderer → resolveSyncCwd,
        // so the indicator and the actual propagation stay in sync.
        const cwdDefaults = hasCwdView && getCwdDefaults ? getCwdDefaults(pane.view) : null;
        const cwdSendOn = cwdDefaults
          ? ((pane.view.cwdSend as boolean | undefined) ?? cwdDefaults.send)
          : undefined;
        const cwdReceiveOn = cwdDefaults
          ? ((pane.view.cwdReceive as boolean | undefined) ?? cwdDefaults.receive)
          : undefined;

        return (
          <div
            key={pane.id}
            data-testid={testIdFn(pane, i)}
            data-pane-index={i}
            className="absolute overflow-hidden"
            onMouseDown={(e) => {
              e.stopPropagation();
              if (!isActive) return;
              onPaneFocus(pane.id);
            }}
            onMouseEnter={() => isActive && hover.activate(pane.id)}
            onMouseMove={() => isActive && hover.activate(pane.id)}
            onMouseLeave={hover.clear}
            onDragOver={dndEnabled ? (e) => handleDragOver(e, pane.id) : undefined}
            onDrop={dndEnabled ? (e) => handleDrop(e, pane.id) : undefined}
            style={{
              left: `${pane.x * 100}%`,
              top: `${pane.y * 100}%`,
              width: `${pane.w * 100}%`,
              height: `${pane.h * 100}%`,
              display: isActive ? undefined : "none",
              borderRight: "2px solid var(--border)",
              borderBottom: "2px solid var(--border)",
            }}
          >
            {focused && <FocusIndicator testId="pane-focus-indicator" />}
            {dndEnabled && (
              <div
                data-testid={`pane-drag-handle-${i}`}
                draggable
                onDragStart={(e) => handleDragStart(e, pane.id)}
                onDragEnd={handleDragEnd}
                // 핸들 자체에 mousedown 이 pane 의 focus 로 버블링되지 않도록 막는다.
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                title="Drag to swap pane position"
                aria-label="Drag to swap pane position"
                className={`absolute right-1 top-1 z-30 flex cursor-grab items-center justify-center rounded transition-opacity ${
                  isActive && isHovered ? "opacity-90" : "opacity-0"
                }`}
                style={{
                  width: "var(--btn-min-w)",
                  height: "var(--btn-h)",
                  background: "var(--bg-surface)",
                  color: "var(--text-secondary)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-sm)",
                }}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                  <circle cx="4" cy="2.5" r="1" />
                  <circle cx="8" cy="2.5" r="1" />
                  <circle cx="4" cy="6" r="1" />
                  <circle cx="8" cy="6" r="1" />
                  <circle cx="4" cy="9.5" r="1" />
                  <circle cx="8" cy="9.5" r="1" />
                </svg>
              </div>
            )}
            {dndEnabled && dragOverId === pane.id && (
              <div
                data-testid={`pane-drop-target-${i}`}
                className="pointer-events-none absolute inset-0 z-20"
                style={{
                  border: "2px solid var(--accent)",
                  background: "var(--accent-20)",
                }}
              />
            )}
            <PaneControlBar
              paneId={pane.id}
              currentView={pane.view}
              hovered={isActive && isHovered}
              cwdSendOn={cwdSendOn}
              cwdReceiveOn={cwdReceiveOn}
              paneNumber={paneNumbers?.get(pane.id)}
              workspaceId={workspaceId}
              workspaceName={workspaceName}
              actions={{
                onChangeView: onSetPaneView
                  ? (config) => onSetPaneView(pane.id, config)
                  : undefined,
                onSplitH: onSplitPane ? () => onSplitPane(pane.id, "horizontal") : undefined,
                onSplitV: onSplitPane ? () => onSplitPane(pane.id, "vertical") : undefined,
                onClear: onSetPaneView
                  ? () => onSetPaneView(pane.id, { type: "EmptyView" })
                  : undefined,
                onDelete:
                  panes.length > 1 && onRemovePane ? () => onRemovePane(pane.id) : undefined,
                onToggleCwdSend:
                  hasCwdView && onSetPaneView && cwdDefaults
                    ? () => {
                        const current =
                          (pane.view.cwdSend as boolean | undefined) ?? cwdDefaults.send;
                        onSetPaneView(pane.id, { ...pane.view, cwdSend: !current });
                      }
                    : undefined,
                onToggleCwdReceive:
                  hasCwdView && onSetPaneView && cwdDefaults
                    ? () => {
                        const current =
                          (pane.view.cwdReceive as boolean | undefined) ?? cwdDefaults.receive;
                        onSetPaneView(pane.id, { ...pane.view, cwdReceive: !current });
                      }
                    : undefined,
                // 1회성 CWD 전파 (issue #293). 디스패치 로직은 키바인딩
                // (`pane.propagateCwdOnce`, issue #324)과 공유하는 propagate-cwd-once 헬퍼에 있다.
                onPropagateCwdOnce: hasCwdView
                  ? () => {
                      propagateCwdOnceForPane(pane);
                    }
                  : undefined,
              }}
            >
              <ViewRenderer
                viewType={pane.view.type}
                viewConfig={pane.view}
                onSelectView={
                  onSetPaneView ? (config) => onSetPaneView(pane.id, config) : undefined
                }
                workspaceName={workspaceName}
                workspaceId={workspaceId}
                paneId={pane.id}
                isFocused={focused}
                emptyViewContext={emptyViewContext}
                location={location}
                onKeyboardActivity={hover.clear}
              />
            </PaneControlBar>
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
