import { describe, it, expect, beforeEach } from "vitest";
import { useNotificationStore } from "./notification-store";

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

  it("supports different notification levels", () => {
    const { addNotification } = useNotificationStore.getState();
    addNotification({ terminalId: "t1", workspaceId: "ws-1", message: "info", level: "info" });
    addNotification({ terminalId: "t1", workspaceId: "ws-1", message: "err", level: "error" });
    addNotification({ terminalId: "t1", workspaceId: "ws-1", message: "warn", level: "warning" });
    addNotification({ terminalId: "t1", workspaceId: "ws-1", message: "ok", level: "success" });

    const notifs = useNotificationStore.getState().notifications;
    expect(notifs.map((n) => n.level)).toEqual(["info", "error", "warning", "success"]);
  });
});
