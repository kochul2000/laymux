import { useCallback, useRef, useEffect } from "react";
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
  const unreadCount = useNotificationStore((s) =>
    s.notifications.filter((n) => n.workspaceId === activeWorkspaceId && n.readAt === null).length,
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
    if (notificationDismiss === "paneFocus" && activeWorkspaceId && focusedPaneIndex !== null && unreadCount > 0) {
      markWorkspaceAsRead(activeWorkspaceId);
    }
  }, [notificationDismiss, activeWorkspaceId, focusedPaneIndex, unreadCount, markWorkspaceAsRead]);

  const top = docks.find((d) => d.position === "top");
  const bottom = docks.find((d) => d.position === "bottom");
  const left = docks.find((d) => d.position === "left");
  const right = docks.find((d) => d.position === "right");

  const renderDock = (dock: typeof top, borderSide: string) => {
    if (!dock?.visible) return null;
    const pos = dock.position;
    const isLR = pos === "left" || pos === "right";
    const isFocused = focusedDock === pos;
    return (
      <div
        className={`relative shrink-0 ${isLR ? "" : "w-full"}`}
        style={{
          [isLR ? "width" : "height"]: dock.size,
          [`border${borderSide}`]: `1px solid var(--border)`,
          background: "var(--bg-surface)",
        }}
        onMouseDown={() => {
          setFocusedDock(pos);
          useGridStore.getState().setFocusedPane(null);
        }}
      >
        <Dock
          position={pos}
          activeView={dock.activeView}
          views={dock.views}
          panes={dock.panes}
          onSwitchView={(v: ViewType) => setDockActiveView(pos, v)}
          onSplitPane={(dir, paneId) => splitDockPane(pos, dir, paneId)}
          onRemovePane={(paneId) => removeDockPane(pos, paneId)}
          onSetPaneView={(paneId, view) => setDockPaneView(pos, paneId, view)}
          onResizePane={(paneId, delta) => resizeDockPane(pos, paneId, delta)}
        />
        <DockResizeHandle position={pos} />
        {isFocused && (
          <div
            className="pointer-events-none absolute inset-0"
            style={{ boxShadow: "inset 0 0 0 1px var(--accent)", zIndex: 20 }}
          />
        )}
      </div>
    );
  };

  const topDock = renderDock(top, "Bottom");
  const bottomDock = renderDock(bottom, "Top");
  const leftDock = renderDock(left, "Right");
  const rightDock = renderDock(right, "Left");

  const workspace = (
    <div className="min-w-0 flex-1">
      <WorkspaceArea />
    </div>
  );

  const content =
    layoutMode === "horizontal" ? (
      <>
        {topDock}
        <div className="flex min-h-0 flex-1">
          {leftDock}
          {workspace}
          {rightDock}
        </div>
        {bottomDock}
      </>
    ) : (
      <div className="flex min-h-0 flex-1">
        {leftDock}
        <div className="flex min-w-0 flex-1 flex-col">
          {topDock}
          {workspace}
          {bottomDock}
        </div>
        {rightDock}
      </div>
    );

  return (
    <div className="flex h-full flex-col">
      <GridEditToolbar />
      {content}

      {/* Notification Panel Overlay */}
      {notificationPanelOpen && createPortal(
        <div
          data-testid="notification-panel-overlay"
          className="fixed inset-0 flex items-end justify-center"
          style={{ zIndex: 9998 }}
        >
          <div
            data-testid="notification-panel-backdrop"
            className="absolute inset-0"
            style={{ background: "rgba(0,0,0,0.3)" }}
            onClick={closeNotificationPanel}
          />
          <div
            className="relative z-10 mb-8 flex w-[480px] flex-col overflow-hidden rounded-lg shadow-2xl"
            style={{
              background: "var(--bg-surface, #181825)",
              border: "1px solid var(--border, #333)",
              maxHeight: "60vh",
            }}
          >
            <div
              className="flex items-center justify-between px-4 py-2"
              style={{ borderBottom: "1px solid var(--border)" }}
            >
              <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
                Notifications
              </span>
              <button
                data-testid="notification-panel-close"
                onClick={closeNotificationPanel}
                className="flex h-6 w-6 items-center justify-center rounded text-sm"
                style={{
                  color: "var(--text-secondary)",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                }}
                title="Close"
              >
                &#10005;
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <NotificationPanel workspaceId={activeWorkspaceId} />
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* Settings Modal — portaled to body to escape dock stacking contexts */}
      {settingsModalOpen && createPortal(
        <div
          data-testid="settings-modal"
          className="fixed inset-0 flex items-center justify-center"
          style={{ zIndex: 9999 }}
        >
          <div
            data-testid="settings-modal-backdrop"
            className="absolute inset-0"
            style={{ background: "rgba(0,0,0,0.5)" }}
            onClick={closeSettingsModal}
          />
          <div
            className="relative z-10 flex h-[85vh] w-[780px] flex-col overflow-hidden rounded-lg shadow-2xl"
            style={{
              background: "var(--bg-surface, #181825)",
              border: "1px solid var(--border, #333)",
            }}
          >
            {/* Modal title bar */}
            <div
              className="flex items-center justify-between px-4 py-2"
              style={{ borderBottom: "1px solid var(--border)" }}
            >
              <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
                Settings
              </span>
              <button
                data-testid="settings-modal-close"
                onClick={closeSettingsModal}
                className="flex h-6 w-6 items-center justify-center rounded text-sm"
                style={{
                  color: "var(--text-secondary)",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                }}
                title="Close"
              >
                &#10005;
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <SettingsView />
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
