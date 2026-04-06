import { useState } from "react";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useGridStore } from "@/stores/grid-store";
import { useDockStore } from "@/stores/dock-store";
import { useSettingsStore, FALLBACK_PROFILE, type TerminalLocation } from "@/stores/settings-store";
import type { ViewInstanceConfig } from "@/stores/types";
import { PaneGrid } from "./PaneGrid";

export function WorkspaceArea() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const focusedPaneIndex = useGridStore((s) => s.focusedPaneIndex);
  const setFocusedPane = useGridStore((s) => s.setFocusedPane);
  const automationHoverIndex = useGridStore((s) => s.automationHoverIndex);
  const focusedDock = useDockStore((s) => s.focusedDock);
  const setPaneView = useWorkspaceStore((s) => s.setPaneView);
  const splitPane = useWorkspaceStore((s) => s.splitPane);
  const removePane = useWorkspaceStore((s) => s.removePane);
  const defaultProfile = useSettingsStore((s) => s.defaultProfile);
  const resolveSyncCwdForProfile = useSettingsStore((s) => s.resolveSyncCwdForProfile);
  const location: TerminalLocation = "workspace";

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
        const indexMap = new Map(ws.panes.map((p, i) => [p.id, i]));
        const idxOf = (paneId: string) => indexMap.get(paneId) ?? -1;
        return (
          <PaneGrid
            key={ws.id}
            panes={ws.panes}
            isActive={isActive}
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
            getCwdDefaults={(view: ViewInstanceConfig) => {
              const profileName = (view.profile as string) || defaultProfile || FALLBACK_PROFILE;
              return resolveSyncCwdForProfile(profileName, location);
            }}
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
