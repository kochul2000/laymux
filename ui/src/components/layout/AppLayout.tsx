import { useCallback, useMemo, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useDockStore } from "@/stores/dock-store";
import { useGridStore } from "@/stores/grid-store";
import { useUiStore } from "@/stores/ui-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useNotificationStore } from "@/stores/notification-store";
import { Dock } from "./Dock";
import { GridEditToolbar } from "./GridEditToolbar";
import { WorkspaceArea } from "./WorkspaceArea";
import { SettingsView } from "@/components/views/SettingsView";
import { NotificationPanel } from "@/components/views/NotificationPanel";
import { useWorkspaceStore } from "@/stores/workspace-store";
import type { DockPosition, ViewType } from "@/stores/types";
import { useAppTheme } from "@/hooks/useAppTheme";

function ModalOverlay({
  testIdPrefix,
  overlayTestId,
  title,
  onClose,
  size,
  position = "center",
  zIndex = 9999,
  children,
}: {
  testIdPrefix: string;
  overlayTestId?: string;
  title: string;
  onClose: () => void;
  size: string;
  position?: "center" | "bottom";
  zIndex?: number;
  children: React.ReactNode;
}) {
  const alignClass =
    position === "bottom" ? "flex items-end justify-center" : "flex items-center justify-center";
  const backdrop = position === "bottom" ? "var(--backdrop-light)" : "var(--backdrop-heavy)";
  const margin = position === "bottom" ? "mb-8" : "";

  return createPortal(
    <div
      data-testid={overlayTestId ?? testIdPrefix}
      className={`fixed inset-0 ${alignClass}`}
      style={{ zIndex }}
    >
      <div
        data-testid={`${testIdPrefix}-backdrop`}
        className="absolute inset-0"
        style={{ background: backdrop }}
        onClick={onClose}
      />
      <div
        className={`relative z-10 flex flex-col overflow-hidden rounded-lg shadow-2xl ${margin} ${size}`}
        style={{
          background: "var(--bg-surface, #181825)",
          border: "1px solid var(--border, #333)",
        }}
      >
        <div
          className="flex items-center justify-between px-4 py-2"
          style={{ borderBottom: "1px solid var(--border)" }}
        >
          <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            {title}
          </span>
          <button
            data-testid={`${testIdPrefix}-close`}
            onClick={onClose}
            className="hover-bg-strong flex h-6 w-6 items-center justify-center rounded text-sm"
            style={{
              color: "var(--text-secondary)",
              border: "none",
              cursor: "pointer",
            }}
            title="Close"
          >
            &#10005;
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

function DockResizeHandle({ position }: { position: DockPosition }) {
  const dragging = useRef(false);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      const isHorizontal = position === "left" || position === "right";
      const startPos = isHorizontal ? e.clientX : e.clientY;
      const startSize = useDockStore.getState().getDock(position)?.size ?? 240;

      const onMouseMove = (me: MouseEvent) => {
        if (!dragging.current) return;
        const currentPos = isHorizontal ? me.clientX : me.clientY;
        const delta = currentPos - startPos;
        const sign = position === "left" || position === "top" ? 1 : -1;
        useDockStore.getState().setDockSize(position, startSize + delta * sign);
      };

      const onMouseUp = () => {
        dragging.current = false;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [position],
  );

  const isHorizontal = position === "left" || position === "right";
  const style: React.CSSProperties = isHorizontal
    ? {
        position: "absolute",
        top: 0,
        bottom: 0,
        width: 6,
        cursor: "col-resize",
        zIndex: 10,
        ...(position === "left" ? { right: -3 } : { left: -3 }),
      }
    : {
        position: "absolute",
        left: 0,
        right: 0,
        height: 6,
        cursor: "row-resize",
        zIndex: 10,
        ...(position === "top" ? { bottom: -3 } : { top: -3 }),
      };

  return (
    <div
      data-testid={`dock-resize-handle-${position}`}
      style={style}
      onMouseDown={handleMouseDown}
    />
  );
}

export function AppLayout() {
  useAppTheme();
  const docks = useDockStore((s) => s.docks);
  const layoutMode = useDockStore((s) => s.layoutMode);
  const focusedDock = useDockStore((s) => s.focusedDock);
  const setDockActiveView = useDockStore((s) => s.setDockActiveView);
  const splitDockPane = useDockStore((s) => s.splitDockPane);
  const removeDockPane = useDockStore((s) => s.removeDockPane);
  const setDockPaneView = useDockStore((s) => s.setDockPaneView);
  const resizeDockPane = useDockStore((s) => s.resizeDockPane);
  const setFocusedDock = useDockStore((s) => s.setFocusedDock);
  const settingsModalOpen = useUiStore((s) => s.settingsModalOpen);
  const closeSettingsModal = useUiStore((s) => s.closeSettingsModal);
  const notificationPanelOpen = useUiStore((s) => s.notificationPanelOpen);
  const closeNotificationPanel = useUiStore((s) => s.closeNotificationPanel);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const focusedPaneIndex = useGridStore((s) => s.focusedPaneIndex);
  const notificationDismiss = useSettingsStore((s) => s.convenience.notificationDismiss);
  const markWorkspaceAsRead = useNotificationStore((s) => s.markWorkspaceAsRead);
  const unreadCount = useNotificationStore(
    (s) =>
      s.notifications.filter((n) => n.workspaceId === activeWorkspaceId && n.readAt === null)
        .length,
  );

  // Auto-dismiss notifications based on setting
  // "workspace": mark as read whenever active workspace has unread notifications
  // "paneFocus": mark as read when a pane is focused in the active workspace
  useEffect(() => {
    if (notificationDismiss === "workspace" && activeWorkspaceId && unreadCount > 0) {
      markWorkspaceAsRead(activeWorkspaceId);
    }
  }, [notificationDismiss, activeWorkspaceId, unreadCount, markWorkspaceAsRead]);

  useEffect(() => {
    if (
      notificationDismiss === "paneFocus" &&
      activeWorkspaceId &&
      focusedPaneIndex !== null &&
      unreadCount > 0
    ) {
      markWorkspaceAsRead(activeWorkspaceId);
    }
  }, [notificationDismiss, activeWorkspaceId, focusedPaneIndex, unreadCount, markWorkspaceAsRead]);

  const top = docks.find((d) => d.position === "top");
  const bottom = docks.find((d) => d.position === "bottom");
  const left = docks.find((d) => d.position === "left");
  const right = docks.find((d) => d.position === "right");

  const dockPersistState = useSettingsStore((s) => s.convenience.dockPersistState);

  const gridStyles = useMemo((): React.CSSProperties => {
    const topSize = top?.visible ? `${top.size}px` : "0px";
    const bottomSize = bottom?.visible ? `${bottom.size}px` : "0px";
    const leftSize = left?.visible ? `${left.size}px` : "0px";
    const rightSize = right?.visible ? `${right.size}px` : "0px";

    return {
      display: "grid",
      gridTemplateAreas:
        layoutMode === "horizontal"
          ? `"top top top" "left ws right" "bottom bottom bottom"`
          : `"left top right" "left ws right" "left bottom right"`,
      gridTemplateColumns: `${leftSize} 1fr ${rightSize}`,
      gridTemplateRows: `${topSize} 1fr ${bottomSize}`,
    };
  }, [
    layoutMode,
    top?.visible,
    top?.size,
    bottom?.visible,
    bottom?.size,
    left?.visible,
    left?.size,
    right?.visible,
    right?.size,
  ]);

  const renderDockContent = (dock: typeof top, pos: DockPosition, _borderSide: string) => {
    if (!dock) return null;
    // When not visible: unmount if persistState is off, keep in DOM if on
    if (!dock.visible && !dockPersistState) return null;
    const isFocused = focusedDock === pos;
    return (
      <>
        <Dock
          position={pos}
          activeView={dock.activeView}
          views={dock.views}
          panes={dock.panes}
          onSwitchView={(v: ViewType, config?: import("@/stores/types").ViewInstanceConfig) =>
            setDockActiveView(pos, v, config)
          }
          onSplitPane={(dir, paneId) => splitDockPane(pos, dir, paneId)}
          onRemovePane={(paneId) => removeDockPane(pos, paneId)}
          onSetPaneView={(paneId, view) => setDockPaneView(pos, paneId, view)}
          onResizePane={(paneId, delta) => resizeDockPane(pos, paneId, delta)}
        />
        <DockResizeHandle position={pos} />
        {isFocused && dock.panes.length < 2 && (
          <div
            className="pointer-events-none absolute inset-0"
            style={{ boxShadow: "inset 0 0 0 1px var(--accent)", zIndex: 20 }}
          />
        )}
      </>
    );
  };

  const dockAreaStyle = (
    pos: DockPosition,
    borderSide: string,
    dock: typeof top,
  ): React.CSSProperties => {
    const areaMap = { top: "top", bottom: "bottom", left: "left", right: "right" } as const;
    if (!dock?.visible) return { gridArea: areaMap[pos], overflow: "hidden" };
    return {
      gridArea: areaMap[pos],
      position: "relative",
      overflow: "hidden",
      [`border${borderSide}`]: "1px solid var(--border)",
      background: "var(--bg-surface)",
    };
  };

  return (
    <div className="flex h-full flex-col">
      <GridEditToolbar />
      <div className="min-h-0 flex-1" style={gridStyles}>
        <div
          key="dock-top"
          style={dockAreaStyle("top", "Bottom", top)}
          onMouseDown={
            top?.visible
              ? () => {
                  setFocusedDock("top");
                  useGridStore.getState().setFocusedPane(null);
                }
              : undefined
          }
        >
          {renderDockContent(top, "top", "Bottom")}
        </div>
        <div
          key="dock-left"
          style={dockAreaStyle("left", "Right", left)}
          onMouseDown={
            left?.visible
              ? () => {
                  setFocusedDock("left");
                  useGridStore.getState().setFocusedPane(null);
                }
              : undefined
          }
        >
          {renderDockContent(left, "left", "Right")}
        </div>
        <div
          key="dock-ws"
          style={{ gridArea: "ws", minWidth: 0, minHeight: 0, overflow: "hidden" }}
        >
          <WorkspaceArea />
        </div>
        <div
          key="dock-right"
          style={dockAreaStyle("right", "Left", right)}
          onMouseDown={
            right?.visible
              ? () => {
                  setFocusedDock("right");
                  useGridStore.getState().setFocusedPane(null);
                }
              : undefined
          }
        >
          {renderDockContent(right, "right", "Left")}
        </div>
        <div
          key="dock-bottom"
          style={dockAreaStyle("bottom", "Top", bottom)}
          onMouseDown={
            bottom?.visible
              ? () => {
                  setFocusedDock("bottom");
                  useGridStore.getState().setFocusedPane(null);
                }
              : undefined
          }
        >
          {renderDockContent(bottom, "bottom", "Top")}
        </div>
      </div>

      {/* Notification Panel Overlay */}
      {notificationPanelOpen && (
        <ModalOverlay
          testIdPrefix="notification-panel"
          overlayTestId="notification-panel-overlay"
          title="Notifications"
          onClose={closeNotificationPanel}
          size="w-[480px] max-h-[60vh]"
          position="bottom"
          zIndex={9998}
        >
          <div className="min-h-0 flex-1 overflow-y-auto">
            <NotificationPanel workspaceId={activeWorkspaceId} />
          </div>
        </ModalOverlay>
      )}

      {/* Settings Modal — portaled to body to escape dock stacking contexts */}
      {settingsModalOpen && (
        <ModalOverlay
          testIdPrefix="settings-modal"
          title="Settings"
          onClose={closeSettingsModal}
          size="w-[780px] h-[85vh]"
        >
          <div className="min-h-0 flex-1">
            <SettingsView />
          </div>
        </ModalOverlay>
      )}
    </div>
  );
}
