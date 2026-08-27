import { expect, test, type Page } from "@playwright/test";

import { installRemoteClientRoutes } from "./remote-client-assets";

const DISPLAY_SETTINGS_KEY = "laymux.remote.displaySettings";

const deviceSettings = {
  terminalFontSize: 19,
  composerFontSize: 26,
  menuFontSize: 17,
  composerIdleOpacity: 45,
  composerFocusedOpacity: 75,
  composerActiveOpacity: 95,
  snapshotMaxKib: 64,
  scrollSensitivity: 2.5,
  fastScrollSensitivity: 8,
  touchScrollSensitivity: 1.5,
  twoFingerScrollSensitivity: 6,
};

const workspacePane = {
  id: "pane-1",
  location: "workspace",
  workspaceId: "ws-1",
  paneIndex: 0,
  paneNumber: 1,
  viewType: "terminal",
  terminalId: "terminal-1",
  terminalLive: true,
  title: "Shell",
  profile: "PowerShell",
  cwd: "C:\\work",
  activity: { type: "shell" },
  outputActive: false,
  commandRunning: true,
  isFocused: true,
  unreadCount: 0,
  hidden: false,
  collapsed: false,
  x: 0,
  y: 0,
  w: 1,
  h: 1,
};

const navigation = {
  activeWorkspace: { id: "ws-1", name: "Main", panes: [workspacePane] },
  workspaces: [
    {
      id: "ws-1",
      name: "Main",
      isActive: true,
      hidden: false,
      collapsed: false,
      paneCount: 1,
      terminalPaneCount: 1,
      liveTerminalCount: 1,
      unreadCount: 0,
      panes: [workspacePane],
    },
  ],
  docks: [],
  terminals: [
    {
      id: "terminal-1",
      title: "Shell",
      profile: "PowerShell",
      cwd: "C:\\work",
      workspaceId: "ws-1",
      paneNumber: 1,
      appearance: {
        fontFamily: "'Cascadia Mono', 'Consolas', monospace",
        cursorStyle: "bar",
        cursorWidth: 1,
        theme: {},
      },
    },
  ],
  workspaceSelector: { display: {}, pathEllipsis: "start" },
  notifications: [],
  unreadNotificationCount: 0,
};

type TermWindow = typeof window & {
  Terminal: { prototype: { reset: () => void } };
  __remoteTerm?: {
    options: { fontSize: number; scrollSensitivity: number; fastScrollSensitivity: number };
  };
};

function snapshotFrames(text: string) {
  const payload = Buffer.from(text, "utf8");
  return {
    header: JSON.stringify({
      type: "terminal.output",
      version: 1,
      phase: "snapshot",
      seqStart: 0,
      seqEnd: payload.byteLength,
      byteLength: payload.byteLength,
      state: {
        version: 1,
        generation: 1,
        snapshotStartSeq: 0,
        snapshotSeq: payload.byteLength,
        sourceStartSeq: 0,
        sourceSeq: payload.byteLength,
        snapshotKind: "raw",
        protocolRevision: 0,
        modes: { bracketedPaste: false },
        geometry: { revision: 0, cols: 80, rows: 24 },
      },
    }),
    payload,
  };
}

async function installApiMocks(
  page: Page,
  displayRequests: string[],
  outputUrls: string[] = [],
  outputClosers: Array<() => void> = [],
) {
  await installRemoteClientRoutes(page);
  await page.route("http://remote.test/remote/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/remote/v1/display-settings") {
      displayRequests.push(route.request().method());
      await route.fulfill({ status: 404, json: { error: "removed" } });
      return;
    }
    if (url.pathname === "/remote/v1/session/claim") {
      await route.fulfill({
        json: { active: true, leaseId: "lease-1", heartbeatTimeoutSeconds: 45 },
      });
      return;
    }
    if (url.pathname === "/remote/v1/session/heartbeat") {
      await route.fulfill({ json: { active: true, leaseId: "lease-1" } });
      return;
    }
    if (url.pathname === "/remote/v1/navigation") {
      await route.fulfill({ json: navigation });
      return;
    }
    await route.fulfill({ json: {} });
  });
  await page.routeWebSocket(/\/remote\/v1\/terminals\/terminal-1\/output/, (socket) => {
    outputUrls.push(socket.url());
    outputClosers.push(() => socket.close());
    const snapshot = snapshotFrames("ready\r\n");
    socket.send(snapshot.header);
    socket.send(snapshot.payload);
  });
}

async function openDeviceSettings(page: Page) {
  await page.locator("#navToggle").click();
  await page.locator("#drawerSettingsButton").evaluate((button) => button.click());
  await expect(page.locator("#remoteTerminalFontSize")).toBeEnabled();
}

test("원격 화면 설정은 연결 전부터 기기 localStorage에서 읽고 저장한다", async ({ page }) => {
  const displayRequests: string[] = [];
  await installApiMocks(page, displayRequests);
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: DISPLAY_SETTINGS_KEY,
    value: deviceSettings,
  });

  await page.goto("http://remote.test/remote/");
  await openDeviceSettings(page);

  await expect(page.locator("#remoteTerminalFontSize")).toHaveValue("19");
  await expect(page.locator("#remoteComposerFontSize")).toHaveValue("26");
  await expect(page.locator("#remoteMenuFontSize")).toHaveValue("17");
  await expect(page.locator("#remoteSnapshotMaxKib")).toHaveValue("64");
  await expect(page.locator("#remoteScrollSensitivity")).toHaveValue("2.5");
  await expect(page.locator("#remoteFastScrollSensitivity")).toHaveValue("8");
  await expect(page.locator("#remoteTouchScrollSensitivity")).toHaveValue("1.5");
  await expect(page.locator("#remoteTwoFingerScrollSensitivity")).toHaveValue("6");
  await expect(page.locator("#remoteDisplaySettingsStatus")).toHaveText("Saved on this device.");

  await page.locator("#remoteTerminalFontSize").fill("22");
  await page.locator("#remoteTerminalFontSize").blur();
  await expect
    .poll(() =>
      page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "null"), DISPLAY_SETTINGS_KEY),
    )
    .toMatchObject({ ...deviceSettings, terminalFontSize: 22 });
  expect(displayRequests).toEqual([]);

  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--remote-composer-font-size"),
      ),
    )
    .toBe("26px");
});

test("기기의 terminal 옵션과 checkpoint 예산을 최초 attach에 적용한다", async ({ page }) => {
  const displayRequests: string[] = [];
  const outputUrls: string[] = [];
  await installApiMocks(page, displayRequests, outputUrls);
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: DISPLAY_SETTINGS_KEY,
    value: deviceSettings,
  });

  await page.goto("http://remote.test/remote/#token=test-token");
  await page.evaluate(() => {
    const target = window as TermWindow;
    const originalReset = target.Terminal.prototype.reset;
    target.Terminal.prototype.reset = function resetCapturingInstance() {
      (window as TermWindow).__remoteTerm = this as never;
      return originalReset.call(this);
    };
  });
  await page.locator("#connect").click();

  await expect.poll(() => outputUrls.length).toBeGreaterThan(0);
  expect(new URL(outputUrls[0]).searchParams.get("historyKib")).toBe("64");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const options = (window as TermWindow).__remoteTerm?.options;
        return options
          ? [options.fontSize, options.scrollSensitivity, options.fastScrollSensitivity]
          : null;
      }),
    )
    .toEqual([19, 2.5, 8]);
  await expect(page.locator("#terminal .xterm")).toBeVisible();
  expect(displayRequests).toEqual([]);
});

test("실행 중 바꾼 checkpoint 예산은 다음 자동 attach부터 적용한다", async ({ page }) => {
  const displayRequests: string[] = [];
  const outputUrls: string[] = [];
  const outputClosers: Array<() => void> = [];
  await installApiMocks(page, displayRequests, outputUrls, outputClosers);

  await page.goto("http://remote.test/remote/#token=test-token");
  await page.locator("#connect").click();

  await expect.poll(() => outputUrls.length).toBe(1);
  expect(new URL(outputUrls[0]).searchParams.get("historyKib")).toBe("4");

  await page.locator("#remoteSnapshotMaxKib").evaluate((input) => {
    const numberInput = input as HTMLInputElement;
    numberInput.value = "64";
    numberInput.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect
    .poll(() =>
      page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "null"), DISPLAY_SETTINGS_KEY),
    )
    .toMatchObject({ snapshotMaxKib: 64 });

  outputClosers[0]();

  await expect.poll(() => outputUrls.length).toBe(2);
  expect(new URL(outputUrls[1]).searchParams.get("historyKib")).toBe("64");
  expect(displayRequests).toEqual([]);
});

test("디바이스 저장 실패 상태는 연결 전환 뒤에도 유지한다", async ({ page }) => {
  const displayRequests: string[] = [];
  await installApiMocks(page, displayRequests);
  await page.addInitScript((displaySettingsKey) => {
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(key, value) {
      if (key === displaySettingsKey) throw new DOMException("storage blocked", "QuotaExceededError");
      return originalSetItem.call(this, key, value);
    };
  }, DISPLAY_SETTINGS_KEY);

  await page.goto("http://remote.test/remote/#token=test-token");
  await page.locator("#remoteTerminalFontSize").evaluate((input) => {
    const numberInput = input as HTMLInputElement;
    numberInput.value = "22";
    numberInput.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.locator("#remoteDisplaySettingsStatus")).toHaveText(
    "Could not save on this device.",
  );

  await page.locator("#connect").click();

  await expect(page.locator(".connection-panel")).toHaveClass(/connected/);

  await expect(page.locator("#remoteDisplaySettingsStatus")).toHaveText(
    "Could not save on this device.",
  );
  expect(displayRequests).toEqual([]);
});
