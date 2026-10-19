import { beforeEach, describe, expect, it, vi } from "vitest";
import { useNotificationStore } from "@/stores/notification-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useSettingsStore } from "@/stores/settings-store";
import { subscribeNotificationPush } from "./notification-push";

describe("기기 알림 발행", () => {
  beforeEach(() => {
    useNotificationStore.setState(useNotificationStore.getInitialState());
    useWorkspaceStore.setState({ activeWorkspaceId: "active" });
    useSettingsStore.setState({ notifications: { dismiss: "workspace" } });
  });

  it("도착 자동 읽음인 새 알림도 한 번 발행하고 기존 목록은 재발행하지 않는다", async () => {
    useNotificationStore
      .getState()
      .addNotification({ terminalId: "old", workspaceId: "active", message: "old" });
    const send = vi.fn().mockResolvedValue(undefined);
    const stop = subscribeNotificationPush(send);
    const n = useNotificationStore
      .getState()
      .addNotification({ terminalId: "t", workspaceId: "active", message: "new" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(n.readAt).not.toBeNull();
    expect(n.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(send).toHaveBeenCalledWith({
      notificationId: n.id,
      revision: 1,
      category: "general",
      body: "new",
    });
    useNotificationStore.getState().markTerminalAsRead("t");
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    stop();
  });

  it("사용자 읽음·삭제는 단조 revision으로 전달하고 장애는 원래 알림을 막지 않는다", async () => {
    const send = vi.fn().mockRejectedValue(new Error("offline"));
    const stop = subscribeNotificationPush(send);
    const n = useNotificationStore.getState().addNotification({
      terminalId: "t",
      workspaceId: "other",
      message: "secret",
      requiresAction: true,
    });
    useNotificationStore.getState().markNotificationsAsRead([n.id]);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls.map(([event]) => event.revision)).toEqual([1, 2]);
    expect(send.mock.calls[1][0]).not.toHaveProperty("body");
    expect(useNotificationStore.getState().notifications).toHaveLength(1);
    stop();
  });
});
