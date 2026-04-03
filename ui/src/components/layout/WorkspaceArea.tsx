import React, { useRef, useState, useEffect, useCallback } from "react";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useGridStore } from "@/stores/grid-store";
import { useDockStore } from "@/stores/dock-store";
import { useSettingsStore, FALLBACK_PROFILE, type TerminalLocation } from "@/stores/settings-store";
import { ViewRenderer } from "@/components/views/ViewRenderer";
import { PaneBoundaryHandles } from "./PaneBoundaryHandles";
import { PaneControlBar } from "./PaneControlBar";

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
  const hoverIdleSeconds = useSettingsStore((s) => s.convenience.hoverIdleSeconds);
  const defaultProfile = useSettingsStore((s) => s.defaultProfile);
  const resolveSyncCwdForProfile = useSettingsStore((s) => s.resolveSyncCwdForProfile);
  const location: TerminalLocation = "workspace";
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hoveredPane, setHoveredPane] = useState<string | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Lazy mount: only render panes for workspaces that have been activated at least once.
  // Prevents unnecessary TerminalView/WebGL initialization for never-visited workspaces,
  // reducing GPU pressure at startup (fixes WebView2 GPU process crash).
  // Track ever-activated workspace IDs. Uses React's "set state during render"
  // pattern to grow the set monotonically without cascading effect renders.
  const [mountedWsIds, setMountedWsIds] = useState(() => new Set([activeWorkspaceId]));
  if (!mountedWsIds.has(activeWorkspaceId)) {
    setMountedWsIds(new Set(mountedWsIds).add(activeWorkspaceId));
  }

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
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    };
  }, []);

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

  return (
    <div ref={containerRef} data-testid="workspace-area" className="relative h-full w-full">
      {workspaces.map((ws) => {
        const isActive = ws.id === activeWorkspaceId;
        if (!mountedWsIds.has(ws.id)) return null;
        return (
          <React.Fragment key={ws.id}>
            {ws.panes.map((pane, i) => {
              const isFocused = isActive && focusedPaneIndex === i && focusedDock === null;
              const isHovered = hoveredPane === pane.id || (isActive && automationHoverIndex === i);

              return (
                <div
                  key={pane.id}
                  data-testid={isActive ? `workspace-pane-${i}` : undefined}
                  className="absolute overflow-hidden"
                  onMouseDown={() => {
                    if (!isActive) return;
                    setFocusedPane(i);
                    useDockStore.getState().setFocusedDock(null);
                  }}
                  onMouseEnter={() => isActive && handlePaneHoverActivity(pane.id)}
                  onMouseMove={() => isActive && handlePaneHoverActivity(pane.id)}
                  onMouseLeave={() => {
                    setHoveredPane(null);
                    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
                  }}
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
                  {/* Focus indicator overlay — above content, like Dock */}
                  {isFocused && (
                    <div
                      data-testid="pane-focus-indicator"
                      className="pointer-events-none absolute inset-0"
                      style={{ boxShadow: "inset 0 0 0 1px var(--accent)", zIndex: 20 }}
                    />
                  )}
                  <PaneControlBar
                    currentView={pane.view}
                    hovered={isActive && isHovered}
                    actions={{
                      onChangeView: isActive ? (config) => setPaneView(i, config) : undefined,
                      onSplitH: isActive ? () => splitPane(i, "horizontal") : undefined,
                      onSplitV: isActive ? () => splitPane(i, "vertical") : undefined,
                      onClear: isActive ? () => setPaneView(i, { type: "EmptyView" }) : undefined,
                      onDelete: isActive && ws.panes.length > 1 ? () => removePane(i) : undefined,
                      onToggleCwdSend:
                        isActive && pane.view.type === "TerminalView"
                          ? () => {
                              const profileName =
                                (pane.view.profile as string) || defaultProfile || FALLBACK_PROFILE;
                              const resolved = resolveSyncCwdForProfile(profileName, location);
                              const current =
                                (pane.view.cwdSend as boolean | undefined) ?? resolved.send;
                              setPaneView(i, { ...pane.view, cwdSend: !current });
                            }
                          : undefined,
                      onToggleCwdReceive:
                        isActive && pane.view.type === "TerminalView"
                          ? () => {
                              const profileName =
                                (pane.view.profile as string) || defaultProfile || FALLBACK_PROFILE;
                              const resolved = resolveSyncCwdForProfile(profileName, location);
                              const current =
                                (pane.view.cwdReceive as boolean | undefined) ?? resolved.receive;
                              setPaneView(i, { ...pane.view, cwdReceive: !current });
                            }
                          : undefined,
                    }}
                  >
                    <ViewRenderer
                      viewType={pane.view.type}
                      viewConfig={pane.view}
                      onSelectView={isActive ? (config) => setPaneView(i, config) : undefined}
                      workspaceName={ws.name}
                      workspaceId={ws.id}
                      paneId={pane.id}
                      isFocused={isFocused}
                      onKeyboardActivity={() => {
                        setHoveredPane(null);
                        if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
                      }}
                    />
                  </PaneControlBar>
                </div>
              );
            })}
          </React.Fragment>
        );
      })}
      <PaneBoundaryHandles containerWidth={size.w} containerHeight={size.h} />
    </div>
  );
}
