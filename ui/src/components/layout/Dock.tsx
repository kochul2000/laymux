import type { DockPosition, DockPane, ViewType, ViewInstanceConfig } from "@/stores/types";
import { useDockStore } from "@/stores/dock-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useGridStore } from "@/stores/grid-store";
import { ViewRenderer } from "@/components/views/ViewRenderer";
import { PaneControlBar } from "./PaneControlBar";
import { PaneGrid } from "./PaneGrid";
import { useHoverTimer } from "@/hooks/useHoverTimer";

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
  MemoView: "\u270e",
  FileExplorerView: "\ud83d\udcc2",
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
  const isFocused = focusedDock === position;
  const hasSplitPanes = panes.length >= 2;
  const hoverIdleSeconds = useSettingsStore((s) => s.convenience.hoverIdleSeconds);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const activeWsName = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
    return ws?.name ?? "";
  });

  const singleHover = useHoverTimer(hoverIdleSeconds);

  // Split panes rendering — delegates to shared PaneGrid
  if (hasSplitPanes) {
    return (
      <DockGrid
        position={position}
        panes={panes}
        activeWorkspaceId={activeWorkspaceId}
        activeWsName={activeWsName}
        onSplitPane={onSplitPane}
        onRemovePane={onRemovePane}
        onSetPaneView={onSetPaneView}
        onResizePane={onResizePane}
      />
    );
  }

  // Single-pane rendering (original behavior + split button on hover)
  const singlePaneId = panes[0]?.id;
  return (
    <div
      data-testid={`dock-${position}`}
      className="flex h-full w-full overflow-hidden"
      style={{ background: "var(--bg-surface)", borderColor: "var(--border)" }}
      onMouseEnter={() => singleHover.activate("__single__")}
      onMouseMove={() => singleHover.activate("__single__")}
      onMouseLeave={singleHover.clear}
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
        <PaneControlBar
          currentView={panes[0]?.view ?? { type: activeView ?? "EmptyView" }}
          hovered={singleHover.hoveredId !== null}
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
              singlePaneId &&
              onSetPaneView &&
              (panes[0]?.view.type === "TerminalView" || panes[0]?.view.type === "FileExplorerView")
                ? () =>
                    onSetPaneView(singlePaneId, {
                      ...panes[0].view,
                      cwdSend: !((panes[0].view.cwdSend as boolean) ?? true),
                    })
                : undefined,
            onToggleCwdReceive:
              singlePaneId &&
              onSetPaneView &&
              (panes[0]?.view.type === "TerminalView" || panes[0]?.view.type === "FileExplorerView")
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
            workspaceId={activeWorkspaceId}
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

/** Thin wrapper that configures PaneGrid for dock context */
function DockGrid({
  position,
  panes,
  activeWorkspaceId,
  activeWsName,
  onSplitPane,
  onRemovePane,
  onSetPaneView,
  onResizePane,
}: {
  position: DockPosition;
  panes: DockPane[];
  activeWorkspaceId: string;
  activeWsName: string;
  onSplitPane?: (direction: "horizontal" | "vertical", paneId?: string) => void;
  onRemovePane?: (paneId: string) => void;
  onSetPaneView?: (paneId: string, view: ViewInstanceConfig) => void;
  onResizePane?: (paneId: string, delta: Partial<Pick<DockPane, "x" | "y" | "w" | "h">>) => void;
}) {
  const focusedDock = useDockStore((s) => s.focusedDock);
  const focusedDockPaneId = useDockStore((s) => s.focusedDockPaneId);

  return (
    <PaneGrid
      panes={panes}
      containerTestId={`dock-${position}`}
      containerClassName="relative h-full w-full overflow-hidden"
      containerStyle={{ background: "var(--bg-surface)" }}
      testIdFn={(pane) => `dock-pane-${pane.id}`}
      isFocused={(paneId) => focusedDock === position && focusedDockPaneId === paneId}
      onPaneFocus={(paneId) => {
        useDockStore.getState().setFocusedDock(position, paneId);
        useGridStore.getState().setFocusedPane(null);
      }}
      onSetPaneView={onSetPaneView}
      onSplitPane={onSplitPane ? (paneId, dir) => onSplitPane(dir, paneId) : undefined}
      onRemovePane={onRemovePane}
      getCwdDefaults={() => ({ send: true, receive: true })}
      workspaceId={activeWorkspaceId}
      workspaceName={activeWsName}
      emptyViewContext="dock"
      location="dock"
      boundaryHandlesProps={{
        panes,
        getLatestPanes: () => useDockStore.getState().getDock(position)?.panes ?? [],
        onResizePane: (idx, delta) => {
          const pane = panes[idx];
          if (pane && onResizePane) onResizePane(pane.id, delta);
        },
        onRemovePane: (idx) => {
          const pane = panes[idx];
          if (pane && onRemovePane) onRemovePane(pane.id);
        },
      }}
    />
  );
}
