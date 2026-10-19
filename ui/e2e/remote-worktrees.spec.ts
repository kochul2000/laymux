import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { fulfillRemoteClientAsset } from "./remote-client-assets";

const main = {
  path: "/work/main",
  branch: "main",
  head: "abc123",
  isMain: true,
  bare: false,
  usage: [],
};
const clean = { ...main, path: "/work/clean", branch: "feature", isMain: false };
const dirty = { ...clean, path: "/work/dirty", branch: "notes" };
const used = { ...clean, path: "/work/used", branch: "running" };
const snapshot = {
  workingDir: main.path,
  repositoryPath: main.path,
  commonDir: "/work/main/.git",
  worktrees: [main, clean, dirty, used],
  usageWarnings: [],
};

async function installMocks(context: BrowserContext, fileCount = 1) {
  const requests: Array<{ route: string; body: Record<string, unknown> }> = [];
  let removed = false;
  let inspectionHold: Promise<void> | undefined;
  let rejectRemove = false;
  const pane = (id: string, number: number) => ({
    id: `pane-${id}`,
    location: "workspace",
    workspaceId: "ws",
    paneIndex: number - 1,
    paneNumber: number,
    viewType: "TerminalView",
    terminalId: `terminal-${id}`,
    terminalLive: true,
    title: id === "1" ? "Shell" : "Other shell",
    profile: "PowerShell",
    cwd: main.path,
    activity: { type: "shell" },
    isFocused: number === 1,
    hidden: false,
    collapsed: false,
    x: number - 1,
    y: 0,
    w: 1,
    h: 1,
  });
  const panes = [pane("1", 1), pane("2", 2)];
  await context.route("http://remote.test/remote/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (await fulfillRemoteClientAsset(route, path)) return;
    const body = JSON.parse(request.postData() || "{}");
    if (path.includes("/worktrees")) {
      requests.push({ route: path, body });
      expect(body.leaseId).toBe("lease-worktrees");
      if (path.endsWith("/inspect")) {
        if (inspectionHold) await inspectionHold;
        const entry = snapshot.worktrees.find((row) => row.path === body.path)!;
        const blockers = entry.isMain
          ? ["main"]
          : entry === dirty
            ? ["untracked_files"]
            : entry === used
              ? ["in_use"]
              : [];
        return route.fulfill({
          json: {
            success: true,
            data: {
              worktree: entry,
              trackedChanges: 0,
              untrackedFiles: entry === dirty ? 1 : 0,
              ignoredFiles: 0,
              files:
                entry === dirty
                  ? Array.from({ length: fileCount }, (_, i) => ({
                      kind: "untracked",
                      path: i ? `notes-${i}.txt` : "notes.txt",
                    }))
                  : [],
              filesTruncated: false,
              canRemove: blockers.length === 0,
              blockers,
              usageWarnings: [],
              usage:
                entry === used
                  ? [
                      {
                        terminalId: "terminal-2",
                        paneId: "pane-2",
                        workspaceId: "ws",
                        workspaceName: "개발",
                        cwd: used.path,
                        kind: "live",
                        agentType: "codex",
                      },
                    ]
                  : [],
            },
          },
        });
      }
      if (path.endsWith("/remove")) {
        if (rejectRemove)
          return route.fulfill({ status: 409, json: { error: "사용 중인 터미널 발견" } });
        removed = true;
        return route.fulfill({ json: { success: true, data: null } });
      }
      return route.fulfill({
        json: {
          success: true,
          cwd: main.path,
          data: {
            ...snapshot,
            worktrees: snapshot.worktrees.filter((row) => !removed || row !== clean),
          },
        },
      });
    }
    if (path === "/remote/v1/session/claim")
      return route.fulfill({
        json: {
          active: true,
          leaseId: "lease-worktrees",
          resumeToken: "resume-worktrees",
          fileViewerToken: "viewer-worktrees",
          heartbeatTimeoutSeconds: 45,
        },
      });
    if (["/remote/v1/session/heartbeat", "/remote/v1/session/release"].includes(path))
      return route.fulfill({ json: { ok: true } });
    if (path === "/remote/v1/navigation")
      return route.fulfill({
        json: {
          activeWorkspace: { id: "ws", name: "개발", panes },
          workspaces: [{ id: "ws", name: "개발", isActive: true, hidden: false, panes }],
          docks: [],
          terminals: panes.map((row) => ({
            id: row.terminalId,
            title: row.title,
            profile: row.profile,
            cwd: row.cwd,
            workspaceId: "ws",
            paneNumber: row.paneNumber,
            appearance: { fontFamily: "monospace", cursorStyle: "bar", cursorWidth: 1, theme: {} },
          })),
          workspaceSelector: { display: {}, pathEllipsis: "start" },
          notifications: [],
          unreadNotificationCount: 0,
        },
      });
    if (path.endsWith("/github-repo"))
      return route.fulfill({ json: { cwd: main.path, repoBase: null } });
    if (path.endsWith("/focus")) {
      requests.push({ route: path, body });
      return route.fulfill({ json: { ok: true } });
    }
    if (path === "/remote/v1/file-viewer/render")
      return route.fulfill({
        json: {
          kind: "text",
          path: "/work/dirty/notes.txt",
          content: "원문 내용",
          truncated: false,
        },
      });
    if (path === "/remote/v1/memos") return route.fulfill({ json: { memos: [], count: 0 } });
    return route.fulfill({ status: 404, json: { error: "not mocked" } });
  });
  await context.routeWebSocket(/\/remote\/v1\/terminals\/terminal-[12]\/output/, () => {});
  return {
    requests,
    holdInspection: () => {
      let release!: () => void;
      inspectionHold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        inspectionHold = undefined;
        release();
      };
    },
    rejectRemove: () => {
      rejectRemove = true;
    },
  };
}

async function connect(page: Page) {
  await page.goto("http://remote.test/remote/");
  await expect(page.locator("#worktreesHeader")).toBeHidden();
  await page.locator("#token").fill("remote-secret");
  await page.locator("#connect").click();
  await expect(page.locator("#worktreesHeader")).toBeVisible();
  await page.locator("#worktreesHeader").click();
  await expect(page.locator('[data-worktree-path="/work/clean"]')).toBeVisible();
}

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test("Remote 후보·상세·명시적 제거와 모바일 컨트롤 배치", async ({ context, page }) => {
  const mock = await installMocks(context);
  await connect(page);
  await expect(page.locator("#worktreesCandidates")).toContainText("1");
  await page.screenshot({ path: "test-results/remote-worktrees-mobile-list.png" });
  await page.locator("#worktreesCandidates").click();
  await expect(page.locator('[data-worktree-path="/work/dirty"]')).toHaveCount(0);
  await page.locator('[data-worktree-path="/work/clean"]').click();
  await page.getByRole("button", { name: "워크트리 제거", exact: true }).click();
  expect(mock.requests.some((request) => request.route.endsWith("/remove"))).toBe(false);
  await expect(page.locator("#worktreesDetail")).toContainText("브랜치는 유지");
  await page.screenshot({ path: "test-results/remote-worktrees-mobile-confirm.png" });
  await page.getByRole("button", { name: "제거 확인", exact: true }).click();
  await expect
    .poll(() => mock.requests.filter((request) => request.route.endsWith("/remove")).length)
    .toBe(1);
  expect(mock.requests.find((request) => request.route.endsWith("/remove"))?.body).toEqual({
    leaseId: "lease-worktrees",
    cwd: main.path,
    path: clean.path,
    expectedHead: clean.head,
  });
  await expect(page.locator('[data-worktree-path="/work/clean"]')).toHaveCount(0);
  const toolbar = (await page.locator("#worktreesToolbar").boundingBox())!;
  expect(toolbar.y).toBeGreaterThan(700);
  expect(
    await page
      .locator("#worktreesOverlay")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
});

test("사용 중 보호·기존 파일 뷰어·사용 터미널 이동", async ({ context, page }) => {
  const mock = await installMocks(context);
  await connect(page);
  await page.locator('[data-worktree-path="/work/dirty"]').click();
  await expect(page.getByRole("button", { name: "워크트리 제거", exact: true })).toBeDisabled();
  await page.getByText("변경 파일 목록 (1)", { exact: true }).click();
  await page.getByRole("button", { name: "미추적 · notes.txt", exact: true }).click();
  await expect(page.locator("#fileViewerOverlay")).toBeVisible();
  await expect(page.locator("#worktreesOverlay")).toBeHidden();
  await page.locator("#fileViewerClose").click();
  await expect(page.locator("#worktreesOverlay")).toBeVisible();
  await expect(page.locator("#worktreesDetail")).toContainText(dirty.path);
  await expect(page.locator("#worktreesList")).toBeHidden();
  await page.getByRole("button", { name: "상세 닫기", exact: true }).click();
  await page.locator('[data-worktree-path="/work/used"]').click();
  await expect(page.getByRole("button", { name: "워크트리 제거", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: /개발.*codex/ }).click();
  await expect
    .poll(() =>
      mock.requests.some((request) => request.route === "/remote/v1/terminals/terminal-2/focus"),
    )
    .toBe(true);
  await expect(page.locator("#worktreesOverlay")).toBeHidden();
});

test("닫은 뒤 도착한 응답을 버리고 제거 거부 후 이전 확인을 재사용하지 않는다", async ({
  context,
  page,
}) => {
  const mock = await installMocks(context);
  await connect(page);
  await expect(page.locator("#worktreesCandidates")).toContainText("1");
  const release = mock.holdInspection();
  await page.locator('[data-worktree-path="/work/clean"]').click();
  await page.locator("#worktreesClose").click();
  release();
  await expect(page.locator("#worktreesOverlay")).toBeHidden();
  await page.locator("#worktreesHeader").click();
  await page.locator('[data-worktree-path="/work/clean"]').click();
  await page.getByRole("button", { name: "워크트리 제거", exact: true }).click();
  mock.rejectRemove();
  await page.getByRole("button", { name: "제거 확인", exact: true }).click();
  await expect(page.locator("#worktreesDetail")).toContainText("사용 중인 터미널 발견");
  await expect(page.getByRole("button", { name: "제거 확인", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "워크트리 제거", exact: true })).toHaveCount(0);
});

test("헤더를 숨겨도 기기별 Worktrees 가장자리 바로가기로 열고 Back으로 닫는다", async ({
  context,
  page,
}) => {
  await installMocks(context);
  await context.addInitScript(() => {
    localStorage.setItem("laymux.remote.headerWorktrees", "0");
    localStorage.setItem("laymux.remote.rightSwipeView", "worktrees");
  });
  await page.goto("http://remote.test/remote/");
  await page.locator("#token").fill("remote-secret");
  await page.locator("#connect").click();
  await expect(page.locator("#githubHeader")).toBeVisible();
  await expect(page.locator("#worktreesHeader")).toBeHidden();
  await page.locator("#terminal .xterm").evaluate((element) => {
    const target = element as HTMLElement;
    const rect = target.getBoundingClientRect();
    target.setPointerCapture = () => {};
    target.releasePointerCapture = () => {};
    target.hasPointerCapture = () => false;
    for (const [type, delta] of [
      ["pointerdown", 0],
      ["pointermove", 100],
      ["pointerup", 100],
    ] as const) {
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 77,
          pointerType: "touch",
          isPrimary: true,
          clientX: rect.right - 1 - delta,
          clientY: rect.top + rect.height / 2,
        }),
      );
    }
  });
  await expect(page.locator("#worktreesOverlay")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#worktreesOverlay")).toBeHidden();
  await page.locator("#navToggle").click();
  await page.locator("#drawerSettingsButton").click();
  await page.locator("#settingsTabPanels").click();
  await expect(page.locator("#headerWorktrees")).not.toBeChecked();
  await expect(page.locator("#rightSwipeView")).toHaveValue("worktrees");
});

test("파일이 많은 모바일 상세에서도 닫기는 화면 안에 남는다", async ({ context, page }) => {
  await installMocks(context, 24);
  await connect(page);
  await page.locator('[data-worktree-path="/work/dirty"]').click();
  await page.getByText("변경 파일 목록 (24)", { exact: true }).click();
  const content = page.locator("#worktreesOverlay .github-list");
  await content.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const close = page.getByRole("button", { name: "상세 닫기", exact: true });
  const closeBox = (await close.boundingBox())!;
  const contentBox = (await content.boundingBox())!;
  expect(closeBox.y).toBeGreaterThanOrEqual(contentBox.y);
  await close.click();
  await expect(page.locator("#worktreesList")).toBeVisible();
});
