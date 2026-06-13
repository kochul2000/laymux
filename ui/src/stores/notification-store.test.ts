import { describe, it, expect, beforeEach } from "vitest";
import { useNotificationStore } from "./notification-store";
import { useWorkspaceStore } from "./workspace-store";
import { useSettingsStore } from "./settings-store";
import { useGridStore } from "./grid-store";

describe("NotificationStore", () => {
  beforeEach(() => {
    useNotificationStore.setState(useNotificationStore.getInitialState());
  });

  it("starts with no notifications", () => {
    const state = useNotificationStore.getState();
    expect(state.notifications).toHaveLength(0);
  });

  it("adds a notification with terminalId and level", () => {
    useNotificationStore.getState().addNotification({
      terminalId: "terminal-1",
      workspaceId: "ws-1",
      message: "Build complete",
      level: "success",
    });
    const notifs = useNotificationStore.getState().notifications;
    expect(notifs).toHaveLength(1);
    expect(notifs[0].terminalId).toBe("terminal-1");
    expect(notifs[0].workspaceId).toBe("ws-1");
    expect(notifs[0].message).toBe("Build complete");
    expect(notifs[0].level).toBe("success");
    expect(notifs[0].readAt).toBeNull();
    expect(notifs[0].createdAt).toBeGreaterThan(0);
    expect(notifs[0].id).toBeTruthy();
  });

  it("defaults level to info when not specified", () => {
    useNotificationStore.getState().addNotification({
      terminalId: "terminal-1",
      workspaceId: "ws-1",
      message: "Something happened",
    });
    expect(useNotificationStore.getState().notifications[0].level).toBe("info");
  });

  it("marks all workspace notifications as read with readAt timestamp", () => {
    const { addNotification } = useNotificationStore.getState();
    addNotification({ terminalId: "t1", workspaceId: "ws-1", message: "msg1" });
    addNotification({ terminalId: "t2", workspaceId: "ws-1", message: "msg2" });
    addNotification({ terminalId: "t3", workspaceId: "ws-2", message: "msg3" });

    useNotificationStore.getState().markWorkspaceAsRead("ws-1");
    const notifs = useNotificationStore.getState().notifications;

    const ws1Notifs = notifs.filter((n) => n.workspaceId === "ws-1");
    expect(ws1Notifs.every((n) => n.readAt !== null)).toBe(true);
    expect(ws1Notifs.every((n) => typeof n.readAt === "number")).toBe(true);

    const ws2Notif = notifs.find((n) => n.workspaceId === "ws-2")!;
    expect(ws2Notif.readAt).toBeNull();
  });

  it("markTerminalAsRead marks only the given terminal's unread alerts", () => {
    const { addNotification } = useNotificationStore.getState();
    // ws-x is not the active workspace, so nothing auto-dismisses on add.
    addNotification({ terminalId: "terminal-a", workspaceId: "ws-x", message: "a1" });
    addNotification({ terminalId: "terminal-a", workspaceId: "ws-x", message: "a2" });
    addNotification({ terminalId: "terminal-b", workspaceId: "ws-x", message: "b1" });

    useNotificationStore.getState().markTerminalAsRead("terminal-a");
    const notifs = useNotificationStore.getState().notifications;

    expect(
      notifs.filter((n) => n.terminalId === "terminal-a").every((n) => n.readAt !== null),
    ).toBe(true);
    expect(notifs.find((n) => n.terminalId === "terminal-b")!.readAt).toBeNull();
  });

  it("markTerminalAsRead preserves requiresAction alerts", () => {
    const { addNotification } = useNotificationStore.getState();
    addNotification({
      terminalId: "terminal-a",
      workspaceId: "ws-x",
      message: "modal",
      requiresAction: true,
    });
    addNotification({ terminalId: "terminal-a", workspaceId: "ws-x", message: "done" });

    useNotificationStore.getState().markTerminalAsRead("terminal-a");
    const notifs = useNotificationStore.getState().notifications;

    expect(notifs.find((n) => n.message === "modal")?.readAt).toBeNull();
    expect(notifs.find((n) => n.message === "done")?.readAt).not.toBeNull();
  });

  it("counts unread notifications per workspace", () => {
    const { addNotification } = useNotificationStore.getState();
    addNotification({ terminalId: "t1", workspaceId: "ws-1", message: "a" });
    addNotification({ terminalId: "t2", workspaceId: "ws-1", message: "b" });
    addNotification({ terminalId: "t3", workspaceId: "ws-2", message: "c" });

    expect(useNotificationStore.getState().getUnreadCount("ws-1")).toBe(2);
    expect(useNotificationStore.getState().getUnreadCount("ws-2")).toBe(1);
    expect(useNotificationStore.getState().getUnreadCount("ws-3")).toBe(0);
  });

  it("gets latest unread notification for a workspace", () => {
    const { addNotification } = useNotificationStore.getState();
    addNotification({ terminalId: "t1", workspaceId: "ws-1", message: "first" });
    addNotification({ terminalId: "t2", workspaceId: "ws-1", message: "second" });

    const latest = useNotificationStore.getState().getLatestNotification("ws-1");
    expect(latest?.message).toBe("second");
  });

  it("returns undefined for latest notification when none exist", () => {
    expect(useNotificationStore.getState().getLatestNotification("ws-1")).toBeUndefined();
  });

  it("preserves already-read notifications when marking workspace as read", () => {
    const { addNotification } = useNotificationStore.getState();
    addNotification({ terminalId: "t1", workspaceId: "ws-1", message: "old" });

    // Mark read first time
    useNotificationStore.getState().markWorkspaceAsRead("ws-1");
    const firstReadAt = useNotificationStore.getState().notifications[0].readAt;

    // Add new notification and mark again
    addNotification({ terminalId: "t2", workspaceId: "ws-1", message: "new" });
    useNotificationStore.getState().markWorkspaceAsRead("ws-1");

    // First notification's readAt should not change
    expect(useNotificationStore.getState().notifications[0].readAt).toBe(firstReadAt);
  });

  it("marks specific notifications as read by IDs", () => {
    const { addNotification } = useNotificationStore.getState();
    addNotification({ terminalId: "t1", workspaceId: "ws-1", message: "a" });
    addNotification({ terminalId: "t2", workspaceId: "ws-1", message: "b" });
    addNotification({ terminalId: "t3", workspaceId: "ws-2", message: "c" });

    const notifs = useNotificationStore.getState().notifications;
    const idsToMark = [notifs[0].id, notifs[2].id];

    useNotificationStore.getState().markNotificationsAsRead(idsToMark);

    const updated = useNotificationStore.getState().notifications;
    expect(updated[0].readAt).not.toBeNull();
    expect(updated[1].readAt).toBeNull(); // untouched
    expect(updated[2].readAt).not.toBeNull();
  });

  it("markNotificationsAsRead does not affect already-read notifications", () => {
    const { addNotification } = useNotificationStore.getState();
    addNotification({ terminalId: "t1", workspaceId: "ws-1", message: "a" });

    // Mark via workspace first
    useNotificationStore.getState().markWorkspaceAsRead("ws-1");
    const firstReadAt = useNotificationStore.getState().notifications[0].readAt;

    // Mark again by ID — readAt should not change
    const id = useNotificationStore.getState().notifications[0].id;
    useNotificationStore.getState().markNotificationsAsRead([id]);
    expect(useNotificationStore.getState().notifications[0].readAt).toBe(firstReadAt);
  });

  it("supports different notification levels", () => {
    const { addNotification } = useNotificationStore.getState();
    addNotification({ terminalId: "t1", workspaceId: "ws-1", message: "info", level: "info" });
    addNotification({ terminalId: "t1", workspaceId: "ws-1", message: "err", level: "error" });
    addNotification({ terminalId: "t1", workspaceId: "ws-1", message: "warn", level: "warning" });
    addNotification({ terminalId: "t1", workspaceId: "ws-1", message: "ok", level: "success" });

    const notifs = useNotificationStore.getState().notifications;
    expect(notifs.map((n) => n.level)).toEqual(["info", "error", "warning", "success"]);
  });

  it("hasUnreadForTerminal returns true when terminal has unread notifications", () => {
    useNotificationStore.getState().addNotification({
      terminalId: "terminal-p1",
      workspaceId: "ws-1",
      message: "alert",
    });
    expect(useNotificationStore.getState().hasUnreadForTerminal("terminal-p1")).toBe(true);
  });

  it("hasUnreadForTerminal returns false when terminal has no notifications", () => {
    expect(useNotificationStore.getState().hasUnreadForTerminal("terminal-p1")).toBe(false);
  });

  it("hasUnreadForTerminal returns false after notifications are read", () => {
    useNotificationStore.getState().addNotification({
      terminalId: "terminal-p1",
      workspaceId: "ws-1",
      message: "alert",
    });
    useNotificationStore.getState().markWorkspaceAsRead("ws-1");
    expect(useNotificationStore.getState().hasUnreadForTerminal("terminal-p1")).toBe(false);
  });

  it("hasUnreadForTerminal is scoped to specific terminal", () => {
    useNotificationStore.getState().addNotification({
      terminalId: "terminal-p1",
      workspaceId: "ws-1",
      message: "alert for p1",
    });
    useNotificationStore.getState().addNotification({
      terminalId: "terminal-p2",
      workspaceId: "ws-1",
      message: "alert for p2",
    });
    expect(useNotificationStore.getState().hasUnreadForTerminal("terminal-p1")).toBe(true);
    expect(useNotificationStore.getState().hasUnreadForTerminal("terminal-p2")).toBe(true);
    expect(useNotificationStore.getState().hasUnreadForTerminal("terminal-p3")).toBe(false);
  });

  describe("removeNotifications", () => {
    it("removes notifications by ID and returns the cleared count", () => {
      const { addNotification } = useNotificationStore.getState();
      addNotification({ terminalId: "t1", workspaceId: "ws-other-1", message: "a" });
      addNotification({ terminalId: "t2", workspaceId: "ws-other-2", message: "b" });
      addNotification({ terminalId: "t3", workspaceId: "ws-other-3", message: "c" });

      const ids = useNotificationStore
        .getState()
        .notifications.slice(0, 2)
        .map((n) => n.id);
      const cleared = useNotificationStore.getState().removeNotifications(ids);

      expect(cleared).toBe(2);
      const remaining = useNotificationStore.getState().notifications;
      expect(remaining).toHaveLength(1);
      expect(remaining[0].message).toBe("c");
    });

    it("returns 0 and preserves state when no ID matches", () => {
      useNotificationStore.getState().addNotification({
        terminalId: "t1",
        workspaceId: "ws-other",
        message: "keep me",
      });
      const cleared = useNotificationStore.getState().removeNotifications(["nope-1", "nope-2"]);
      expect(cleared).toBe(0);
      expect(useNotificationStore.getState().notifications).toHaveLength(1);
    });

    it("updates getUnreadCount after removal", () => {
      const { addNotification } = useNotificationStore.getState();
      addNotification({ terminalId: "t1", workspaceId: "ws-unread-a", message: "a" });
      addNotification({ terminalId: "t2", workspaceId: "ws-unread-a", message: "b" });
      expect(useNotificationStore.getState().getUnreadCount("ws-unread-a")).toBe(2);

      const firstId = useNotificationStore.getState().notifications[0].id;
      useNotificationStore.getState().removeNotifications([firstId]);
      expect(useNotificationStore.getState().getUnreadCount("ws-unread-a")).toBe(1);
    });
  });

  describe("clearNotificationsBefore", () => {
    it("removes notifications with createdAt strictly before timestamp", () => {
      const now = Date.now();
      useNotificationStore.setState({
        notifications: [
          {
            id: "old-1",
            terminalId: "t1",
            workspaceId: "ws-old",
            message: "old",
            level: "info",
            createdAt: now - 10000,
            readAt: now - 5000,
          },
          {
            id: "old-2",
            terminalId: "t2",
            workspaceId: "ws-old",
            message: "old unread",
            level: "info",
            createdAt: now - 5000,
            readAt: null,
          },
          {
            id: "new-1",
            terminalId: "t3",
            workspaceId: "ws-new",
            message: "fresh",
            level: "info",
            createdAt: now - 1000,
            readAt: null,
          },
        ],
      });

      const cleared = useNotificationStore.getState().clearNotificationsBefore(now - 2000);
      expect(cleared).toBe(2);
      const remaining = useNotificationStore.getState().notifications;
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe("new-1");
    });

    it("with readOnly=true, only removes already-read notifications older than timestamp", () => {
      const now = Date.now();
      useNotificationStore.setState({
        notifications: [
          {
            id: "read-old",
            terminalId: "t1",
            workspaceId: "ws-ro",
            message: "read + old",
            level: "info",
            createdAt: now - 10000,
            readAt: now - 5000,
          },
          {
            id: "unread-old",
            terminalId: "t2",
            workspaceId: "ws-ro",
            message: "unread + old",
            level: "info",
            createdAt: now - 8000,
            readAt: null,
          },
          {
            id: "read-new",
            terminalId: "t3",
            workspaceId: "ws-ro",
            message: "read + new",
            level: "info",
            createdAt: now - 500,
            readAt: now - 100,
          },
        ],
      });

      const cleared = useNotificationStore.getState().clearNotificationsBefore(now - 2000, true);
      expect(cleared).toBe(1);
      const ids = useNotificationStore.getState().notifications.map((n) => n.id);
      expect(ids).toContain("unread-old");
      expect(ids).toContain("read-new");
      expect(ids).not.toContain("read-old");
    });

    it("returns 0 when nothing matches", () => {
      const now = Date.now();
      useNotificationStore.getState().addNotification({
        terminalId: "t1",
        workspaceId: "ws-keep",
        message: "keep",
      });
      const cleared = useNotificationStore.getState().clearNotificationsBefore(now - 100000);
      expect(cleared).toBe(0);
      expect(useNotificationStore.getState().notifications).toHaveLength(1);
    });
  });

  describe("auto-dismiss for active workspace", () => {
    beforeEach(() => {
      // This block mutates settings/grid/workspace state — reset all of them so
      // mode and focus don't leak between tests.
      useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
      useGridStore.setState(useGridStore.getInitialState());
      useSettingsStore.setState(useSettingsStore.getInitialState());
    });

    it("marks notification as read immediately when added to the active workspace in workspace dismiss mode", () => {
      const activeWsId = useWorkspaceStore.getState().activeWorkspaceId;

      useNotificationStore.getState().addNotification({
        terminalId: "t1",
        workspaceId: activeWsId,
        message: "shell started",
      });

      const notifs = useNotificationStore.getState().notifications;
      expect(notifs).toHaveLength(1);
      expect(notifs[0].readAt).not.toBeNull();
    });

    it("does NOT auto-dismiss when notification is for a different workspace", () => {
      useNotificationStore.getState().addNotification({
        terminalId: "t1",
        workspaceId: "ws-other",
        message: "shell started",
      });

      const notifs = useNotificationStore.getState().notifications;
      expect(notifs[0].readAt).toBeNull();
    });

    it("does NOT auto-dismiss when notificationDismiss is manual", () => {
      const activeWsId = useWorkspaceStore.getState().activeWorkspaceId;
      useSettingsStore.setState({
        notifications: {
          ...useSettingsStore.getState().notifications,
          dismiss: "manual",
        },
      });

      useNotificationStore.getState().addNotification({
        terminalId: "t1",
        workspaceId: activeWsId,
        message: "shell started",
      });

      const notifs = useNotificationStore.getState().notifications;
      expect(notifs[0].readAt).toBeNull();
    });

    it("auto-dismisses only the focused pane's alert in paneFocus mode", () => {
      // paneFocus 모드는 워크스페이스 전체가 아니라 "포커스된 그 pane"의 알림만
      // 해제해야 한다 (ADR 0010).
      useWorkspaceStore.getState().setPaneView(0, { type: "TerminalView" });
      const ws = useWorkspaceStore.getState().getActiveWorkspace()!;
      const focusedPaneId = ws.panes[0].id;
      useSettingsStore.setState({
        notifications: {
          ...useSettingsStore.getState().notifications,
          dismiss: "paneFocus",
        },
      });
      useGridStore.setState({ focusedPaneIndex: 0 });

      // 포커스된 pane 의 터미널에서 온 알림 → 즉시 해제.
      useNotificationStore.getState().addNotification({
        terminalId: `terminal-${focusedPaneId}`,
        workspaceId: ws.id,
        message: "focused pane done",
      });
      // 다른 pane 의 터미널에서 온 알림 → unread 유지.
      useNotificationStore.getState().addNotification({
        terminalId: "terminal-other-pane",
        workspaceId: ws.id,
        message: "other pane done",
      });

      const notifs = useNotificationStore.getState().notifications;
      expect(notifs.find((n) => n.message === "focused pane done")?.readAt).not.toBeNull();
      expect(notifs.find((n) => n.message === "other pane done")?.readAt).toBeNull();
    });

    it("does NOT auto-dismiss requiresAction alerts even on the active workspace", () => {
      // A Claude permission modal needs an explicit user response.
      // Without the requiresAction exemption, the alert would be marked
      // read the instant it lands (because the user happens to be
      // viewing that workspace) and the badge would never light up.
      const activeWsId = useWorkspaceStore.getState().activeWorkspaceId;

      useNotificationStore.getState().addNotification({
        terminalId: "t1",
        workspaceId: activeWsId,
        message: "Claude is waiting for your input",
        requiresAction: true,
      });

      const notifs = useNotificationStore.getState().notifications;
      expect(notifs[0].readAt).toBeNull();
      expect(notifs[0].requiresAction).toBe(true);
    });

    it("markWorkspaceAsRead preserves requiresAction alerts", () => {
      // Switching into the workspace shouldn't silently dismiss a
      // still-active modal alert; only the user's explicit click or
      // the originator clearing the underlying state should do that.
      useNotificationStore.getState().addNotification({
        terminalId: "t1",
        workspaceId: "ws-1",
        message: "Claude is waiting for your input",
        requiresAction: true,
      });
      useNotificationStore.getState().addNotification({
        terminalId: "t1",
        workspaceId: "ws-1",
        message: "Build done",
      });

      useNotificationStore.getState().markWorkspaceAsRead("ws-1");
      const notifs = useNotificationStore.getState().notifications;
      expect(
        notifs.find((n) => n.message === "Claude is waiting for your input")?.readAt,
      ).toBeNull();
      expect(notifs.find((n) => n.message === "Build done")?.readAt).not.toBeNull();
    });

    it("does NOT auto-dismiss in paneFocus mode when no pane is focused", () => {
      const activeWsId = useWorkspaceStore.getState().activeWorkspaceId;
      useSettingsStore.setState({
        notifications: {
          ...useSettingsStore.getState().notifications,
          dismiss: "paneFocus",
        },
      });
      useGridStore.setState({ focusedPaneIndex: null });

      useNotificationStore.getState().addNotification({
        terminalId: "t1",
        workspaceId: activeWsId,
        message: "shell started",
      });

      const notifs = useNotificationStore.getState().notifications;
      expect(notifs[0].readAt).toBeNull();
    });
  });
});
