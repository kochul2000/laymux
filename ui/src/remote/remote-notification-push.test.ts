import { describe, it, expect, vi, afterEach } from "vitest";
import {
  installRemotePushSettings,
  closeReadPushNotifications,
  createPushTargetNavigation,
} from "./remote-notification-push.js";

afterEach(() => vi.unstubAllGlobals());

function panel() {
  document.body.innerHTML = `<section id="pushSettings"><p id="pushStatus"></p>
  <input id="pushDetails" type="checkbox"><input data-push-category="waiting" type="checkbox" checked>
  <button id="pushEnable">Enable</button><button id="pushDisable">Disable</button></section>`;
  return document.getElementById("pushSettings")!;
}

describe("웹 푸시 설정", () => {
  it("복귀 클릭은 최신 목록을 받은 뒤 대상을 해석하고 일시 장애 때 ID를 보존한다", async () => {
    let notifications: Array<{ id: string }> = [];
    const open = vi.fn();
    const missing = vi.fn();
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error("resuming"))
      .mockImplementation(async () => {
        notifications = [{ id: "new" }];
      });
    const controller = createPushTargetNavigation({
      canNavigate: () => true,
      refresh,
      find: (id: string) => notifications.find((n) => n.id === id),
      open,
      missing,
    });
    controller.offer("new");
    await controller.consume();
    expect(missing).not.toHaveBeenCalled();
    await controller.consume();
    expect(open).toHaveBeenCalledWith({ id: "new" });
    expect(missing).not.toHaveBeenCalled();
  });
  it("허용 버튼의 사용자 동작에서만 권한을 요청하고 기본 상세 비공개로 구독한다", async () => {
    const permission = vi.fn().mockResolvedValue("granted");
    vi.stubGlobal("Notification", { permission: "default", requestPermission: permission });
    vi.stubGlobal("PushManager", class {});
    const subscription = {
      toJSON: () => ({ endpoint: "https://fcm.googleapis.com/test", keys: {} }),
    };
    const register = vi.fn().mockResolvedValue({
      active: {},
      pushManager: { getSubscription: vi.fn().mockResolvedValue(subscription) },
    });
    vi.stubGlobal("navigator", {
      serviceWorker: { getRegistration: vi.fn().mockResolvedValue(null), register },
    });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ available: true, publicKey: "AAAA", instanceId: "pc" }),
      })
      .mockResolvedValue({ ok: true });
    const controller = installRemotePushSettings(panel(), { isSecure: true, fetcher });
    await controller.ready;
    expect(permission).not.toHaveBeenCalled();
    document.getElementById("pushEnable")!.click();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(permission).toHaveBeenCalledOnce();
    expect(register).toHaveBeenCalledWith("/remote/push/sw.js", { scope: "/remote/push/" });
    const saved = JSON.parse(fetcher.mock.calls[1][1].body);
    expect(saved).toMatchObject({ kind: "web", categories: ["waiting"], includeDetails: false });
  });
  it("서버에 저장된 종류와 상세 표시 선택을 복원한다", async () => {
    vi.stubGlobal("Notification", { permission: "granted" });
    vi.stubGlobal("PushManager", class {});
    vi.stubGlobal("navigator", {
      serviceWorker: { getRegistration: vi.fn().mockResolvedValue(null) },
    });
    const root = panel();
    const controller = installRemotePushSettings(root, {
      isSecure: true,
      fetcher: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          available: true,
          enabled: true,
          includeDetails: true,
          categories: [],
          instanceId: "pc",
        }),
      }),
    });
    await controller.ready;
    expect((document.getElementById("pushDetails") as HTMLInputElement).checked).toBe(true);
    expect((root.querySelector("[data-push-category]") as HTMLInputElement).checked).toBe(false);
  });
  it("Cloud 미지원 상태는 권한을 요청하지 않고 이유를 표시한다", async () => {
    const permission = vi.fn();
    vi.stubGlobal("Notification", { permission: "default", requestPermission: permission });
    const controller = installRemotePushSettings(panel(), {
      fetcher: vi.fn().mockResolvedValue({ ok: false }),
      isSecure: true,
    });
    await controller.ready;
    expect(permission).not.toHaveBeenCalled();
    expect(document.getElementById("pushStatus")?.textContent).toContain("Cloud");
    expect((document.getElementById("pushEnable") as HTMLButtonElement).disabled).toBe(true);
  });

  it("읽음 동기화는 해당 PC의 표시된 알림만 닫고 새 푸시를 만들지 않는다", async () => {
    const close = vi.fn();
    const other = vi.fn();
    const registration = {
      getNotifications: vi.fn().mockResolvedValue([
        { data: { instanceId: "pc", notificationId: "read" }, close },
        { data: { instanceId: "other", notificationId: "read" }, close: other },
      ]),
    };
    await closeReadPushNotifications(registration, "pc", [{ id: "read", readAt: 1 }]);
    expect(close).toHaveBeenCalledOnce();
    expect(other).not.toHaveBeenCalled();
  });
});
