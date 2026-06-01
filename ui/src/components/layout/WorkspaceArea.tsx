import { useState } from "react";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useGridStore } from "@/stores/grid-store";
import { useDockStore } from "@/stores/dock-store";
import { useUiStore } from "@/stores/ui-store";
import type { TerminalLocation } from "@/stores/settings-store";
import { PaneGrid } from "./PaneGrid";
import { useCwdDefaultsResolver } from "./useCwdDefaultsResolver";

export function WorkspaceArea() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  // Panes auto-closed after staying hidden (issue #269). Their TerminalView is
  // dropped from the background workspace so the PTY is torn down; un-hiding the
  // pane removes it from this set and re-mounts a fresh terminal.
  const evictedPaneIds = useUiStore((s) => s.evictedPaneIds);
  const focusedPaneIndex = useGridStore((s) => s.focusedPaneIndex);
  const setFocusedPane = useGridStore((s) => s.setFocusedPane);
  const automationHoverIndex = useGridStore((s) => s.automationHoverIndex);
  const focusedDock = useDockStore((s) => s.focusedDock);
  const setPaneView = useWorkspaceStore((s) => s.setPaneView);
  const splitPane = useWorkspaceStore((s) => s.splitPane);
  const removePane = useWorkspaceStore((s) => s.removePane);
  const location: TerminalLocation = "workspace";
  const resolveCwdDefaults = useCwdDefaultsResolver(location);

  // Lazy mount: only render panes for workspaces that have been activated at least once.
  // Prevents unnecessary TerminalView/WebGL initialization for never-visited workspaces,
  // reducing GPU pressure at startup (fixes WebView2 GPU process crash).
  const [mountedWsIds, setMountedWsIds] = useState(() => new Set([activeWorkspaceId]));
  if (!mountedWsIds.has(activeWorkspaceId)) {
    setMountedWsIds(new Set(mountedWsIds).add(activeWorkspaceId));
  }

  return (
    <div data-testid="workspace-area" className="relative h-full w-full">
      {workspaces.map((ws) => {
        const isActive = ws.id === activeWorkspaceId;
        if (!mountedWsIds.has(ws.id)) return null;
        // Only background workspaces may have panes evicted; the active workspace
        // always renders in full so the user never sees a blanked-out pane.
        const renderedPanes =
          isActive || evictedPaneIds.size === 0
            ? ws.panes
            : ws.panes.filter((p) => !evictedPaneIds.has(p.id));
        const indexMap = new Map(ws.panes.map((p, i) => [p.id, i]));
        const idxOf = (paneId: string) => indexMap.get(paneId) ?? -1;
        return (
          <PaneGrid
            key={ws.id}
            panes={renderedPanes}
            isActive={isActive}
            showPaneNumbers
            containerClassName="absolute inset-0"
            containerStyle={{ display: isActive ? undefined : "none" }}
            testIdFn={(_pane, i) => (isActive ? `workspace-pane-${i}` : undefined)}
            isFocused={(paneId) =>
              isActive && focusedPaneIndex === idxOf(paneId) && focusedDock === null
            }
            onPaneFocus={(paneId) => {
              setFocusedPane(idxOf(paneId));
              useDockStore.getState().setFocusedDock(null);
            }}
            onSetPaneView={
              isActive ? (paneId, config) => setPaneView(idxOf(paneId), config) : undefined
            }
            onSplitPane={isActive ? (paneId, dir) => splitPane(idxOf(paneId), dir) : undefined}
            onRemovePane={isActive ? (paneId) => removePane(idxOf(paneId)) : undefined}
            getCwdDefaults={resolveCwdDefaults}
            isHoveredOverride={
              isActive && automationHoverIndex !== null
                ? (paneId) => automationHoverIndex === idxOf(paneId)
                : undefined
            }
            workspaceId={ws.id}
            workspaceName={ws.name}
            location="workspace"
          />
        );
      })}
    </div>
  );
}
