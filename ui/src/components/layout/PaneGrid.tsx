import { useRef } from "react";
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
  const hoverIdleSeconds = useSettingsStore((s) => s.convenience.hoverIdleSeconds);
  const hover = useHoverTimer(hoverIdleSeconds);
  // Spatial reading-order pane numbers (issue #256). Derived from geometry, never cached.
  const paneNumbers = showPaneNumbers ? computePaneNumbers(panes) : null;

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
