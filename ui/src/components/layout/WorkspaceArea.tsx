import React, { useState } from "react";
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
        return (
          <PaneGrid
            key={ws.id}
            panes={ws.panes}
            isActive={isActive}
            testIdFn={(_pane, i) => (isActive ? `workspace-pane-${i}` : undefined)}
            isFocused={(paneId) => {
              const idx = ws.panes.findIndex((p) => p.id === paneId);
              return isActive && focusedPaneIndex === idx && focusedDock === null;
            }}
            onPaneFocus={(paneId) => {
              const idx = ws.panes.findIndex((p) => p.id === paneId);
              setFocusedPane(idx);
              useDockStore.getState().setFocusedDock(null);
            }}
            onSetPaneView={
              isActive
                ? (paneId, config) => {
                    const idx = ws.panes.findIndex((p) => p.id === paneId);
                    setPaneView(idx, config);
                  }
                : undefined
            }
            onSplitPane={
              isActive
                ? (paneId, dir) => {
                    const idx = ws.panes.findIndex((p) => p.id === paneId);
                    splitPane(idx, dir);
                  }
                : undefined
            }
            onRemovePane={
              isActive && ws.panes.length > 1
                ? (paneId) => {
                    const idx = ws.panes.findIndex((p) => p.id === paneId);
                    removePane(idx);
                  }
                : undefined
            }
            getCwdDefaults={(view: ViewInstanceConfig) => {
              const profileName = (view.profile as string) || defaultProfile || FALLBACK_PROFILE;
              return resolveSyncCwdForProfile(profileName, location);
            }}
            isHoveredOverride={
              isActive && automationHoverIndex !== null
                ? (paneId) => {
                    const idx = ws.panes.findIndex((p) => p.id === paneId);
                    return automationHoverIndex === idx;
                  }
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
