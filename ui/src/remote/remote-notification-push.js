// ADR-0344. Cloud cookie only; the desktop bearer token never crosses this boundary.
/* global window, navigator, localStorage, crypto, atob, Notification, setTimeout, clearTimeout */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEVICE_KEY = "laymux.push.deviceId";

export async function closeReadPushNotifications(registration, instanceId, notifications) {
  if (!registration) return;
  const states = new Map(notifications.map((n) => [n.id, n]));
  for (const notification of await registration.getNotifications()) {
    if (notification.data?.instanceId !== instanceId) continue;
    const current = states.get(notification.data.notificationId);
    if (!current || current.readAt != null || current.isRead === true) notification.close();
  }
}

function deviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!UUID.test(id || "")) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

function publicKey(value) {
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}

async function activeRegistration() {
  const registration = await navigator.serviceWorker.register("/remote/push/sw.js", { scope: "/remote/push/" });
  if (registration.active) return registration;
  const worker = registration.installing || registration.waiting;
  if (!worker) throw new Error("알림 서비스 초기화에 실패했습니다.");
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { worker.removeEventListener("statechange", changed); reject(new Error("알림 서비스 준비 시간이 초과됐습니다.")); }, 10000);
    function changed() {
      if (worker.state === "activated" || worker.state === "redundant") {
        clearTimeout(timer); worker.removeEventListener("statechange", changed);
        if (worker.state === "activated") resolve(); else reject(new Error("알림 서비스를 사용할 수 없습니다."));
      }
    }
    worker.addEventListener("statechange", changed);
    changed();
  });
  return registration;
}

export function installRemotePushSettings(root, options = {}) {
  const fetcher = options.fetcher || window.fetch.bind(window);
  const status = root.querySelector("#pushStatus");
  const enable = root.querySelector("#pushEnable");
  const disable = root.querySelector("#pushDisable");
  const details = root.querySelector("#pushDetails");
  let config = null;
  let registration = null;
  enable.disabled = true;
  disable.disabled = true;
  const ready = (async () => {
    if (options.android) {
      status.textContent = "앱 알림은 Cloud 대시보드의 PC 메뉴 → 휴대전화 알림에서 설정합니다.";
      return;
    }
    try {
      if (!(options.isSecure ?? window.isSecureContext) || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window))
        throw new Error("HTTPS Cloud 접속이 필요합니다. iPhone은 홈 화면에 추가한 웹앱에서 알림을 허용해주세요.");
      const response = await fetcher(`/remote/push/config?deviceId=${deviceId()}`, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error("Cloud 연결에서 브라우저 알림을 설정할 수 있습니다.");
      config = await response.json();
      details.checked = config.includeDetails === true;
      if (Array.isArray(config.categories)) for (const input of root.querySelectorAll("[data-push-category]")) input.checked = config.categories.includes(input.dataset.pushCategory);
      if (!config.available) throw new Error("Cloud 서버에 알림 서비스가 아직 설정되지 않았습니다.");
      registration = await navigator.serviceWorker.getRegistration("/remote/push/");
      enable.disabled = false;
      disable.disabled = !config.enabled;
      status.textContent = Notification.permission === "denied" ? "브라우저 설정에서 알림 권한을 허용해주세요." : "이 브라우저와 이 PC의 알림을 설정합니다. 앱 알림과 별도로 수신합니다.";
    } catch (error) { status.textContent = error.message; }
  })();
  enable.addEventListener("click", async () => {
    if (!config) return;
    enable.disabled = true;
    try {
      // iOS permission needs the original user gesture, before network I/O.
      const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      if (permission !== "granted") throw new Error("브라우저 설정에서 알림 권한을 허용해주세요.");
      registration = await activeRegistration();
      const subscription = await registration.pushManager.getSubscription() || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey(config.publicKey) });
      const categories = [...root.querySelectorAll("[data-push-category]:checked")].map((el) => el.dataset.pushCategory);
      const response = await fetcher("/remote/push/subscription", {
        method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: deviceId(), instanceId: config.instanceId, kind: "web", subscription: subscription.toJSON(), categories, includeDetails: details.checked }),
      });
      if (!response.ok) throw new Error("알림 설정을 저장하지 못했습니다. 다시 시도해주세요.");
      status.textContent = "이 브라우저에서 이 PC의 알림을 받습니다.";
      disable.disabled = false;
    } catch (error) { status.textContent = error.message; }
    finally { enable.disabled = false; }
  });
  disable.addEventListener("click", async () => {
    disable.disabled = true;
    try {
      const response = await fetcher(`/remote/push/subscription?deviceId=${deviceId()}`, { method: "DELETE", credentials: "same-origin" });
      if (!response.ok) throw new Error("알림 중지를 저장하지 못했습니다.");
      status.textContent = "이 PC의 브라우저 알림을 중지했습니다.";
      // Keep the registration for this browser's other PC subscriptions.
      for (const n of await registration?.getNotifications() || []) if (n.data?.instanceId === config.instanceId) n.close();
    } catch (error) { status.textContent = error.message; disable.disabled = false; }
  });
  return { ready, sync: (notifications) => closeReadPushNotifications(registration, config?.instanceId, notifications).catch(() => {}) };
}
