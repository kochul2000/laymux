import { expect, test, type Page } from "@playwright/test";

import { installRemoteClientRoutes } from "./remote-client-assets";

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
  branch: "main",
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
  activeWorkspace: {
    id: "ws-1",
    name: "Main",
    panes: [workspacePane],
  },
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
        fontSize: 14,
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

interface DisplaySettings {
  terminalFontSize: number;
  composerFontSize: number;
  menuFontSize: number;
  composerIdleOpacity: number;
  composerFocusedOpacity: number;
  composerActiveOpacity: number;
  touchScrollSensitivity: number;
  twoFingerScrollSensitivity: number;
  revision: string;
}

type DisplaySettingsPut = Omit<DisplaySettings, "revision"> & {
  leaseId: string;
  expectedRevision: string;
};

interface DisplaySettingsHarness {
  settings: DisplaySettings;
  claimLeaseIds: string[];
  claimRequests: number;
  getRequests: number;
  putBodies: DisplaySettingsPut[];
  delayNextPut: boolean;
  releasePut: (() => void) | null;
  delayNextInput?: boolean;
  releaseInput?: (() => void) | null;
}

interface RemoteMockOptions {
  activity?: { type: string; name?: string };
  snapshotText?: string;
}

function snapshotFrames(text: string) {
  const payload = Buffer.from(text, "utf8");
  const header = JSON.stringify({
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
  });
  return { header, payload };
}

async function installRemoteMocks(
  page: Page,
  harness: DisplaySettingsHarness,
  options: RemoteMockOptions = {},
) {
  const pane = { ...workspacePane, activity: options.activity ?? workspacePane.activity };
  const navigationResponse = {
    ...navigation,
    activeWorkspace: { ...navigation.activeWorkspace, panes: [pane] },
    workspaces: navigation.workspaces.map((workspace) => ({ ...workspace, panes: [pane] })),
  };
  await installRemoteClientRoutes(page);
  await page.route("http://remote.test/remote/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/remote/v1/session/claim") {
      const leaseId =
        harness.claimLeaseIds[Math.min(harness.claimRequests, harness.claimLeaseIds.length - 1)];
      harness.claimRequests += 1;
      await route.fulfill({
        json: { active: true, leaseId, heartbeatTimeoutSeconds: 45 },
      });
      return;
    }
    if (url.pathname === "/remote/v1/session/heartbeat") {
      await route.fulfill({ json: { active: true, leaseId: "lease-1" } });
      return;
    }
    if (url.pathname === "/remote/v1/navigation") {
      await route.fulfill({ json: navigationResponse });
      return;
    }
    if (url.pathname === "/remote/v1/display-settings") {
      if (route.request().method() === "GET") {
        harness.getRequests += 1;
        await route.fulfill({ json: harness.settings });
        return;
      }

      const contentType = route.request().headers()["content-type"];
      if (contentType !== "application/json") {
        await route.fulfill({
          status: 415,
          contentType: "text/plain",
          body: "Expected request with `Content-Type: application/json`",
        });
        return;
      }

      const body = route.request().postDataJSON() as DisplaySettingsPut;
      harness.putBodies.push(body);
      if (harness.delayNextPut) {
        harness.delayNextPut = false;
        await new Promise<void>((resolve) => {
          harness.releasePut = resolve;
        });
      }
      if (body.expectedRevision !== harness.settings.revision) {
        await route.fulfill({
          status: 409,
          json: { error: "Settings revision conflict" },
        });
        return;
      }
      const revisionNumber = Number(harness.settings.revision.replace(/^rev-/, "")) || 0;
      harness.settings = {
        terminalFontSize: body.terminalFontSize,
        composerFontSize: body.composerFontSize,
        menuFontSize: body.menuFontSize,
        composerIdleOpacity: body.composerIdleOpacity,
        composerFocusedOpacity: body.composerFocusedOpacity,
        composerActiveOpacity: body.composerActiveOpacity,
        touchScrollSensitivity: body.touchScrollSensitivity,
        twoFingerScrollSensitivity: body.twoFingerScrollSensitivity,
        revision: `rev-${revisionNumber + 1}`,
      };
      await route.fulfill({ json: harness.settings });
      return;
    }
    if (url.pathname === "/remote/v1/terminals/terminal-1/input") {
      if (harness.delayNextInput) {
        harness.delayNextInput = false;
        await new Promise<void>((resolve) => {
          harness.releaseInput = resolve;
        });
      }
      await route.fulfill({ json: {} });
      return;
    }
    await route.fulfill({ json: {} });
  });

  await page.routeWebSocket(/\/remote\/v1\/terminals\/terminal-1\/output/, (socket) => {
    const snapshot = snapshotFrames(options.snapshotText ?? "ready\r\n");
    socket.send(snapshot.header);
    socket.send(snapshot.payload);
  });
}

type TermWindow = typeof window & {
  Terminal: { prototype: { reset: () => void } };
  __remoteTerm?: {
    options: { fontSize: number };
    buffer: { active: { baseY: number; viewportY: number } };
  };
};

async function connectAndOpenDisplaySettings(page: Page) {
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
  await page.locator("#navToggle").click();
  await page.locator("#drawerSettingsButton").click();
  await expect(page.locator("#remoteTerminalFontSize")).toBeEnabled();
}

test("PC 소유 표시 크기를 조회·저장하고 현재 Remote surface에 즉시 적용한다", async ({ page }) => {
  const harness: DisplaySettingsHarness = {
    settings: {
      terminalFontSize: 18,
      composerFontSize: 20,
      menuFontSize: 15,
      composerIdleOpacity: 55,
      composerFocusedOpacity: 80,
      composerActiveOpacity: 100,
      touchScrollSensitivity: 1,
      twoFingerScrollSensitivity: 5,
      revision: "rev-1",
    },
    claimLeaseIds: ["lease-1"],
    claimRequests: 0,
    getRequests: 0,
    putBodies: [],
    delayNextPut: false,
    releasePut: null,
  };
  await installRemoteMocks(page, harness);
  await connectAndOpenDisplaySettings(page);

  await expect(page.locator("#remoteTerminalFontSize")).toHaveValue("18");
  await expect(page.locator("#remoteComposerFontSize")).toHaveValue("20");
  await expect(page.locator("#remoteMenuFontSize")).toHaveValue("15");
  await expect(page.locator("#remoteComposerIdleOpacity")).toHaveValue("55");
  await expect(page.locator("#remoteComposerFocusedOpacity")).toHaveValue("80");
  await expect(page.locator("#remoteComposerActiveOpacity")).toHaveValue("100");
  await expect
    .poll(() =>
      page.evaluate(() => ({
        terminal: (window as TermWindow).__remoteTerm?.options.fontSize ?? 0,
        composer: getComputedStyle(document.getElementById("composerInput") as HTMLElement)
          .fontSize,
        menu: getComputedStyle(document.getElementById("navigationPanel") as HTMLElement).fontSize,
        // The pane row itself is --fs-sm, so the activity pill must derive from
        // the menu base (15 * 9/13), not from the row's smaller size. The
        // workspace list renders after the navigation snapshot lands, so a
        // missing element reports null and the poll retries.
        paneActivity: ((element) =>
          element ? Math.round(parseFloat(getComputedStyle(element).fontSize) * 100) / 100 : null)(
          document.querySelector(".pane-activity"),
        ),
        workspaceName: ((element) =>
          element ? Math.round(parseFloat(getComputedStyle(element).fontSize) * 100) / 100 : null)(
          document.querySelector(".workspace-name"),
        ),
      })),
    )
    .toEqual({
      terminal: 18,
      composer: "20px",
      menu: "15px",
      paneActivity: Math.round((15 * 9 * 100) / 13) / 100,
      workspaceName: Math.round((15 * 14 * 100) / 13) / 100,
    });

  await page.locator("#remoteTerminalFontSize").fill("22");
  await page.locator("#remoteComposerFontSize").click();
  await expect.poll(() => harness.putBodies.length).toBe(1);
  await expect(page.locator("#remoteDisplaySettingsStatus")).toHaveText("Saved on this PC.");
  await expect
    .poll(() => page.evaluate(() => (window as TermWindow).__remoteTerm?.options.fontSize ?? 0))
    .toBe(22);

  await page.locator("#remoteComposerFontSize").fill("24");
  await page.locator("#remoteTerminalFontSize").click();
  await expect.poll(() => harness.putBodies.length).toBe(2);
  await expect
    .poll(() =>
      page.evaluate(
        () => getComputedStyle(document.getElementById("composerInput") as HTMLElement).fontSize,
      ),
    )
    .toBe("24px");

  await page.locator("#remoteMenuFontSize").fill("18");
  await page.locator("#remoteTerminalFontSize").click();
  await expect.poll(() => harness.putBodies.length).toBe(3);
  await expect
    .poll(() =>
      page.evaluate(
        () => getComputedStyle(document.getElementById("navigationPanel") as HTMLElement).fontSize,
      ),
    )
    .toBe("18px");
  expect(harness.putBodies).toEqual([
    {
      leaseId: "lease-1",
      expectedRevision: "rev-1",
      terminalFontSize: 22,
      composerFontSize: 20,
      menuFontSize: 15,
      composerIdleOpacity: 55,
      composerFocusedOpacity: 80,
      composerActiveOpacity: 100,
      touchScrollSensitivity: 1,
      twoFingerScrollSensitivity: 5,
    },
    {
      leaseId: "lease-1",
      expectedRevision: "rev-2",
      terminalFontSize: 22,
      composerFontSize: 24,
      menuFontSize: 15,
      composerIdleOpacity: 55,
      composerFocusedOpacity: 80,
      composerActiveOpacity: 100,
      touchScrollSensitivity: 1,
      twoFingerScrollSensitivity: 5,
    },
    {
      leaseId: "lease-1",
      expectedRevision: "rev-3",
      terminalFontSize: 22,
      composerFontSize: 24,
      menuFontSize: 18,
      composerIdleOpacity: 55,
      composerFocusedOpacity: 80,
      composerActiveOpacity: 100,
      touchScrollSensitivity: 1,
      twoFingerScrollSensitivity: 5,
    },
  ]);
});

test("저장 중 drawer를 다시 열어도 pending 상태와 최신 저장값을 잃지 않는다", async ({ page }) => {
  const harness: DisplaySettingsHarness = {
    settings: {
      terminalFontSize: 18,
      composerFontSize: 20,
      menuFontSize: 15,
      composerIdleOpacity: 55,
      composerFocusedOpacity: 80,
      composerActiveOpacity: 100,
      touchScrollSensitivity: 1,
      twoFingerScrollSensitivity: 5,
      revision: "rev-1",
    },
    claimLeaseIds: ["lease-1"],
    claimRequests: 0,
    getRequests: 0,
    putBodies: [],
    delayNextPut: true,
    releasePut: null,
  };
  await installRemoteMocks(page, harness);
  await connectAndOpenDisplaySettings(page);

  await page.locator("#remoteTerminalFontSize").fill("22");
  await page.locator("#remoteComposerFontSize").click();
  await expect.poll(() => harness.putBodies.length).toBe(1);
  await expect(page.locator("#remoteTerminalFontSize")).toBeDisabled();

  await page.locator("#drawerBack").click();
  await page.locator("#drawerSettingsButton").click();
  harness.releasePut?.();

  await expect(page.locator("#remoteTerminalFontSize")).toBeEnabled();
  await expect(page.locator("#remoteTerminalFontSize")).toHaveValue("22");
  await expect(page.locator("#remoteDisplaySettingsStatus")).toHaveText("Saved on this PC.");
});

test("저장 중 lease가 바뀌면 새 controller에서 PC 값을 다시 읽는다", async ({ page }) => {
  const harness: DisplaySettingsHarness = {
    settings: {
      terminalFontSize: 18,
      composerFontSize: 20,
      menuFontSize: 15,
      composerIdleOpacity: 55,
      composerFocusedOpacity: 80,
      composerActiveOpacity: 100,
      touchScrollSensitivity: 1,
      twoFingerScrollSensitivity: 5,
      revision: "rev-1",
    },
    claimLeaseIds: ["lease-1", "lease-2"],
    claimRequests: 0,
    getRequests: 0,
    putBodies: [],
    delayNextPut: true,
    releasePut: null,
  };
  await installRemoteMocks(page, harness);
  await connectAndOpenDisplaySettings(page);

  await page.locator("#remoteTerminalFontSize").fill("22");
  await page.locator("#remoteComposerFontSize").click();
  await expect.poll(() => harness.putBodies.length).toBe(1);

  await page.locator("#drawerBack").click();
  await page.locator("#drawerConnectionButton").click();
  await page.locator("#exit").click();
  await expect(page.locator("#connect")).toBeVisible();
  await page.locator("#connect").click();
  await expect.poll(() => harness.claimRequests).toBe(2);
  const getsBeforeOldSaveSettles = harness.getRequests;

  harness.releasePut?.();

  await expect.poll(() => harness.getRequests).toBeGreaterThan(getsBeforeOldSaveSettles);
  await expect(page.locator("#remoteTerminalFontSize")).toBeEnabled();
  await expect(page.locator("#remoteTerminalFontSize")).toHaveValue("22");
  await expect(page.locator("#remoteDisplaySettingsStatus")).toHaveText("Stored on this PC.");
});

test("PC settings revision이 바뀌면 stale Remote 저장을 거부하고 최신 값을 다시 읽는다", async ({
  page,
}) => {
  const harness: DisplaySettingsHarness = {
    settings: {
      terminalFontSize: 18,
      composerFontSize: 20,
      menuFontSize: 15,
      composerIdleOpacity: 55,
      composerFocusedOpacity: 80,
      composerActiveOpacity: 100,
      touchScrollSensitivity: 1,
      twoFingerScrollSensitivity: 5,
      revision: "rev-1",
    },
    claimLeaseIds: ["lease-1"],
    claimRequests: 0,
    getRequests: 0,
    putBodies: [],
    delayNextPut: false,
    releasePut: null,
  };
  await installRemoteMocks(page, harness);
  await connectAndOpenDisplaySettings(page);

  harness.settings = {
    terminalFontSize: 19,
    composerFontSize: 26,
    menuFontSize: 17,
    composerIdleOpacity: 45,
    composerFocusedOpacity: 75,
    composerActiveOpacity: 95,
    touchScrollSensitivity: 1,
    twoFingerScrollSensitivity: 5,
    revision: "rev-2",
  };
  const getsBeforeConflict = harness.getRequests;
  await page.locator("#remoteTerminalFontSize").fill("22");
  await page.locator("#remoteComposerFontSize").click();

  await expect.poll(() => harness.putBodies.length).toBe(1);
  expect(harness.putBodies[0]).toEqual({
    leaseId: "lease-1",
    expectedRevision: "rev-1",
    terminalFontSize: 22,
    composerFontSize: 20,
    menuFontSize: 15,
    composerIdleOpacity: 55,
    composerFocusedOpacity: 80,
    composerActiveOpacity: 100,
    touchScrollSensitivity: 1,
    twoFingerScrollSensitivity: 5,
  });
  await expect.poll(() => harness.getRequests).toBeGreaterThan(getsBeforeConflict);
  await expect(page.locator("#remoteTerminalFontSize")).toHaveValue("19");
  await expect(page.locator("#remoteComposerFontSize")).toHaveValue("26");
  await expect(page.locator("#remoteMenuFontSize")).toHaveValue("17");
  await expect(page.locator("#remoteComposerIdleOpacity")).toHaveValue("45");
  await expect(page.locator("#remoteComposerFocusedOpacity")).toHaveValue("75");
  await expect(page.locator("#remoteComposerActiveOpacity")).toHaveValue("95");
  await expect(page.locator("#remoteDisplaySettingsStatus")).toHaveText("Stored on this PC.");
});

test("Composer opacity follows Idle, Focused, and Active state and saves all three PC values", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("laymux.remote.inputMode", "composer");
  });
  const harness: DisplaySettingsHarness = {
    settings: {
      terminalFontSize: 18,
      composerFontSize: 20,
      menuFontSize: 15,
      composerIdleOpacity: 55,
      composerFocusedOpacity: 80,
      composerActiveOpacity: 100,
      touchScrollSensitivity: 1,
      twoFingerScrollSensitivity: 5,
      revision: "rev-1",
    },
    claimLeaseIds: ["lease-1"],
    claimRequests: 0,
    getRequests: 0,
    putBodies: [],
    delayNextPut: false,
    releasePut: null,
  };
  await installRemoteMocks(page, harness);
  await connectAndOpenDisplaySettings(page);

  const composer = page.locator("#terminalComposer");
  const input = page.locator("#composerInput");
  const terminal = page.locator("#terminal");
  const readAppearance = () =>
    composer.evaluate((element) => ({
      state: element.getAttribute("data-opacity-state"),
      opacity: getComputedStyle(element).opacity,
    }));

  const terminalBox = await terminal.boundingBox();
  const composerBox = await composer.boundingBox();
  expect(terminalBox).not.toBeNull();
  expect(composerBox).not.toBeNull();
  expect(composerBox!.y).toBeGreaterThan(terminalBox!.y);
  expect(composerBox!.y + composerBox!.height).toBeCloseTo(terminalBox!.y + terminalBox!.height, 0);

  await expect.poll(readAppearance).toEqual({ state: "idle", opacity: "0.55" });
  await page.locator("#navToggle").click();
  await input.focus();
  await expect.poll(readAppearance).toEqual({ state: "focused", opacity: "0.8" });

  await input.dispatchEvent("compositionstart");
  await input.blur();
  await expect.poll(readAppearance).toEqual({ state: "active", opacity: "1" });
  await input.dispatchEvent("compositionend");
  await expect.poll(readAppearance).toEqual({ state: "idle", opacity: "0.55" });

  await input.focus();
  await input.fill("draft");
  await expect.poll(readAppearance).toEqual({ state: "active", opacity: "1" });
  await input.fill("");
  await expect.poll(readAppearance).toEqual({ state: "focused", opacity: "0.8" });
  await input.blur();
  await expect.poll(readAppearance).toEqual({ state: "idle", opacity: "0.55" });

  const send = page.locator("#composerSend");
  await input.focus();
  await expect(send).toBeEnabled();
  await input.fill("remember this command");
  await send.click();
  await expect(input).toHaveValue("");
  await input.click();
  await expect(page.locator("#composerHistoryList")).toBeVisible();
  await expect.poll(readAppearance).toEqual({ state: "active", opacity: "1" });
  await input.press("Escape");
  await expect(page.locator("#composerHistoryList")).toBeHidden();
  await expect.poll(readAppearance).toEqual({ state: "focused", opacity: "0.8" });

  harness.delayNextInput = true;
  await send.click();
  await expect.poll(() => Boolean(harness.releaseInput)).toBe(true);
  await expect.poll(readAppearance).toEqual({ state: "active", opacity: "1" });
  harness.releaseInput?.();
  harness.releaseInput = null;
  await expect.poll(readAppearance).toEqual({ state: "focused", opacity: "0.8" });

  await input.fill("draft survives reconnect");
  await expect.poll(readAppearance).toEqual({ state: "active", opacity: "1" });
  await page.locator("#navToggle").click();
  await page.locator("#drawerConnectionButton").click();
  await page.locator("#exit").click();
  await expect(input).toBeDisabled();
  await expect.poll(readAppearance).toEqual({ state: "idle", opacity: "0.55" });
  await page.locator("#connect").click();
  await expect(input).toBeEnabled();
  await expect.poll(readAppearance).toEqual({ state: "active", opacity: "1" });
  await input.fill("");

  await page.locator("#navToggle").click();
  await page.locator("#drawerSettingsButton").click();
  await page.locator("#remoteComposerIdleOpacity").fill("45");
  await page.locator("#remoteComposerFocusedOpacity").click();
  await expect.poll(() => harness.putBodies.length).toBe(1);
  await page.locator("#remoteComposerFocusedOpacity").fill("75");
  await page.locator("#remoteComposerActiveOpacity").click();
  await expect.poll(() => harness.putBodies.length).toBe(2);
  await page.locator("#remoteComposerActiveOpacity").fill("95");
  await page.locator("#remoteTerminalFontSize").click();
  await expect.poll(() => harness.putBodies.length).toBe(3);
  expect(harness.putBodies.at(-1)).toEqual({
    leaseId: "lease-1",
    expectedRevision: "rev-3",
    terminalFontSize: 18,
    composerFontSize: 20,
    menuFontSize: 15,
    composerIdleOpacity: 45,
    composerFocusedOpacity: 75,
    composerActiveOpacity: 95,
    touchScrollSensitivity: 1,
    twoFingerScrollSensitivity: 5,
  });

  await page.locator("#remoteComposerIdleOpacity").fill("90");
  await page.locator("#remoteComposerFocusedOpacity").click();
  await expect.poll(() => harness.putBodies.length).toBe(4);
  expect(harness.putBodies.at(-1)).toMatchObject({
    composerIdleOpacity: 75,
    composerFocusedOpacity: 75,
    composerActiveOpacity: 95,
  });
  await page.locator("#remoteComposerActiveOpacity").fill("50");
  await page.locator("#remoteTerminalFontSize").click();
  await expect.poll(() => harness.putBodies.length).toBe(5);
  expect(harness.putBodies.at(-1)).toMatchObject({
    composerIdleOpacity: 50,
    composerFocusedOpacity: 50,
    composerActiveOpacity: 50,
  });

  await page.locator("#navToggle").click();
  await input.focus();
  await input.fill("active again");
  await expect.poll(readAppearance).toEqual({ state: "active", opacity: "0.5" });
});

test("overlay Composer는 이미 덮은 agent 입력 줄만큼 viewport를 추가로 올리지 않는다", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("laymux.remote.inputMode", "composer");
  });
  const harness: DisplaySettingsHarness = {
    settings: {
      terminalFontSize: 18,
      composerFontSize: 20,
      menuFontSize: 15,
      composerIdleOpacity: 55,
      composerFocusedOpacity: 80,
      composerActiveOpacity: 100,
      touchScrollSensitivity: 1,
      twoFingerScrollSensitivity: 5,
      revision: "rev-1",
    },
    claimLeaseIds: ["lease-1"],
    claimRequests: 0,
    getRequests: 0,
    putBodies: [],
    delayNextPut: false,
    releasePut: null,
  };
  const snapshotText = Array.from(
    { length: 80 },
    (_, index) => `OVERLAY-SCROLL-${index + 1}\r\n`,
  ).join("");
  await installRemoteMocks(page, harness, {
    activity: { type: "interactiveApp", name: "Claude" },
    snapshotText,
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
  await expect(page.locator("#terminalComposer")).toBeVisible();

  await expect
    .poll(() =>
      page.evaluate(() => {
        const buffer = (window as TermWindow).__remoteTerm?.buffer.active;
        return Boolean(buffer && buffer.baseY > 0 && buffer.viewportY === buffer.baseY);
      }),
    )
    .toBe(true);
});

test("Composer 높이가 바뀌면 숨김 경계와 최하단 버튼 위치를 overlay에 맞춘다", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("laymux.remote.inputMode", "composer");
    localStorage.setItem(
      "laymux.remote.composerHiddenAgentInputLines",
      JSON.stringify({ Claude: 10 }),
    );
  });
  const harness: DisplaySettingsHarness = {
    settings: {
      terminalFontSize: 18,
      composerFontSize: 20,
      menuFontSize: 15,
      composerIdleOpacity: 55,
      composerFocusedOpacity: 80,
      composerActiveOpacity: 100,
      touchScrollSensitivity: 1,
      twoFingerScrollSensitivity: 5,
      revision: "rev-1",
    },
    claimLeaseIds: ["lease-1"],
    claimRequests: 0,
    getRequests: 0,
    putBodies: [],
    delayNextPut: false,
    releasePut: null,
  };
  await installRemoteMocks(page, harness, {
    activity: { type: "interactiveApp", name: "Claude" },
    snapshotText: Array.from({ length: 80 }, (_, index) => `OVERLAY-RESIZE-${index + 1}\r\n`).join(
      "",
    ),
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
  await expect
    .poll(() => page.evaluate(() => Boolean((window as TermWindow).__remoteTerm)))
    .toBe(true);
  // Make the hide request and queue a newer fit in the same task. The boundary
  // must wait for that newest generation instead of sampling first-pass metrics.
  await page.evaluate(() => {
    const term = (window as TermWindow).__remoteTerm;
    const composer = document.querySelector<HTMLTextAreaElement>("#composerInput");
    if (!term || !composer) return;
    composer.blur();
    composer.focus();
    term.options.fontSize += 1;
    window.dispatchEvent(new Event("resize"));
  });

  const readBoundary = () =>
    page.evaluate(() => {
      const term = (window as TermWindow).__remoteTerm;
      if (!term) return null;
      const buffer = term.buffer.active;
      const terminalElement = document.querySelector("#terminal")!;
      const screen = terminalElement.querySelector(".xterm-screen")!;
      const composer = document.querySelector("#terminalComposer")!;
      const screenRect = screen.getBoundingClientRect();
      const composerRect = composer.getBoundingClientRect();
      const rows = document.querySelectorAll(".xterm-rows > div").length;
      const overlap = Math.max(
        0,
        Math.min(screenRect.bottom, composerRect.bottom) -
          Math.max(screenRect.top, composerRect.top),
      );
      const coveredRows = Math.ceil(overlap / (screenRect.height / rows));
      return {
        actual: buffer.baseY - buffer.viewportY,
        expected: Math.max(0, 10 - coveredRows),
      };
    });

  await expect.poll(readBoundary).toEqual({ actual: 6, expected: 6 });
  const button = page.locator("#scrollToBottom");
  await expect(button).toBeVisible();
  const composerBox = await page.locator("#terminalComposer").boundingBox();
  const buttonBox = await button.boundingBox();
  expect(composerBox).not.toBeNull();
  expect(buttonBox).not.toBeNull();
  expect(buttonBox!.y + buttonBox!.height).toBeLessThanOrEqual(composerBox!.y);

  await page.locator("#composerInput").evaluate((element) => {
    element.style.height = "110px";
  });
  await expect
    .poll(async () => {
      const boundary = await readBoundary();
      return (
        boundary !== null &&
        boundary.actual === boundary.expected &&
        boundary.expected > 0 &&
        boundary.expected < 6
      );
    })
    .toBe(true);
  const resizedComposerBox = await page.locator("#terminalComposer").boundingBox();
  const resizedButtonBox = await button.boundingBox();
  expect(resizedComposerBox).not.toBeNull();
  expect(resizedButtonBox).not.toBeNull();
  expect(resizedButtonBox!.y + resizedButtonBox!.height).toBeLessThanOrEqual(resizedComposerBox!.y);

  await button.click();
  await expect
    .poll(async () => {
      const boundary = await readBoundary();
      return boundary !== null && boundary.actual === 0 && boundary.expected > 0;
    })
    .toBe(true);
  await expect(button).toBeHidden();
});
