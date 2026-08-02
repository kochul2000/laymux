import type { DockPosition, DockPane, ViewType, ViewInstanceConfig } from "@/stores/types";
import { useDockStore } from "@/stores/dock-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useTerminalStartupStore } from "@/stores/terminal-startup-store";
import { useTerminalRestartStore } from "@/stores/terminal-restart-store";
import { focusDockPane } from "@/lib/workspace-transition";
import { ViewRenderer } from "@/components/views/ViewRenderer";
import { PaneLoadingPlaceholder } from "@/components/ui/PaneLoadingPlaceholder";
import { PaneControlBar } from "./PaneControlBar";
import { PaneGrid } from "./PaneGrid";
import { useHoverTimer } from "@/hooks/useHoverTimer";
import { useCwdDefaultsResolver } from "./useCwdDefaultsResolver";
import { getTerminalRestartCwd } from "@/lib/terminal-restart";
import { supportsCwdReceive, supportsCwdSend } from "@/lib/view-cwd-capability";

interface DockProps {
  position: DockPosition;
  activeView: ViewType | null;
  views: ViewType[];
  panes: DockPane[];
  onSwitchView?: (view: ViewType, viewConfig?: ViewInstanceConfig) => void;
  onSplitPane?: (paneId: string, direction: "horizontal" | "vertical") => void;
  onRemovePane?: (paneId: string) => void;
  onSetPaneView?: (paneId: string, view: ViewInstanceConfig) => void;
  onResizePane?: (paneId: string, delta: Partial<Pick<DockPane, "x" | "y" | "w" | "h">>) => void;
}

const viewIcons: Record<ViewType, string> = {
  WorkspaceSelectorView: "\u229e",
  SettingsView: "\u2699",
  TerminalView: ">_",
  MemoView: "\u270e",
  UsageView: "\u25f4",
  CodexUsageView: "\u25f4",
  FileExplorerView: "\ud83d\udcc2",
  GitHubView: "\u25c9",
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
  const hoverIdleSeconds = useSettingsStore((s) => s.controlBar.hoverIdleSeconds);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const activeWsName = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
    return ws?.name ?? "";
  });

  const singleHover = useHoverTimer(hoverIdleSeconds);
  const resolveCwdDefaults = useCwdDefaultsResolver("dock");
  const startupRevealedPaneIds = useTerminalStartupStore((state) => state.revealedPaneIds);
  // Restart requests live in a store, not local state (ADR-0113) — see PaneGrid.
  // Narrowed to this dock's single pane so another surface's restart does not
  // re-render it. `panes[0]` is read before the split-pane branch returns, so
  // the hook order stays fixed.
  const terminalRestart = useTerminalRestartStore((s) =>
    panes[0] ? s.requests[panes[0].id] : undefined,
  );
  const consumeTerminalRestart = useTerminalRestartStore((s) => s.consumeRestart);

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
  const singleView = panes[0]?.view;
  // The pane config is the coordinator's source of truth. Use the same type for
  // both gating and rendering even if a restored activeView is briefly stale.
  const renderedViewType = singleView?.type ?? activeView;
  const singleViewRevealed =
    renderedViewType !== "TerminalView" ||
    (singlePaneId !== undefined && startupRevealedPaneIds.has(singlePaneId));
  const singleCanSendCwd = supportsCwdSend(singleView?.type);
  const singleCanReceiveCwd = supportsCwdReceive(singleView?.type);
  const singleCwdDefaults =
    singleCanReceiveCwd && singleView ? resolveCwdDefaults(singleView) : null;
  const singleCwdSendOn =
    singleCwdDefaults && singleCanSendCwd
      ? ((singleView?.cwdSend as boolean | undefined) ?? singleCwdDefaults.send)
      : undefined;
  const singleCwdReceiveOn = singleCwdDefaults
    ? ((singleView?.cwdReceive as boolean | undefined) ?? singleCwdDefaults.receive)
    : undefined;

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
          paneId={singlePaneId}
          currentView={panes[0]?.view ?? { type: activeView ?? "EmptyView" }}
          hovered={singleHover.hoveredId !== null}
          cwdSendOn={singleCwdSendOn}
          cwdReceiveOn={singleCwdReceiveOn}
          actions={{
            onSplitH:
              onSplitPane && singlePaneId
                ? () => onSplitPane(singlePaneId, "horizontal")
                : undefined,
            onSplitV:
              onSplitPane && singlePaneId ? () => onSplitPane(singlePaneId, "vertical") : undefined,
            onClear:
              activeView && activeView !== "EmptyView"
                ? singlePaneId && onSetPaneView
                  ? () => onSetPaneView(singlePaneId, { type: "EmptyView" })
                  : onSwitchView
                    ? () => onSwitchView("EmptyView")
                    : undefined
                : undefined,
            onRestart:
              singleView?.type === "TerminalView" && singlePaneId
                ? () =>
                    useTerminalRestartStore
                      .getState()
                      .requestRestart(singlePaneId, getTerminalRestartCwd(singlePaneId, singleView))
                : undefined,
            onToggleCwdSend:
              singlePaneId && onSetPaneView && singleCanSendCwd && singleCwdDefaults
                ? () => {
                    const current =
                      (panes[0].view.cwdSend as boolean | undefined) ?? singleCwdDefaults.send;
                    onSetPaneView(singlePaneId, { ...panes[0].view, cwdSend: !current });
                  }
                : undefined,
            onToggleCwdReceive:
              singlePaneId && onSetPaneView && singleCanReceiveCwd && singleCwdDefaults
                ? () => {
                    const current =
                      (panes[0].view.cwdReceive as boolean | undefined) ??
                      singleCwdDefaults.receive;
                    onSetPaneView(singlePaneId, { ...panes[0].view, cwdReceive: !current });
                  }
                : undefined,
          }}
        >
          {singleViewRevealed ? (
            <ViewRenderer
              viewType={renderedViewType}
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
              terminalRestartEpoch={terminalRestart?.epoch}
              terminalRestartCwd={terminalRestart?.cwd}
              terminalRestartFresh={terminalRestart?.fresh}
              onTerminalRestartConsumed={() => {
                if (singlePaneId) consumeTerminalRestart(singlePaneId);
              }}
            />
          ) : (
            <PaneLoadingPlaceholder data-testid={`dock-pane-loading-${singlePaneId}`} />
          )}
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
  onSplitPane?: (paneId: string, direction: "horizontal" | "vertical") => void;
  onRemovePane?: (paneId: string) => void;
  onSetPaneView?: (paneId: string, view: ViewInstanceConfig) => void;
  onResizePane?: (paneId: string, delta: Partial<Pick<DockPane, "x" | "y" | "w" | "h">>) => void;
}) {
  const focusedDock = useDockStore((s) => s.focusedDock);
  const focusedDockPaneId = useDockStore((s) => s.focusedDockPaneId);
  const resolveCwdDefaults = useCwdDefaultsResolver("dock");

  return (
    <PaneGrid
      panes={panes}
      containerTestId={`dock-${position}`}
      containerClassName="relative h-full w-full overflow-hidden"
      containerStyle={{ background: "var(--bg-surface)" }}
      testIdFn={(pane) => `dock-pane-${pane.id}`}
      isFocused={(paneId) => focusedDock === position && focusedDockPaneId === paneId}
      onPaneFocus={(paneId) => {
        focusDockPane(position, paneId);
      }}
      onSetPaneView={onSetPaneView}
      onSplitPane={onSplitPane}
      onRemovePane={onRemovePane}
      getCwdDefaults={resolveCwdDefaults}
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
