import { expect, test, type Page } from "@playwright/test";
import { fulfillRemoteClientAsset, installRemoteClientRoutes } from "./remote-client-assets";

async function settings(page: Page) {
  if ((await page.locator("#navToggle").getAttribute("aria-expanded")) !== "true")
    await page.locator("#navToggle").click();
  if (await page.locator("#drawerSettingsButton").isHidden())
    await page.locator("#drawerBack").click();
  await page.locator("#drawerSettingsButton").click();
  await page.locator("#settingsTabApp").click();
}

async function changeWhileToolOpen(page: Page, language: string) {
  // Exercise the actual selector handler without closing the tool being inspected.
  await page.locator("#remoteLanguage").evaluate((select: HTMLSelectElement, value) => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, language);
}

for (const locale of ["ko-KR", "en-US", "fr-FR"]) {
  test.describe(`기기 언어 ${locale}`, () => {
    test.use({ locale });
    test("시스템 기본·명시 선택·새 문서 복원과 접근성 문구를 일치시킨다", async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await installRemoteClientRoutes(page);
      await page.goto("http://remote.test/remote/");
      const ko = locale.startsWith("ko");
      await expect(page.locator("html")).toHaveAttribute("lang", ko ? "ko" : "en");
      await expect(page.locator("#drawerSettingsButton")).toHaveAccessibleName(
        ko ? "설정 열기" : "Open settings",
      );
      await settings(page);
      await expect(page.locator("#remoteLanguage")).toHaveValue("system");
      await page.locator("#remoteLanguage").selectOption(ko ? "en" : "ko");
      await expect(page.locator("html")).toHaveAttribute("lang", ko ? "en" : "ko");
      await expect(page.locator("#settingsTabInputBar")).toHaveText(ko ? "Input" : "입력");
      await expect(page.locator("#memoHeader")).toHaveAttribute(
        "aria-label",
        ko ? "Open shared memos" : "공유 메모 열기",
      );
      await expect(page.locator("#sharedFilesAttach")).toHaveText(
        ko ? "Attach here" : "여기에 첨부",
      );
      await expect(page.locator("#remoteLanguageStatus")).toHaveText(
        ko ? "Saved on this device." : "이 기기에 저장했습니다.",
      );
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("lang", ko ? "en" : "ko");
      await settings(page);
      await expect(page.locator("#remoteLanguage")).toHaveValue(ko ? "en" : "ko");
      await page.locator("#remoteLanguage").selectOption("system");
      await expect(page.locator("html")).toHaveAttribute("lang", ko ? "ko" : "en");
    });
  });
}

test.describe("연결된 Remote의 언어 전환", () => {
  test.use({ locale: "ko-KR" });
  test("초안·사용자 이름·파일 원문·열린 워크트리 선택을 보존한다", async ({ page }) => {
    const pane = {
      id: "p",
      terminalId: "term",
      terminalLive: true,
      location: "workspace",
      workspaceId: "ws",
      paneNumber: 1,
      viewType: "TerminalView",
      title: "Connection",
      profile: "PowerShell",
      cwd: "/Settings/Connection",
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      hidden: false,
    };
    const workspace = { id: "ws", name: "Settings", isActive: true, hidden: false, panes: [pane] };
    const worktree = {
      path: "/Settings/Connection",
      branch: "refs/heads/Settings",
      head: "abcdef123456",
      isMain: false,
      bare: false,
      usage: [],
    };
    let claims = 0;
    let writes = 0;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("http://remote.test/remote/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (await fulfillRemoteClientAsset(route, pathname)) return;
      if (pathname.endsWith("/session/claim")) {
        claims += 1;
        return route.fulfill({
          json: {
            active: true,
            leaseId: "lease",
            fileViewerToken: "viewer",
            resumeToken: "resume",
            heartbeatTimeoutSeconds: 45,
          },
        });
      }
      if (pathname.endsWith("/session/heartbeat")) return route.fulfill({ json: { ok: true } });
      if (pathname.endsWith("/navigation"))
        return route.fulfill({
          json: {
            activeWorkspace: workspace,
            workspaces: [workspace],
            docks: [],
            terminals: [
              {
                id: "term",
                title: "Connection",
                cwd: pane.cwd,
                workspaceId: "ws",
                paneNumber: 1,
                appearance: { fontFamily: "monospace", cursorStyle: "bar", theme: {} },
              },
            ],
            notifications: [],
            unreadNotificationCount: 0,
            workspaceSelector: { display: {} },
          },
        });
      if (pathname.endsWith("/memos")) {
        if (route.request().method() === "POST") writes += 1;
        return route.fulfill({
          json: { memos: [{ key: "memo-settings", content: "Open settings" }], count: 1 },
        });
      }
      if (pathname.endsWith("/worktrees/inspect"))
        return route.fulfill({
          json: {
            success: true,
            data: {
              worktree,
              canRemove: true,
              blockers: [],
              usage: [],
              files: [],
              trackedChanges: 0,
              untrackedFiles: 0,
              ignoredFiles: 0,
            },
          },
        });
      if (pathname.endsWith("/worktrees"))
        return route.fulfill({
          json: {
            success: true,
            cwd: pane.cwd,
            data: { repositoryPath: pane.cwd, worktrees: [worktree], usageWarnings: [] },
          },
        });
      if (pathname.endsWith("/file-viewer/render"))
        return route.fulfill({
          json: {
            kind: "text",
            path: "/Settings/Connection.txt",
            content: "Settings\nOpen settings\n공유 파일 첨부",
            truncated: false,
          },
        });
      if (pathname.endsWith("/github-repo"))
        return route.fulfill({ json: { cwd: pane.cwd, repoBase: null } });
      return route.fulfill({ status: 404, json: { error: "External diagnostic details" } });
    });
    await page.routeWebSocket(/\/output/, () => {});
    await page.goto("http://remote.test/remote/#token=token");
    await page.locator("#connect").click();
    await expect(page.locator("#composerInput")).toHaveAttribute("contenteditable", "true");
    await page.locator("#composerInput").fill("Settings Open settings 공유 파일 첨부");
    await settings(page);
    await page.locator("#remoteLanguage").selectOption("en");
    await expect(page.locator('#mainActionRow [data-key="clearPane"] svg')).toHaveCount(1);
    await expect(page.locator("#composerInput")).toHaveText(
      "Settings Open settings 공유 파일 첨부",
    );
    await expect(page.locator('[data-workspace-item="ws"]')).toContainText("Settings");
    await page.locator("#navToggle").click();
    await page.locator("#memoHeader").click();
    await expect(page.locator("#memoText")).toHaveValue("Open settings");
    await page.locator("#memoText").fill("Settings\nConnection\n공유 파일 첨부");
    await page
      .locator("#memoText")
      .evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(2, 7));
    await changeWhileToolOpen(page, "ko");
    await expect(page.locator("#memoStatus")).toHaveText("저장하지 않은 변경 · PC와 공유됨");
    await expect(page.locator("#memoText")).toHaveValue("Settings\nConnection\n공유 파일 첨부");
    expect(
      await page
        .locator("#memoText")
        .evaluate((element: HTMLTextAreaElement) => element.selectionStart),
    ).toBe(2);
    await expect(page.locator("#memoText")).toBeFocused();
    await page.locator("#memoClose").click();
    await page.locator("#worktreesHeader").click();
    await page.locator("[data-worktree-path]").click();
    await expect(page.getByRole("button", { name: "워크트리 제거", exact: true })).toBeVisible();
    await changeWhileToolOpen(page, "en");
    await expect(page.getByRole("button", { name: "Remove worktree", exact: true })).toBeVisible();
    await expect(page.locator("#worktreesDetail")).toContainText(
      "Changed 0 · Untracked 0 · Ignored 0",
    );
    await expect(page.locator("#worktreesDetail")).toContainText("/Settings/Connection");
    await page.locator("#worktreesClose").click();
    await page.locator("#fileExplorerHeader").click();
    await page.locator("#fileViewerPath").fill("/Settings/Connection.txt");
    await page.locator("#openFileViewer").click();
    await expect(page.locator("#fileViewerText")).toHaveText(
      "Settings\nOpen settings\n공유 파일 첨부",
    );
    await changeWhileToolOpen(page, "ko");
    await expect(page.locator("#fileViewerText")).toHaveText(
      "Settings\nOpen settings\n공유 파일 첨부",
    );
    await expect(page.locator("#fileViewerClose")).toHaveAccessibleName("호스트 파일 닫기");
    await page.locator("#fileViewerClose").click();
    await changeWhileToolOpen(page, "en");
    await page.locator("#memoHeader").click();
    await expect(page.locator("#memoText")).toHaveValue("Settings\nConnection\n공유 파일 첨부");
    await expect(page.locator("#memoStatus")).toHaveText("Unsaved changes · shared with PC");
    expect(claims).toBe(1);
    expect(writes).toBe(0);
    expect(errors).toEqual([]);
  });
});
