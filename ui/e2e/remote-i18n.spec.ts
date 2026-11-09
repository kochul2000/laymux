import { expect, test, type Page } from "@playwright/test";
import { fulfillRemoteClientAsset, installRemoteClientRoutes } from "./remote-client-assets";

test.describe("Floating 설정의 언어 전환", () => {
  test.use({ locale: "en-US" });
  test("플로팅 패드의 이동 안내도 언어 전환 뒤 유지한다", async ({ page }) => {
    await installRemoteClientRoutes(page);
    await page.goto("http://remote.test/remote/");
    await settings(page);
    await page.locator("#settingsTabFloating").click();
    await expect(
      page.getByRole("checkbox", { name: "Arrow pad Enabled", exact: true }),
    ).toBeChecked();
    const pad = page.locator('#floatingControls [data-key="dpad"]');
    await expect(pad).toHaveAttribute("title", /hold center to move/);
    await changeWhileToolOpen(page, "ko");
    await expect(pad).toHaveAttribute("title", /가운데를 길게 눌러 이동/);
    await changeWhileToolOpen(page, "en");
    await expect(pad).toHaveAttribute("title", /hold center to move/);
  });
  test("동작 선택의 번역과 선택값을 함께 유지한다", async ({ page }) => {
    await installRemoteClientRoutes(page);
    await page.goto("http://remote.test/remote/");
    await settings(page);
    await page.locator("#settingsTabFloating").click();
    const picker = page.locator("#floatingSettingsEditor > select");
    const action = await picker
      .getByRole("option", { name: "Keyboard", exact: true })
      .getAttribute("value");
    await picker.selectOption(action!);
    await page.locator("#settingsTabApp").click();
    await page.locator("#remoteLanguage").selectOption("ko");
    await page.locator("#settingsTabFloating").click();
    await expect(picker).toHaveValue(action!);
    await expect(picker.getByRole("option", { name: "키보드", exact: true })).toHaveCount(1);
  });

  test("원시 시퀀스의 Enter 문구를 번역하며 초안과 체크 상태를 유지한다", async ({ page }) => {
    await installRemoteClientRoutes(page);
    await page.goto("http://remote.test/remote/");
    await settings(page);
    await page.locator("#settingsTabInputBar").click();
    await page.locator("#inputCustomKey > summary").click();
    await page.getByRole("combobox", { name: "Custom key kind" }).selectOption("raw");
    const fields = page.locator('#inputCustomKey input[type="text"]');
    await fields.first().fill("Settings");
    await fields.last().fill("\\e[15~");
    const enter = page.locator('#inputCustomKey input[type="checkbox"]');
    await enter.check();
    await page.locator("#settingsTabApp").click();
    await page.locator("#remoteLanguage").selectOption("ko");
    await page.locator("#settingsTabInputBar").click();
    await expect(enter).toHaveAccessibleName("Enter 전송");
    await expect(enter).toBeChecked();
    await expect(fields.first()).toHaveValue("Settings");
    await expect(fields.last()).toHaveValue("\\e[15~");
  });

  test("언어를 바꿔도 입력 컨트롤과 편집 값을 보존한다", async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installRemoteClientRoutes(page);
    await page.goto("http://remote.test/remote/");
    await settings(page);
    await page.locator("#settingsTabFloating").click();
    const inputs = page.locator("#floatingSettingsEditor .floating-setting input");
    await expect(inputs).toHaveCount(6);
    const size = page.locator('#floatingSettingsEditor input[type="number"]').first();
    await size.fill("88");
    await size.press("Tab");
    await page.locator("#settingsTabApp").click();
    await page.locator("#remoteLanguage").selectOption("ko");
    await page.locator("#settingsTabFloating").click();
    await page.screenshot({ path: info.outputPath("floating-language.png") });
    await expect(inputs).toHaveCount(6);
    await expect(size).toHaveValue("88");
    await expect(inputs.first()).toHaveAccessibleName(/[가-힣]/);
    await page.locator("#settingsTabApp").click();
    await page.locator("#remoteLanguage").selectOption("en");
    await page.locator("#settingsTabFloating").click();
    await expect(inputs).toHaveCount(6);
    await expect(size).toHaveValue("88");
    await expect(inputs.first()).toHaveAccessibleName(/Arrow pad/);
  });
});

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
