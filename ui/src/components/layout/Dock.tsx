import { useState, useRef, useCallback, useEffect } from "react";
import type { DockPosition, DockPane, ViewType, ViewInstanceConfig } from "@/stores/types";
import { useDockStore } from "@/stores/dock-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { ViewRenderer } from "@/components/views/ViewRenderer";
import { PaneControlBar } from "./PaneControlBar";
import { PaneBoundaryHandles } from "./PaneBoundaryHandles";

interface DockProps {
  position: DockPosition;
  activeView: ViewType | null;
  views: ViewType[];
  panes: DockPane[];
  onSwitchView?: (view: ViewType, viewConfig?: ViewInstanceConfig) => void;
  onSplitPane?: (direction: "horizontal" | "vertical", paneId?: string) => void;
  onRemovePane?: (paneId: string) => void;
  onSetPaneView?: (paneId: string, view: ViewInstanceConfig) => void;
  onResizePane?: (paneId: string, delta: Partial<Pick<DockPane, "x" | "y" | "w" | "h">>) => void;
}

const viewIcons: Record<ViewType, string> = {
  WorkspaceSelectorView: "\u229e",
  SettingsView: "\u2699",
  TerminalView: ">_",
  BrowserPreviewView: "\u25ce",
  MemoView: "\u270e",
  IssueReporterView: "!",
  EmptyView: "\u25cb",
};

export function Dock({
  position,
  activeView,
  views,
  panes,
  onSwitchView,
  onSplitPane,
  onRemovePane,
  onSetPaneView,
  onResizePane,
}: DockProps) {
  const showIconBar = views.length > 1 && panes.length <= 1;
  const focusedDock = useDockStore((s) => s.focusedDock);
  const focusedDockPaneId = useDockStore((s) => s.focusedDockPaneId);
  const isFocused = focusedDock === position;
  const hasSplitPanes = panes.length >= 2;
  const hoverIdleSeconds = useSettingsStore((s) => s.convenience.hoverIdleSeconds);
  const activeWsName = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
    return ws?.name ?? "";
  });

  const [singleHovered, setSingleHovered] = useState(false);
  const singleHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSingleHoverActivity = useCallback(() => {
    setSingleHovered(true);
    if (singleHoverTimerRef.current) clearTimeout(singleHoverTimerRef.current);
    if (hoverIdleSeconds > 0) {
      singleHoverTimerRef.current = setTimeout(
        () => setSingleHovered(false),
        hoverIdleSeconds * 1000,
      );
    }
  }, [hoverIdleSeconds]);

  useEffect(() => {
    return () => {
      if (singleHoverTimerRef.current) clearTimeout(singleHoverTimerRef.current);
    };
  }, []);

  // Split panes rendering — 2D absolute positioned grid (same as WorkspaceArea)
  if (hasSplitPanes) {
    return (
      <DockGrid
        position={position}
        panes={panes}
        onSplitPane={onSplitPane}
        onRemovePane={onRemovePane}
        onSetPaneView={onSetPaneView}
        onResizePane={onResizePane}
      />
    );
  }

  // Single-pane rendering (original behavior + split button on hover)
  const singlePaneId = panes[0]?.id;
  const hasIframe = activeView === "BrowserPreviewView";

  return (
    <div
      data-testid={`dock-${position}`}
      className="flex h-full w-full overflow-hidden"
      style={{ background: "var(--bg-surface)", borderColor: "var(--border)" }}
      onMouseEnter={handleSingleHoverActivity}
      onMouseMove={handleSingleHoverActivity}
      onMouseLeave={() => {
        setSingleHovered(false);
        if (singleHoverTimerRef.current) clearTimeout(singleHoverTimerRef.current);
      }}
    >
      {showIconBar && (
        <div
          data-testid="dock-icon-bar"
          className="flex shrink-0 flex-col gap-1.5 px-1 py-2"
          style={{ borderRight: "1px solid var(--border)" }}
        >
          {views.map((view) => (
            <button
              key={view}
              data-testid={`dock-icon-${view}`}
              data-active={view === activeView ? "true" : "false"}
              onClick={() => onSwitchView?.(view)}
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded text-xs font-semibold"
              style={{
                background: view === activeView ? "var(--accent)" : "transparent",
                color: view === activeView ? "var(--bg-base)" : "var(--text-secondary)",
                border: view === activeView ? "none" : "1px solid transparent",
              }}
              title={view.replace("View", "")}
            >
              {viewIcons[view] ?? "?"}
            </button>
          ))}
        </div>
      )}
      <div className="relative min-w-0 flex-1">
        {hasIframe && !isFocused && (
          <div data-testid={`dock-focus-overlay-${position}`} className="absolute inset-0 z-10" />
        )}
        <PaneControlBar
          currentView={panes[0]?.view ?? { type: activeView ?? "EmptyView" }}
          hovered={singleHovered}
          actions={{
            onSplitH: onSplitPane ? () => onSplitPane("horizontal", singlePaneId) : undefined,
            onSplitV: onSplitPane ? () => onSplitPane("vertical", singlePaneId) : undefined,
            onClear:
              activeView && activeView !== "EmptyView"
                ? singlePaneId && onSetPaneView
                  ? () => onSetPaneView(singlePaneId, { type: "EmptyView" })
                  : onSwitchView
                    ? () => onSwitchView("EmptyView")
                    : undefined
                : undefined,
            onToggleCwdSend:
              singlePaneId && onSetPaneView && panes[0]?.view.type === "TerminalView"
                ? () =>
                    onSetPaneView(singlePaneId, {
                      ...panes[0].view,
                      cwdSend: !((panes[0].view.cwdSend as boolean) ?? true),
                    })
                : undefined,
            onToggleCwdReceive:
              singlePaneId && onSetPaneView && panes[0]?.view.type === "TerminalView"
                ? () =>
                    onSetPaneView(singlePaneId, {
                      ...panes[0].view,
                      cwdReceive: !((panes[0].view.cwdReceive as boolean) ?? true),
                    })
                : undefined,
          }}
        >
          <ViewRenderer
            viewType={activeView}
            viewConfig={panes[0]?.view}
            paneId={singlePaneId ?? `dock-${position}`}
            workspaceName={activeWsName}
            isFocused={isFocused}
            onSelectView={
              singlePaneId
                ? (config) => onSetPaneView?.(singlePaneId, config)
                : onSwitchView
                  ? (config) => onSwitchView(config.type, config)
                  : undefined
            }
            emptyViewContext="dock"
            location="dock"
          />
        </PaneControlBar>
      </div>
    </div>
  );
}

/** 2D grid dock panes — uses absolute positioning like WorkspaceArea */
function DockGrid({
  position,
  panes,
  onSplitPane,
  onRemovePane,
  onSetPaneView,
  onResizePane,
}: {
  position: DockPosition;
  panes: DockPane[];
  onSplitPane?: (direction: "horizontal" | "vertical", paneId?: string) => void;
  onRemovePane?: (paneId: string) => void;
  onSetPaneView?: (paneId: string, view: ViewInstanceConfig) => void;
  onResizePane?: (paneId: string, delta: Partial<Pick<DockPane, "x" | "y" | "w" | "h">>) => void;
}) {
  const focusedDock = useDockStore((s) => s.focusedDock);
  const focusedDockPaneId = useDockStore((s) => s.focusedDockPaneId);
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hoveredPane, setHoveredPane] = useState<string | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverIdleSeconds = useSettingsStore((s) => s.convenience.hoverIdleSeconds);
  const activeWsName = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
    return ws?.name ?? "";
  });

  const handlePaneHoverActivity = useCallback(
    (paneId: string) => {
      setHoveredPane(paneId);
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
      if (hoverIdleSeconds > 0) {
        hoverTimerRef.current = setTimeout(() => setHoveredPane(null), hoverIdleSeconds * 1000);
      }
    },
    [hoverIdleSeconds],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setSize({ w: width, h: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      data-testid={`dock-${position}`}
      className="relative h-full w-full overflow-hidden"
      style={{ background: "var(--bg-surface)" }}
    >
      {panes.map((pane) => {
        const isHovered = hoveredPane === pane.id;
        const isPaneFocused = focusedDock === position && focusedDockPaneId === pane.id;
        return (
          <div
            key={pane.id}
            data-testid={`dock-pane-${pane.id}`}
            className="absolute overflow-hidden"
            style={{
              left: `${pane.x * 100}%`,
              top: `${pane.y * 100}%`,
              width: `${pane.w * 100}%`,
              height: `${pane.h * 100}%`,
              borderRight: "2px solid var(--border)",
              borderBottom: "2px solid var(--border)",
            }}
            onMouseEnter={() => handlePaneHoverActivity(pane.id)}
            onMouseMove={() => handlePaneHoverActivity(pane.id)}
            onMouseLeave={() => {
              setHoveredPane(null);
              if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
            }}
          >
            {isPaneFocused && (
              <div
                className="pointer-events-none absolute inset-0"
                style={{ boxShadow: "inset 0 0 0 1px var(--accent)", zIndex: 20 }}
              />
            )}
            <PaneControlBar
              currentView={pane.view}
              hovered={isHovered}
              actions={{
                onSplitH: onSplitPane ? () => onSplitPane("horizontal", pane.id) : undefined,
                onSplitV: onSplitPane ? () => onSplitPane("vertical", pane.id) : undefined,
                onClear: () => onSetPaneView?.(pane.id, { type: "EmptyView" }),
                onDelete:
                  panes.length > 1 && onRemovePane ? () => onRemovePane(pane.id) : undefined,
                onToggleCwdSend:
                  onSetPaneView && pane.view.type === "TerminalView"
                    ? () =>
                        onSetPaneView(pane.id, {
                          ...pane.view,
                          cwdSend: !((pane.view.cwdSend as boolean) ?? true),
                        })
                    : undefined,
                onToggleCwdReceive:
                  onSetPaneView && pane.view.type === "TerminalView"
                    ? () =>
                        onSetPaneView(pane.id, {
                          ...pane.view,
                          cwdReceive: !((pane.view.cwdReceive as boolean) ?? true),
                        })
                    : undefined,
              }}
            >
              <ViewRenderer
                viewType={pane.view.type}
                viewConfig={pane.view}
                paneId={pane.id}
                workspaceName={activeWsName}
                isFocused={isPaneFocused}
                onSelectView={(config) => onSetPaneView?.(pane.id, config)}
                emptyViewContext="dock"
                location="dock"
                onKeyboardActivity={() => {
                  setHoveredPane(null);
                  if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
                }}
              />
            </PaneControlBar>
          </div>
        );
      })}
      <PaneBoundaryHandles
        panes={panes}
        containerWidth={size.w}
        containerHeight={size.h}
        getLatestPanes={() => useDockStore.getState().getDock(position)?.panes ?? []}
        onResizePane={(idx, delta) => {
          const pane = panes[idx];
          if (pane && onResizePane) onResizePane(pane.id, delta);
        }}
        onRemovePane={(idx) => {
          const pane = panes[idx];
          if (pane && onRemovePane) onRemovePane(pane.id);
        }}
      />
    </div>
  );
}
