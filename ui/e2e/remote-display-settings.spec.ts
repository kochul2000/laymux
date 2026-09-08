import { expect, test, type Page } from "@playwright/test";

import { installRemoteClientRoutes } from "./remote-client-assets";

const DISPLAY_SETTINGS_KEY = "laymux.remote.displaySettings";

const deviceSettings = {
  terminalFontSize: 19,
  composerFontSize: 26,
  menuFontSize: 17,
  mainButtonScale: 120,
  keysButtonScale: 90,
  navigationPinned: false,
  navigationWidth: 300,
  navigationPinCutoff: 720,
  composerIdleOpacity: 45,
  composerFocusedOpacity: 75,
  composerActiveOpacity: 95,
  snapshotMaxKib: 64,
  scrollSensitivity: 2.5,
  fastScrollSensitivity: 8,
  touchScrollSensitivity: 1.5,
  twoFingerScrollSensitivity: 6,
  selectionHandleSize: 24,
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
  // Settings is paginated; the display preferences live on their own tab.
  await page
    .locator('#settingsTabs [data-settings-panel="display"]')
    .evaluate((tab: HTMLElement) => tab.click());
  await expect(page.locator("#remoteTerminalFontSize")).toBeEnabled();
}

test("MCP heartbeat 변경은 기기 저장·화면 적용 뒤 확인 응답을 보낸다", async ({ page }) => {
  await installApiMocks(page, []);
  let sent = false;
  let acknowledgement: { success: boolean } | undefined;
  let savedReport: Record<string, unknown> | undefined;
  await page.route("http://remote.test/remote/v1/session/heartbeat", async (route) => {
    const body = route.request().postDataJSON();
    const device = body.deviceSettings;
    savedReport = device.settings;
    if (device.result) acknowledgement = device.result;
    const command = !sent
      ? {
          requestId: "test-change",
          clientId: device.clientId,
          leaseId: body.leaseId,
          expectedRevision: device.revision,
          validForMs: 10000,
          patch: {
            terminalFontSize: 20,
            composerFontSize: 19,
            menuFontSize: 17,
            touchScrollSensitivity: 2,
            composerAutocomplete: false,
            composerHiddenClaudeLines: 5,
            inputBarUserKeys: [{ id: "u-test", label: "확인", seq: "\t" }],
            floatingButtons: [
              {
                id: "f-test",
                actionId: "soft:u-test",
                enabled: true,
                size: 64,
                opacity: 0.5,
                x: 0.5,
                y: 0.5,
              },
            ],
          },
        }
      : null;
    sent = true;
    await route.fulfill({
      json: { active: true, leaseId: body.leaseId, deviceSettingsCommand: command },
    });
  });
  await page.goto("http://remote.test/remote/#token=test-token");
  await page.locator("#connect").click();
  await expect.poll(() => acknowledgement, { timeout: 15000 }).toMatchObject({ success: true });
  expect(savedReport).toMatchObject({
    terminalFontSize: 20,
    touchScrollSensitivity: 2,
    composerAutocomplete: false,
  });
  expect(savedReport).not.toHaveProperty("authToken");
  expect(savedReport).not.toHaveProperty("composerHistory");
  expect(savedReport).toMatchObject({
    composerHiddenClaudeLines: 5,
    inputBarUserKeys: [{ id: "u-test", label: "확인", seq: "\t" }],
  });
  await expect(page.locator('#floatingControls [data-floating-id="f-test"]')).toHaveCSS(
    "opacity",
    "0.5",
  );
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("laymux.remote.composerHiddenAgentInputLines") || "{}"),
    ),
  ).toMatchObject({ Claude: 5, Codex: 4, Grok: 2 });
  await expect(page.locator("#remoteTerminalFontSize")).toHaveValue("20");
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--remote-menu-font-size"),
    ),
  ).toBe("17px");
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) || "{}"),
      DISPLAY_SETTINGS_KEY,
    ),
  ).toMatchObject({ terminalFontSize: 20, touchScrollSensitivity: 2 });
  expect(
    await page.evaluate(() => localStorage.getItem("laymux.remote.composerAutocomplete")),
  ).toBe("0");
});

test("MCP 플로팅 전체 표시를 껐다 켜도 개별 배치와 버튼은 보존한다", async ({ page }) => {
  await installApiMocks(page, []);
  await page.addInitScript(() =>
    localStorage.setItem(
      "laymux.remote.keybar",
      JSON.stringify({
        floating: {
          pads: { dpad: { enabled: true, x: 0.3, size: 72 } },
          buttons: [{ id: "f-keys", actionId: "keys", enabled: true }],
        },
      }),
    ),
  );
  let pending: Record<string, unknown> | null = null;
  let ack: { requestId: string; success: boolean } | undefined;
  let serial = 0;
  await page.route("http://remote.test/remote/v1/session/heartbeat", async (route) => {
    const { deviceSettings: device, leaseId } = route.request().postDataJSON();
    ack = device.result;
    const command = pending
      ? {
          requestId: String(++serial),
          clientId: device.clientId,
          leaseId,
          expectedRevision: device.revision,
          validForMs: 10000,
          patch: pending,
        }
      : null;
    pending = null;
    await route.fulfill({ json: { active: true, leaseId, deviceSettingsCommand: command } });
  });
  await page.goto("http://remote.test/remote/#token=test-token");
  await page.locator("#connect").click();
  await expect(page.locator("#floatingControls > *")).toHaveCount(2);
  for (const [patch, count] of [
    [{ floatingEnabled: false }, 0],
    [{ floatingEnabled: true, floatingNavPadEnabled: true, floatingNavPadSize: 80 }, 3],
    [{ floatingDpadEnabled: false }, 2],
  ] as const) {
    const requestId = String(serial + 1);
    pending = patch;
    await expect.poll(() => ack, { timeout: 15000 }).toMatchObject({ requestId, success: true });
    await expect(page.locator("#floatingControls > *")).toHaveCount(count);
    expect(
      await page.evaluate(() => JSON.parse(localStorage.getItem("laymux.remote.keybar") || "{}")),
    ).toMatchObject({
      floating: {
        pads: { dpad: { x: 0.3, size: 72 } },
        buttons: [{ id: "f-keys", actionId: "keys", enabled: true }],
      },
    });
  }
});

test("MCP 저장 실패는 기존 기기 값과 실패 응답을 유지한다", async ({ page }) => {
  await installApiMocks(page, []);
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "laymux.remote.displaySettings") throw new Error("storage unavailable");
      return original.call(this, key, value);
    };
  });
  let sent = false;
  let acknowledgement: { success: boolean } | undefined;
  await page.route("http://remote.test/remote/v1/session/heartbeat", async (route) => {
    const { deviceSettings: device, leaseId } = route.request().postDataJSON();
    if (device.result) acknowledgement = device.result;
    const command = !sent
      ? {
          requestId: "storage-error",
          clientId: device.clientId,
          leaseId,
          expectedRevision: device.revision,
          validForMs: 10000,
          patch: { terminalFontSize: 20, floatingDpadEnabled: true, composerHiddenClaudeLines: 5 },
        }
      : null;
    sent = true;
    await route.fulfill({ json: { active: true, leaseId, deviceSettingsCommand: command } });
  });
  await page.goto("http://remote.test/remote/#token=test-token");
  await page.locator("#connect").click();
  await expect.poll(() => acknowledgement, { timeout: 15000 }).toMatchObject({ success: false });
  await expect(page.locator("#remoteTerminalFontSize")).toHaveValue("14");
  await expect(page.locator("#floatingControls > *")).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("laymux.remote.keybar"))).toBeNull();
});

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
  await expect(page.locator("#remoteNavigationPinned")).not.toBeChecked();
  await expect(page.locator("#remoteNavigationWidth")).toHaveValue("300");
  await expect(page.locator("#remoteNavigationPinCutoff")).toHaveValue("720");
  await expect(page.locator("#remoteSnapshotMaxKib")).toHaveValue("64");
  await expect(page.locator("#remoteScrollSensitivity")).toHaveValue("2.5");
  await expect(page.locator("#remoteFastScrollSensitivity")).toHaveValue("8");
  await expect(page.locator("#remoteTouchScrollSensitivity")).toHaveValue("1.5");
  await expect(page.locator("#remoteTwoFingerScrollSensitivity")).toHaveValue("6");
  await expect(page.locator("#remoteSelectionHandleSize")).toHaveValue("24");
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

  await page.locator("#remoteSelectionHandleSize").fill("28");
  await page.locator("#remoteSelectionHandleSize").blur();
  await expect
    .poll(() =>
      page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "null"), DISPLAY_SETTINGS_KEY),
    )
    .toMatchObject({ ...deviceSettings, terminalFontSize: 22, selectionHandleSize: 28 });
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue(
          "--touch-selection-handle-size",
        ),
      ),
    )
    .toBe("28px");
});

test("워크스페이스 메뉴는 너비를 공유하고 컷오프보다 넓을 때만 고정된다", async ({ page }) => {
  const displayRequests: string[] = [];
  await installApiMocks(page, displayRequests);
  await page.setViewportSize({ width: 900, height: 800 });
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: DISPLAY_SETTINGS_KEY,
    value: { ...deviceSettings, navigationPinned: true },
  });

  await page.goto("http://remote.test/remote/");

  await expect(page.locator(".app")).toHaveClass(/nav-pinned/);
  await expect(page.locator("#navigationPanel")).toHaveCSS("width", "300px");
  await expect(page.locator("#navScrim")).toBeHidden();
  expect(
    await page.evaluate(() => {
      const remoteUi = (
        window as typeof window & {
          laymuxRemoteUi: { dismissTopLayer: () => boolean };
        }
      ).laymuxRemoteUi;
      return [remoteUi.dismissTopLayer(), remoteUi.dismissTopLayer()];
    }),
  ).toEqual([true, false]);

  await page.setViewportSize({ width: 720, height: 800 });
  await expect(page.locator(".app")).not.toHaveClass(/nav-pinned/);
  await expect(page.locator("#navigationPanel")).toHaveCSS("width", "300px");

  await page.setViewportSize({ width: 721, height: 800 });
  await expect(page.locator(".app")).toHaveClass(/nav-pinned/);

  await page.locator("#drawerSettingsButton").evaluate((button) => button.click());
  await page
    .locator('#settingsTabs [data-settings-panel="display"]')
    .evaluate((tab: HTMLElement) => tab.click());
  await page.locator("#remoteNavigationWidth").fill("280");
  await page.locator("#remoteNavigationWidth").blur();
  await expect(page.locator("#navigationPanel")).toHaveCSS("width", "280px");

  await page.locator("#remoteNavigationPinCutoff").fill("800");
  await page.locator("#remoteNavigationPinCutoff").blur();
  await expect(page.locator(".app")).not.toHaveClass(/nav-pinned/);
  await page.locator("#remoteNavigationPinCutoff").fill("720");
  await page.locator("#remoteNavigationPinCutoff").blur();
  await expect(page.locator(".app")).toHaveClass(/nav-pinned/);

  await page.locator("#remoteNavigationPinned").uncheck();
  await expect(page.locator(".app")).not.toHaveClass(/nav-pinned/);
  await expect(page.locator("#navigationPanel")).toHaveCSS("width", "280px");
  await expect
    .poll(() =>
      page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "null"), DISPLAY_SETTINGS_KEY),
    )
    .toMatchObject({
      navigationPinned: false,
      navigationWidth: 280,
      navigationPinCutoff: 720,
    });
  expect(displayRequests).toEqual([]);
});

test("메뉴 도구 줄의 핀 아이콘은 설정과 같은 워크스페이스 메뉴 고정 값을 토글한다", async ({
  page,
}) => {
  const displayRequests: string[] = [];
  await installApiMocks(page, displayRequests);
  await page.setViewportSize({ width: 900, height: 800 });
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: DISPLAY_SETTINGS_KEY,
    value: deviceSettings,
  });

  await page.goto("http://remote.test/remote/");

  await page.locator("#token").fill("test-token");
  await page.locator("#connect").click();
  await page.locator("#navToggle").click();
  const pin = page.locator(".drawer-header > #navigationPin");
  await expect(page.locator("header #navigationPin")).toHaveCount(0);
  await expect(pin).toBeVisible();
  const pinBox = await pin.boundingBox();
  const plusBox = await page.locator("#newWorkspace").boundingBox();
  expect(pinBox!.y).toBe(plusBox!.y);
  const titleBox = await page.locator("#drawerTitle").boundingBox();
  expect(pinBox!.x + pinBox!.width).toBeLessThanOrEqual(titleBox!.x);
  await expect(pin.locator('svg[data-remote-icon-name="Pin"]')).toHaveCount(1);
  await expect(pin).toHaveAttribute("aria-pressed", "false");
  await expect(pin).toHaveAttribute("aria-label", "Pin workspace menu");

  await pin.click();
  await expect(page.locator(".app")).toHaveClass(/nav-pinned/);
  await expect(pin).toHaveAttribute("aria-pressed", "true");
  await expect(pin).toHaveAttribute("aria-label", "Unpin workspace menu");
  await expect(page.locator("#remoteNavigationPinned")).toBeChecked();
  await page.screenshot({ path: "../.screenshots/remote-pin-toolbar-wide.png" });
  await expect
    .poll(() =>
      page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "null"), DISPLAY_SETTINGS_KEY),
    )
    .toMatchObject({ navigationPinned: true });

  await pin.click();
  await expect(page.locator(".app")).not.toHaveClass(/nav-pinned/);
  await expect(pin).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#remoteNavigationPinned")).not.toBeChecked();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(pin).toBeVisible();
  await page.screenshot({ path: "../.screenshots/remote-pin-toolbar-mobile.png" });
  await expect(page.locator(".drawer-header #drawerConnectionButton")).toHaveCount(0);
  await page.locator("#drawerSettingsButton").click();
  await expect(page.locator("#drawerSettingsView #drawerConnectionButton")).toBeVisible();
  await page.screenshot({ path: "../.screenshots/remote-connection-settings-mobile.png" });
  await page.locator("#drawerConnectionButton").click();
  await expect(page.locator("#drawerConnectionView")).toBeVisible();
  await page.locator("#drawerBack").click();
  await expect(page.locator("#drawerSettingsButton")).toBeFocused();
  expect(displayRequests).toEqual([]);
});

test("잘못된 워크스페이스 메뉴 숫자 설정은 안전한 기본값으로 복구한다", async ({ page }) => {
  const displayRequests: string[] = [];
  await installApiMocks(page, displayRequests);
  await page.setViewportSize({ width: 500, height: 800 });
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: DISPLAY_SETTINGS_KEY,
    value: {
      ...deviceSettings,
      navigationPinned: true,
      navigationWidth: null,
      navigationPinCutoff: false,
    },
  });

  await page.goto("http://remote.test/remote/");
  await expect(page.locator(".app")).not.toHaveClass(/nav-pinned/);
  await page.locator("#drawerSettingsButton").evaluate((button) => button.click());
  await page
    .locator('#settingsTabs [data-settings-panel="display"]')
    .evaluate((tab: HTMLElement) => tab.click());

  await expect(page.locator("#remoteNavigationWidth")).toHaveValue("360");
  await expect(page.locator("#remoteNavigationPinCutoff")).toHaveValue("720");
  await page.locator("#remoteNavigationWidth").fill("");
  await page.locator("#remoteNavigationWidth").blur();
  await expect
    .poll(() =>
      page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "null"), DISPLAY_SETTINGS_KEY),
    )
    .toMatchObject({ navigationWidth: 360, navigationPinCutoff: 720 });
  expect(displayRequests).toEqual([]);
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
      if (key === displaySettingsKey)
        throw new DOMException("storage blocked", "QuotaExceededError");
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

test("버튼 크기는 기존 terminal crop을 유지하고 모바일·가로 화면 안에서 스크롤한다", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const requests: string[] = [];
  await installApiMocks(page, requests);
  await page.goto("http://remote.test/remote/#token=test-token");
  await page.locator("#connect").click();
  await expect(page.locator("#terminal .xterm-rows")).toBeVisible();
  const rowCount = () => page.locator("#terminal .xterm-rows > div").count();
  await expect.poll(rowCount).toBeGreaterThan(5);
  const before = await rowCount();
  const hostHeight = await page.locator("#terminal").evaluate((host) => host.clientHeight);
  await page.locator("#keyBarToggle").click();
  await page.locator("#navToggle").click();
  await page.locator("#drawerSettingsButton").click();
  for (const row of ["Main", "Keys"]) {
    for (let i = 0; i < 6; i++) {
      await page.getByRole("button", { name: `Increase ${row} button size`, exact: true }).click();
    }
  }
  await page.screenshot({ path: testInfo.outputPath("button-size-settings.png") });
  for (const control of await page.locator(".button-size-controls").all()) {
    const centres = await control.locator("button, output").evaluateAll((items) =>
      items.map((item) => {
        const box = item.getBoundingClientRect();
        return box.top + box.height / 2;
      }),
    );
    expect(Math.max(...centres) - Math.min(...centres)).toBeLessThan(1);
  }
  await page.locator("#drawerBack").click();
  if ((await page.locator("#navToggle").getAttribute("aria-expanded")) === "true") {
    await page.locator("#navToggle").click();
  }
  // ADR-0038: height-only shrink crops the normal buffer without resizing PTY rows.
  await expect
    .poll(() => page.locator("#terminal").evaluate((host) => host.clientHeight))
    .toBeLessThan(hostHeight);
  expect(await rowCount()).toBe(before);
  for (const width of [390, 844]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 390 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    for (const id of ["mainActionRow", "keyRow"]) {
      const sizes = await page.locator(`#${id}`).evaluate((row) => {
        row.scrollLeft = row.scrollWidth;
        return { scroll: row.scrollLeft, width: row.clientWidth, content: row.scrollWidth };
      });
      if (sizes.content > sizes.width) expect(sizes.scroll).toBeGreaterThan(0);
    }
    await page.screenshot({ path: testInfo.outputPath(`button-size-${width}.png`) });
  }
  await expect.poll(rowCount).toBeLessThan(before);
  expect(requests).toEqual([]);
});

test("잘못된 버튼 배율을 정규화하고 저장 실패에도 현재 화면은 적용한다", async ({ page }) => {
  await installApiMocks(page, []);
  await page.addInitScript(() => {
    localStorage.setItem(
      "laymux.remote.displaySettings",
      JSON.stringify({ mainButtonScale: 999, keysButtonScale: null }),
    );
    Storage.prototype.setItem = () => {
      throw new DOMException("blocked", "QuotaExceededError");
    };
  });
  await page.goto("http://remote.test/remote/");
  await page.locator("#drawerSettingsButton").click();
  await expect(page.locator("#remoteMainButtonScale")).toHaveText("160%");
  await expect(page.locator("#remoteKeysButtonScale")).toHaveText("100%");
  await page.getByRole("button", { name: "Decrease Main button size", exact: true }).click();
  await expect(page.locator("#remoteMainButtonScale")).toHaveText("150%");
  await expect(page.locator("#remoteButtonSizeStatus")).toHaveText(
    "Could not save on this device.",
  );
  expect(
    await page
      .locator("#mainActionRow")
      .evaluate((row) => getComputedStyle(row).getPropertyValue("--input-button-scale").trim()),
  ).toBe("1.5");
});
