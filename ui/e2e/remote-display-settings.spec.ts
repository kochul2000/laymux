import { expect, test, type Page } from "@playwright/test";

import { installRemoteClientRoutes } from "./remote-client-assets";

const navigation = {
  activeWorkspace: {
    id: "ws-1",
    name: "Main",
    panes: [
      {
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
        commandRunning: false,
        isFocused: true,
        unreadCount: 0,
        hidden: false,
        collapsed: false,
        x: 0,
        y: 0,
        w: 1,
        h: 1,
      },
    ],
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
      panes: [],
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

async function installRemoteMocks(page: Page, harness: DisplaySettingsHarness) {
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
      await route.fulfill({ json: navigation });
      return;
    }
    if (url.pathname === "/remote/v1/display-settings") {
      if (route.request().method() === "GET") {
        harness.getRequests += 1;
        await route.fulfill({ json: harness.settings });
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
        revision: `rev-${revisionNumber + 1}`,
      };
      await route.fulfill({ json: harness.settings });
      return;
    }
    await route.fulfill({ json: {} });
  });

  await page.routeWebSocket(/\/remote\/v1\/terminals\/terminal-1\/output/, (socket) => {
    const snapshot = snapshotFrames("ready\r\n");
    socket.send(snapshot.header);
    socket.send(snapshot.payload);
  });
}

type TermWindow = typeof window & {
  Terminal: { prototype: { reset: () => void } };
  __remoteTerm?: { options: { fontSize: number } };
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
    settings: { terminalFontSize: 18, composerFontSize: 20, revision: "rev-1" },
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
  await expect
    .poll(() =>
      page.evaluate(() => ({
        terminal: (window as TermWindow).__remoteTerm?.options.fontSize ?? 0,
        composer: getComputedStyle(document.getElementById("composerInput") as HTMLElement)
          .fontSize,
      })),
    )
    .toEqual({ terminal: 18, composer: "20px" });

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
  expect(harness.putBodies).toEqual([
    {
      leaseId: "lease-1",
      expectedRevision: "rev-1",
      terminalFontSize: 22,
      composerFontSize: 20,
    },
    {
      leaseId: "lease-1",
      expectedRevision: "rev-2",
      terminalFontSize: 22,
      composerFontSize: 24,
    },
  ]);
});

test("저장 중 drawer를 다시 열어도 pending 상태와 최신 저장값을 잃지 않는다", async ({ page }) => {
  const harness: DisplaySettingsHarness = {
    settings: { terminalFontSize: 18, composerFontSize: 20, revision: "rev-1" },
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
    settings: { terminalFontSize: 18, composerFontSize: 20, revision: "rev-1" },
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
    settings: { terminalFontSize: 18, composerFontSize: 20, revision: "rev-1" },
    claimLeaseIds: ["lease-1"],
    claimRequests: 0,
    getRequests: 0,
    putBodies: [],
    delayNextPut: false,
    releasePut: null,
  };
  await installRemoteMocks(page, harness);
  await connectAndOpenDisplaySettings(page);

  harness.settings = { terminalFontSize: 19, composerFontSize: 26, revision: "rev-2" };
  const getsBeforeConflict = harness.getRequests;
  await page.locator("#remoteTerminalFontSize").fill("22");
  await page.locator("#remoteComposerFontSize").click();

  await expect.poll(() => harness.putBodies.length).toBe(1);
  expect(harness.putBodies[0]).toEqual({
    leaseId: "lease-1",
    expectedRevision: "rev-1",
    terminalFontSize: 22,
    composerFontSize: 20,
  });
  await expect.poll(() => harness.getRequests).toBeGreaterThan(getsBeforeConflict);
  await expect(page.locator("#remoteTerminalFontSize")).toHaveValue("19");
  await expect(page.locator("#remoteComposerFontSize")).toHaveValue("26");
  await expect(page.locator("#remoteDisplaySettingsStatus")).toHaveText("Stored on this PC.");
});
