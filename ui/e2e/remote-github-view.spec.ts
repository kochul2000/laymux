import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { fulfillRemoteClientAsset } from "./remote-client-assets";

const snapshot = {
  cwd: "/work/repo",
  status: { type: "ready" },
  repo: "owner/repo",
  repoUrl: "https://github.com/owner/repo",
  issues: [
    {
      number: 17,
      title: "Mobile GitHub view",
      author: "alice",
      url: "https://github.com/owner/repo/issues/17",
      updatedAt: "2026-09-18T00:00:00Z",
      labels: ["mobile", "enhancement"],
      isDraft: false,
      headRefName: "",
    },
  ],
  pulls: [
    {
      number: 18,
      title: "Ship the remote view",
      author: "bob",
      url: "https://github.com/owner/repo/pull/18",
      updatedAt: "2026-09-18T00:00:00Z",
      labels: ["ready"],
      isDraft: true,
      headRefName: "feat/remote-github",
    },
  ],
  fetchedAtMs: 1,
};

async function installMocks(context: BrowserContext) {
  const snapshotRequests: string[] = [];
  const actionRequests: Array<Record<string, unknown>> = [];
  const memoRequests: Array<Record<string, unknown>> = [];
  let pcMemo = "PC에서 쓴 메모\n공유 확인";
  await context.route("http://remote.test/remote/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (await fulfillRemoteClientAsset(route, url.pathname)) return;
    if (url.pathname.endsWith("/worktrees")) {
      return route.fulfill({
        json: {
          success: true,
          cwd: "/work/repo",
          data: { repositoryPath: "/work/repo", worktrees: [], usageWarnings: [] },
        },
      });
    }
    if (url.pathname === "/remote/v1/file-viewer/list") {
      return route.fulfill({
        json: {
          path: "/work/repo",
          parent: "/work",
          truncated: false,
          entries: [
            {
              name: "notes.txt",
              path: "/work/repo/notes.txt",
              isDirectory: false,
              isSymlink: false,
              size: 24,
            },
          ],
        },
      });
    }
    if (url.pathname === "/remote/v1/file-viewer/render") {
      return route.fulfill({
        json: {
          kind: "text",
          path: "/work/repo/notes.txt",
          content: "file text",
          truncated: false,
        },
      });
    }
    if (url.pathname === "/remote/v1/memos") {
      if (request.method() === "GET") {
        expect(url.searchParams.get("leaseId")).toBe("lease-257");
        return route.fulfill({
          json: { memos: [{ key: "memo-pane-2", content: pcMemo }], count: 1 },
        });
      }
      const body = JSON.parse(request.postData() || "{}");
      memoRequests.push(body);
      if (body.expectedContent !== pcMemo)
        return route.fulfill({
          status: 409,
          json: { error: "Memo changed on the PC. Copy your draft, then reload." },
        });
      pcMemo = body.content;
      return route.fulfill({ json: { ok: true } });
    }
    if (url.pathname === "/remote/v1/session/claim") {
      return route.fulfill({
        json: {
          active: true,
          leaseId: "lease-257",
          resumeToken: "resume-257",
          fileViewerToken: "viewer-257",
          heartbeatTimeoutSeconds: 45,
        },
      });
    }
    if (url.pathname === "/remote/v1/session/heartbeat") {
      return route.fulfill({ json: { ok: true } });
    }
    if (url.pathname === "/remote/v1/session/release") {
      return route.fulfill({ json: { ok: true } });
    }
    if (url.pathname === "/remote/v1/navigation") {
      const pane = {
        id: "pane-1",
        location: "workspace",
        workspaceId: "ws-1",
        paneIndex: 0,
        paneNumber: 1,
        viewType: "TerminalView",
        terminalId: "terminal-1",
        terminalLive: true,
        title: "Shell",
        profile: "PowerShell",
        cwd: "/work/repo",
        activity: { type: "shell" },
        isFocused: true,
        hidden: false,
        collapsed: false,
        x: 0,
        y: 0,
        w: 1,
        h: 1,
      };
      return route.fulfill({
        json: {
          activeWorkspace: { id: "ws-1", name: "Main", panes: [pane] },
          workspaces: [{ id: "ws-1", name: "Main", isActive: true, hidden: false, panes: [pane] }],
          docks: [],
          terminals: [
            {
              id: "terminal-1",
              title: "Shell",
              profile: "PowerShell",
              cwd: "/work/repo",
              workspaceId: "ws-1",
              paneNumber: 1,
              appearance: {
                fontFamily: "'Cascadia Mono', monospace",
                cursorStyle: "bar",
                cursorWidth: 1,
                theme: {},
              },
            },
          ],
          workspaceSelector: { display: {}, pathEllipsis: "start" },
          notifications: [],
          unreadNotificationCount: 0,
        },
      });
    }
    if (url.pathname === "/remote/v1/terminals/terminal-1/github-repo") {
      return route.fulfill({ json: { cwd: "/work/repo", repoBase: snapshot.repoUrl } });
    }
    if (url.pathname === "/remote/v1/terminals/terminal-1/github") {
      snapshotRequests.push(url.search);
      return route.fulfill({ json: snapshot });
    }
    if (url.pathname === "/remote/v1/terminals/terminal-1/github/actions") {
      actionRequests.push(JSON.parse(request.postData() || "{}"));
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ status: 404, json: { error: "not mocked" } });
  });
  await context.routeWebSocket(/\/remote\/v1\/terminals\/terminal-1\/output/, () => {});
  return {
    snapshotRequests,
    actionRequests,
    memoRequests,
    changePcMemo: (text: string) => {
      pcMemo = text;
    },
  };
}

async function connect(page: Page) {
  await page.goto("http://remote.test/remote/");
  await page.locator("#token").fill("remote-secret");
  await page.locator("#connect").click();
  await expect(page.locator("#githubHeader")).toBeVisible();
}

async function flickRightEdge(page: Page) {
  await page.locator("#terminal .xterm").evaluate((element) => {
    const target = element as HTMLElement;
    const rect = target.getBoundingClientRect();
    target.setPointerCapture = () => {};
    target.releasePointerCapture = () => {};
    target.hasPointerCapture = () => false;
    const startX = rect.right - 1;
    const endX = startX - 80;
    const event = (type: string, clientX: number) =>
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 57,
          pointerType: "touch",
          isPrimary: true,
          clientX,
          clientY: rect.top + rect.height / 2,
        }),
      );
    event("pointerdown", startX);
    event("pointermove", endX);
    event("pointerup", endX);
  });
}

async function flickTool(page: Page, selector: string, direction: number, dy = 0) {
  await page.locator(selector).evaluate(
    (target, { direction, dy }) => {
      const rect = target.getBoundingClientRect();
      const x = direction > 0 ? rect.left + 20 : rect.right - 20;
      const y = rect.top + Math.min(rect.height / 2, 20);
      for (const [type, distance] of [
        ["pointerdown", 0],
        ["pointermove", 80],
        ["pointermove", 120],
        ["pointerup", 120],
      ] as const) {
        target.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 71,
            pointerType: "touch",
            isPrimary: true,
            clientX: x + distance * direction,
            clientY: y + (distance ? dy : 0),
          }),
        );
      }
    },
    { direction, dy },
  );
}

// Native touch input lets Chromium arbitrate scrolling against pointer handlers.
// dispatchEvent alone cannot expose a textarea consuming the horizontal fling.
async function flickSurface(page: Page, selector: string, dx: number, dy = 0) {
  const surface = page.locator(selector);
  await expect(surface).toBeVisible();
  const box = (await surface.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y, id: 1 }],
    });
    for (let step = 1; step <= 8; step += 1) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x + (dx * step) / 8, y: y + (dy * step) / 8, id: 1 }],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await cdp.detach();
  }
}

async function flickMemo(page: Page, dx: number, dy = 0) {
  await expect(page.locator("#memoText")).toBeEnabled();
  await flickSurface(page, "#memoText", dx, dy);
}

async function openPanelSettings(page: Page) {
  await page.locator("#navToggle").click();
  await page.locator("#drawerSettingsButton").click();
  await page.locator("#settingsTabPanels").click();
}

async function expectToolControls(page: Page, toolbar: string, body: string, bottom: boolean) {
  const controls = (await page.locator(toolbar).boundingBox())!;
  const content = (await page.locator(body).boundingBox())!;
  expect(controls.height).toBe(40);
  expect(controls.x).toBeGreaterThanOrEqual(0);
  expect(controls.x + controls.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(controls.y + controls.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  if (bottom) expect(content.y + content.height).toBeLessThanOrEqual(controls.y + 1);
  else expect(controls.y + controls.height).toBeLessThanOrEqual(content.y + 1);
}

test.describe("Remote GitHub view", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 720 } });

  test("native right flings return from PRs to Issues before closing", async ({
    context,
    page,
  }) => {
    await installMocks(context);
    await connect(page);
    await page.locator("#githubHeader").click();
    await page.locator("#githubPullsTab").click();
    await flickSurface(page, "#githubList", 120);
    await expect(page.locator("#githubOverlay")).toBeVisible();
    await expect(page.locator("#githubIssuesTab")).toHaveAttribute("aria-selected", "true");
    await flickSurface(page, "#githubList", 120);
    await expect(page.locator("#githubOverlay")).toBeHidden();
  });

  test("PRs can return to Issues with close and the GitHub header icon disabled", async ({
    context,
    page,
  }) => {
    await installMocks(context);
    await context.addInitScript(() => {
      localStorage.setItem("laymux.remote.swipeCloseDrawers", "0");
      localStorage.setItem("laymux.remote.headerGithub", "0");
      localStorage.setItem("laymux.remote.rightSwipeView", "github");
    });
    await page.goto("http://remote.test/remote/");
    await page.locator("#token").fill("remote-secret");
    await page.locator("#connect").click();
    await expect(page.locator("#terminal .xterm")).toBeVisible();
    await flickRightEdge(page);
    await page.locator("#githubPullsTab").click();
    await flickSurface(page, "#githubList", 120);
    await expect(page.locator("#githubIssuesTab")).toHaveAttribute("aria-selected", "true");
    await flickSurface(page, "#githubList", 120);
    await expect(page.locator("#githubOverlay")).toBeVisible();
  });

  test("all right tools default to bottom controls and retain the top preference after reload", async ({
    context,
    page,
  }) => {
    await installMocks(context);
    await connect(page);
    for (const width of [390, 900]) {
      await page.setViewportSize({ width, height: 720 });
      await page.locator("#githubHeader").click();
      await expect(page.locator("#githubList .github-row")).toHaveCount(1);
      await expectToolControls(page, "#githubToolbar", "#githubList", true);
      await page.screenshot({ path: `../.screenshots/remote-github-controls-bottom-${width}.png` });
      await page.locator("#githubClose").click();
      await page.locator("#memoHeader").click();
      await expect(page.locator("#memoText")).toBeEnabled();
      await expectToolControls(page, "#memoToolbar", "#memoText", true);
      await page.screenshot({ path: `../.screenshots/remote-memo-controls-bottom-${width}.png` });
      await page.locator("#memoClose").click();
      await page.locator("#fileExplorerHeader").click();
      await expect(page.locator("#fileViewerDirectory")).toBeVisible();
      await expectToolControls(page, "#fileViewerToolbar", "#fileViewerBody", true);
      await page.locator(".file-viewer-directory-row", { hasText: "notes.txt" }).click();
      await expect(page.locator("#fileViewerText")).toBeVisible();
      await expectToolControls(page, "#fileViewerToolbar", "#fileViewerBody", true);
      await page.screenshot({ path: `../.screenshots/remote-file-controls-bottom-${width}.png` });
      await page.locator("#fileViewerClose").click();
    }
    await openPanelSettings(page);
    await expect(page.locator("#toolControlsBottomToggle")).toBeChecked();
    await page.locator("#toolControlsBottomToggle").uncheck();
    expect(
      await page.evaluate(() => localStorage.getItem("laymux.remote.toolControlsBottom")),
    ).toBe("0");
    await page.locator("#navToggle").click();
    await page.locator("#githubHeader").click();
    await expectToolControls(page, "#githubToolbar", "#githubList", false);
    await page.locator("#githubClose").click();
    await page.locator("#memoHeader").click();
    await expectToolControls(page, "#memoToolbar", "#memoText", false);
    await page.locator("#memoText").fill("배치 옵션 뒤에도 보존할 초안");
    await page.locator("#memoClose").click();
    await page.locator("#fileExplorerHeader").click();
    await expectToolControls(page, "#fileViewerToolbar", "#fileViewerBody", false);
    await page.locator("#fileViewerClose").click();
    await openPanelSettings(page);
    await page.locator("#toolControlsBottomToggle").check();
    await page.locator("#navToggle").click();
    await page.locator("#memoHeader").click();
    await expectToolControls(page, "#memoToolbar", "#memoText", true);
    await expect(page.locator("#memoText")).toHaveValue("배치 옵션 뒤에도 보존할 초안");
    await page.locator("#memoClose").click();
    await openPanelSettings(page);
    await page.locator("#toolControlsBottomToggle").uncheck();
    await page.reload();
    await openPanelSettings(page);
    await expect(page.locator("#toolControlsBottomToggle")).not.toBeChecked();
    await page.locator("#navToggle").click();
    await expect(page.locator("#githubHeader")).toBeVisible();
    await page.locator("#githubHeader").click();
    await expectToolControls(page, "#githubToolbar", "#githubList", false);
  });

  test("bottom tool controls follow the visible viewport when the keyboard reduces it", async ({
    context,
    page,
  }) => {
    await installMocks(context);
    await connect(page);
    await page.locator("#memoHeader").click();
    await expect(page.locator("#memoText")).toBeEnabled();
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport, "height", { configurable: true, value: 400 });
      window.visualViewport!.dispatchEvent(new Event("resize"));
    });
    const controls = (await page.locator("#memoToolbar").boundingBox())!;
    expect(controls.y + controls.height).toBeLessThanOrEqual(400);
    await expectToolControls(page, "#memoToolbar", "#memoText", true);
    await page.screenshot({ path: "../.screenshots/remote-memo-controls-keyboard.png" });
  });

  test("MCP changes tool control placement live without resetting the memo editor", async ({
    context,
    page,
  }) => {
    await installMocks(context);
    let pending: { toolControlsBottom: boolean } | null = null;
    let ack: { requestId: string; success: boolean } | undefined;
    let serial = 0;
    let reportedBottom: boolean | undefined;
    await context.route("http://remote.test/remote/v1/session/heartbeat", async (route) => {
      const { deviceSettings: device, leaseId } = route.request().postDataJSON();
      reportedBottom = device.settings.toolControlsBottom;
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
    await connect(page);
    await page.locator("#memoHeader").click();
    await expect(page.locator("#memoText")).toBeEnabled();
    await page.locator("#memoText").fill("위치를 바꿔도 보존되는 메모 초안");
    await page
      .locator("#memoText")
      .evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(2, 6));
    for (const bottom of [false, true]) {
      const requestId = String(serial + 1);
      pending = { toolControlsBottom: bottom };
      await expect.poll(() => ack, { timeout: 15000 }).toMatchObject({ requestId, success: true });
      expect(reportedBottom).toBe(bottom);
      await expectToolControls(page, "#memoToolbar", "#memoText", bottom);
      await expect(page.locator("#memoText")).toBeFocused();
      await expect(page.locator("#memoText")).toHaveValue("위치를 바꿔도 보존되는 메모 초안");
      expect(
        await page
          .locator("#memoText")
          .evaluate((element: HTMLTextAreaElement) => [
            element.selectionStart,
            element.selectionEnd,
          ]),
      ).toEqual([2, 6]);
      expect(
        await page.evaluate(() => localStorage.getItem("laymux.remote.toolControlsBottom")),
      ).toBe(bottom ? "1" : "0");
    }
  });

  test("native memo body flings change tools and retain the unsaved draft", async ({
    context,
    page,
  }) => {
    const mocks = await installMocks(context);
    await connect(page);
    await page.locator("#memoHeader").click();
    await expect(page.locator("#memoText")).toHaveValue("PC에서 쓴 메모\n공유 확인");
    await page.locator("#memoText").fill("플링 뒤에도 남는 메모 초안");
    await flickMemo(page, -120);
    await expect(page.locator("#memoOverlay")).toBeHidden();
    await expect(page.locator("#githubIssuesTab")).toHaveAttribute("aria-selected", "true");
    await page.locator("#githubClose").click();
    await page.locator("#memoHeader").click();
    await expect(page.locator("#memoText")).toHaveValue("플링 뒤에도 남는 메모 초안");
    await flickMemo(page, 120);
    await expect(page.locator("#memoOverlay")).toBeHidden();
    expect(mocks.memoRequests).toEqual([]);
  });

  test("memo body flings respect previous-tool and disabled-close settings", async ({
    context,
    page,
  }) => {
    await installMocks(context);
    await context.addInitScript(() => {
      localStorage.setItem("laymux.remote.toolSwipeRightAction", "previous");
      localStorage.setItem("laymux.remote.swipeCloseDrawers", "0");
    });
    await connect(page);
    await page.locator("#memoHeader").click();
    await flickMemo(page, 120);
    await expect(page.locator("#worktreesOverlay")).toBeVisible();
    await page.locator("#worktreesClose").click();
    await page.locator("#navToggle").click();
    await page.locator("#drawerSettingsButton").click();
    await page.locator("#settingsTabPanels").click();
    await page.locator("#toolSwipeRightAction").selectOption("close");
    await page.locator("#navToggle").click();
    await page.locator("#memoHeader").click();
    await flickMemo(page, 120);
    await expect(page.locator("#memoOverlay")).toBeVisible();
  });

  test("memo body keeps native tapping, selected text and vertical scrolling", async ({
    context,
    page,
  }) => {
    const mocks = await installMocks(context);
    const content = Array.from(
      { length: 160 },
      (_, index) => `メモ ${index}: 세로 스크롤 확인`,
    ).join("\n");
    mocks.changePcMemo(content);
    await connect(page);
    await page.locator("#memoHeader").click();
    const textarea = page.locator("#memoText");
    await expect(textarea).toHaveValue(content);
    await textarea.tap();
    await expect(textarea).toBeFocused();
    await textarea.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, 6));
    await flickMemo(page, -120);
    await expect(page.locator("#memoOverlay")).toBeVisible();
    await textarea.evaluate((element: HTMLTextAreaElement) => {
      element.setSelectionRange(0, 0);
      element.blur();
      element.scrollTop = 0;
    });
    await flickMemo(page, 0, -160);
    await expect.poll(() => textarea.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(page.locator("#memoOverlay")).toBeVisible();
    await expect(textarea).toHaveValue(content);
    expect(mocks.memoRequests).toEqual([]);
    await page.screenshot({ path: "../.screenshots/remote-memo-fling.png" });
  });

  test("cycles one step per fling through Issues, PRs, Files, Worktrees and Memo without losing drafts", async ({
    context,
    page,
  }) => {
    const mocks = await installMocks(context);
    await connect(page);
    await page.locator("#githubHeader").click();
    await flickTool(page, "#githubList", -1);
    await expect(page.locator("#githubPullsTab")).toHaveAttribute("aria-selected", "true");
    await flickTool(page, "#githubToolbar", -1);
    await expect(page.locator("#fileViewerDirectory")).toBeVisible();
    await flickTool(page, "#fileViewerDirectory", -1);
    await expect(page.locator("#worktreesOverlay")).toBeVisible();
    await flickTool(page, "#worktreesToolbar", -1);
    await expect(page.locator("#memoText")).toHaveValue("PC에서 쓴 메모\n공유 확인");
    await page.locator("#memoText").fill("순회 중 보존할 초안");
    await flickTool(page, "#memoText", -1);
    await expect(page.locator("#githubIssuesTab")).toHaveAttribute("aria-selected", "true");
    await flickTool(page, "#githubList", -1);
    await flickTool(page, "#githubList", -1);
    await flickTool(page, "#fileViewerDirectory", -1);
    await flickTool(page, "#worktreesToolbar", -1);
    await expect(page.locator("#memoText")).toHaveValue("순회 중 보존할 초안");
    expect(mocks.memoRequests).toEqual([]);
  });

  test("right swipe defaults to close and its previous-tool setting persists", async ({
    context,
    page,
  }) => {
    await installMocks(context);
    await connect(page);
    await page.locator("#githubHeader").click();
    await flickTool(page, "#githubList", 1);
    await expect(page.locator("#githubOverlay")).toBeHidden();
    await page.locator("#navToggle").click();
    await page.locator("#drawerSettingsButton").click();
    await page.locator("#settingsTabPanels").click();
    await page.locator("#toolSwipeRightAction").selectOption("previous");
    await page.locator("#swipeCloseDrawersToggle").uncheck();
    expect(
      await page.evaluate(() => localStorage.getItem("laymux.remote.toolSwipeRightAction")),
    ).toBe("previous");
    await page.locator("#navToggle").click();
    await page.locator("#githubHeader").click();
    await flickTool(page, "#githubList", 1);
    await expect(page.locator("#memoOverlay")).toBeVisible();
    await flickTool(page, "#memoToolbar", 1);
    await expect(page.locator("#worktreesOverlay")).toBeVisible();
    await flickTool(page, "#worktreesToolbar", 1);
    await expect(page.locator("#fileViewerDirectory")).toBeVisible();
    await flickTool(page, "#fileViewerDirectory", 1);
    await expect(page.locator("#githubPullsTab")).toHaveAttribute("aria-selected", "true");
    await flickTool(page, "#githubList", 1);
    await expect(page.locator("#githubIssuesTab")).toHaveAttribute("aria-selected", "true");
    await page.reload();
    await page.locator("#navToggle").click();
    await page.locator("#drawerSettingsButton").click();
    await page.locator("#settingsTabPanels").click();
    await expect(page.locator("#toolSwipeRightAction")).toHaveValue("previous");
  });

  test("skips hidden tools, leaves vertical gestures and file text alone, and keeps Files Back", async ({
    context,
    page,
  }) => {
    await installMocks(context);
    await context.addInitScript(() => {
      localStorage.setItem("laymux.remote.headerGithub", "0");
      localStorage.setItem("laymux.remote.headerWorktrees", "0");
      localStorage.setItem("laymux.remote.toolSwipeRightAction", "previous");
    });
    await page.goto("http://remote.test/remote/");
    await page.locator("#token").fill("remote-secret");
    await page.locator("#connect").click();
    await page.locator("#fileExplorerHeader").click();
    await page.locator(".file-viewer-directory-row", { hasText: "notes.txt" }).click();
    await expect(page.locator("#fileViewerText")).toBeVisible();
    await flickTool(page, "#fileViewerText", -1);
    await expect(page.locator("#fileViewerText")).toBeVisible();
    await page.locator("#fileViewerBack").click();
    await expect(page.locator("#fileViewerDirectory")).toBeVisible();
    await flickTool(page, "#fileViewerDirectory", -1, 150);
    await expect(page.locator("#fileViewerDirectory")).toBeVisible();
    await flickTool(page, "#fileViewerDirectory", -1);
    await expect(page.locator("#memoOverlay")).toBeVisible();
    await flickTool(page, "#memoToolbar", -1);
    await expect(page.locator("#fileViewerDirectory")).toBeVisible();
    await flickTool(page, "#fileViewerDirectory", 1);
    await expect(page.locator("#memoOverlay")).toBeVisible();
  });

  test("shares PC memos, retains conflicting drafts, and hides icons independently of swipe", async ({
    context,
    page,
  }) => {
    const mocks = await installMocks(context);
    await connect(page);
    await page.locator("#memoHeader").click();
    await expect(page.locator("#memoText")).toHaveValue("PC에서 쓴 메모\n공유 확인");
    await page.locator("#memoText").fill("모바일 수정");
    await page.locator("#memoSave").click();
    await expect(page.locator("#memoStatus")).toHaveText("Saved on PC");
    expect(mocks.memoRequests).toEqual([
      {
        leaseId: "lease-257",
        key: "memo-pane-2",
        content: "모바일 수정",
        expectedContent: "PC에서 쓴 메모\n공유 확인",
      },
    ]);
    await page.locator("#memoText").fill("보존할 초안");
    mocks.changePcMemo("PC 동시 수정");
    await page.locator("#memoSave").click();
    await expect(page.locator("#memoStatus")).toContainText("Memo changed");
    await expect(page.locator("#memoText")).toHaveValue("보존할 초안");
    expect(
      await page.evaluate(() =>
        (
          window as Window & { laymuxRemoteUi: { dismissTopLayer: () => boolean } }
        ).laymuxRemoteUi.dismissTopLayer(),
      ),
    ).toBe(true);
    await expect(page.locator("#memoOverlay")).toBeHidden();
    await page.locator("#memoHeader").click();
    await expect(page.locator("#memoText")).toHaveValue("보존할 초안");
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#memoReload").click();
    await expect(page.locator("#memoText")).toHaveValue("PC 동시 수정");
    await page.locator("#memoClose").click();

    await page.locator("#navToggle").click();
    await page.locator("#drawerSettingsButton").click();
    await page.locator("#settingsTabPanels").click();
    for (const key of [
      "headerFiles",
      "headerGithub",
      "headerWorktrees",
      "headerMemo",
      "headerSpatialExclusion",
      "headerDesktopMode",
    ]) {
      await page.locator(`#${key}`).uncheck();
      expect(await page.evaluate((key) => localStorage.getItem(`laymux.remote.${key}`), key)).toBe(
        "0",
      );
    }
    await page.locator("#rightSwipeView").selectOption("memo");
    await page.locator("#navToggle").click();
    for (const id of [
      "fileExplorerHeader",
      "githubHeader",
      "worktreesHeader",
      "memoHeader",
      "spatialExclusion",
      "desktopModeHeader",
    ]) {
      await expect(page.locator(`#${id}`)).toBeHidden();
    }
    await flickRightEdge(page);
    await expect(page.locator("#memoOverlay")).toBeVisible();
    await expect(page.locator("#memoText")).toHaveValue("PC 동시 수정");
    await page.screenshot({ path: "test-results/remote-shared-memo.png" });
    await page.keyboard.press("Escape");
    await expect(page.locator("#memoOverlay")).toBeHidden();
    await page.reload();
    await expect(page.locator("#memoHeader")).toBeHidden();
    await page.locator("#navToggle").click();
    await page.locator("#drawerSettingsButton").click();
    await page.locator("#settingsTabPanels").click();
    await expect(page.locator("#headerMemo")).not.toBeChecked();
    await expect(page.locator("#rightSwipeView")).toHaveValue("memo");
    await page.screenshot({ path: "test-results/remote-panels-settings.png" });
  });

  test("the GitHub toolbar shares the Remote toolbar size tokens", async ({ context, page }) => {
    await installMocks(context);
    await connect(page);
    await page.locator("#githubHeader").click();
    await expect(page.locator("#githubToolbar")).toBeVisible();

    const bar = await page.locator("#githubToolbar").evaluate((toolbar) => ({
      height: toolbar.getBoundingClientRect().height,
      buttons: [...toolbar.querySelectorAll<HTMLElement>("button")]
        .filter((button) => button.offsetParent !== null)
        .map((button) => {
          const icon = button.querySelector("svg")?.getBoundingClientRect();
          return {
            id: button.id,
            height: button.getBoundingClientRect().height,
            icon: icon ? [icon.width, icon.height] : null,
          };
        }),
    }));
    expect(bar.height).toBe(40);
    expect(bar.buttons.length).toBeGreaterThan(0);
    for (const button of bar.buttons) {
      expect(button.height, button.id).toBe(32);
      if (button.icon) expect(button.icon, button.id).toEqual([16, 16]);
    }
  });

  test("opens beside Explorer and provides the desktop list actions", async ({ context, page }) => {
    const requests = await installMocks(context);
    await connect(page);

    await expect(page.locator("#fileExplorerHeader + #githubHeader")).toBeVisible();
    await page.locator("#githubHeader").click();
    await expect(page.locator("#githubOverlay")).toBeVisible();
    await expect(page.locator("#githubRepo")).toHaveText("owner/repo");
    await expect(page.locator('.github-row[data-github-number="17"]')).toContainText(
      "Mobile GitHub view",
    );
    expect(requests.snapshotRequests).toEqual(["?force=false"]);

    await page.locator("#githubPullsTab").click();
    const pull = page.locator('.github-row[data-github-number="18"]');
    await expect(pull).toContainText("DRAFT");
    await expect(pull.getByRole("button", { name: "Copy branch" })).toBeVisible();
    await pull.getByRole("button", { name: "GitHub actions" }).click();
    await pull.getByRole("button", { name: "Squash and merge" }).click();
    await expect(pull.getByRole("button", { name: "Confirm" })).toBeVisible();
    expect(requests.actionRequests).toEqual([]);
    await pull.getByRole("button", { name: "Confirm" }).click();
    await expect
      .poll(() => requests.actionRequests)
      .toEqual([{ leaseId: "lease-257", cwd: "/work/repo", action: "pr.squash", number: 18 }]);
    await expect.poll(() => requests.snapshotRequests.at(-1)).toBe("?force=true");
  });

  test("persists GitHub as the device-local right swipe target", async ({ context, page }) => {
    await installMocks(context);
    await connect(page);

    await page.locator("#navToggle").click();
    await page.locator("#drawerSettingsButton").click();
    await page.locator("#settingsTabPanels").click();
    await page.locator("#rightSwipeView").selectOption("github");
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("laymux.remote.rightSwipeView")))
      .toBe("github");
    await page.locator("#navToggle").click();

    await flickRightEdge(page);
    await expect(page.locator("#githubOverlay")).toBeVisible();
    await expect(page.locator("#fileViewerOverlay")).toBeHidden();
  });
});
