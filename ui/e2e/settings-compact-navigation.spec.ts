import { test, expect } from "./fixtures";

for (const language of ["en", "ko"]) {
  test(`320px 설정에서도 ${language} 분류를 이름으로 선택하고 입력칸 폭을 확보한다`, async ({
    appPage: page,
  }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.keyboard.press("Control+,");
    await page.evaluate(() => {
      const target = window as unknown as {
        __TAURI_INTERNALS__: { invoke: (command: string, args: unknown) => Promise<unknown> };
      };
      const original = target.__TAURI_INTERNALS__.invoke;
      target.__TAURI_INTERNALS__.invoke = (command, args) =>
        command === "list_pty_sessions"
          ? Promise.resolve({
              daemonRunning: false,
              currentDaemon: null,
              sessions: [],
              unavailableDaemons: [],
            })
          : original(command, args);
    });
    await page.getByTestId("language-select").selectOption(language);
    const settings = page.getByTestId("settings-view");
    await settings.evaluate((element) => {
      element.style.width = "320px";
    });
    const navigation = page.getByTestId("compact-settings-section");
    await expect(navigation).toBeVisible();
    expect(
      (await page.getByTestId("app-theme-select").boundingBox())!.width,
    ).toBeGreaterThanOrEqual(230);
    for (const section of ["claude", "codex", "grok", "terminal", "ptySessions", "startup"]) {
      await navigation.selectOption(section);
      await expect(navigation).toHaveValue(section);
      await expect(
        section === "ptySessions"
          ? page.getByTestId("pty-sessions-panel")
          : settings.locator(".settings-page__title"),
      ).toBeInViewport();
    }
    await expect(page.getByTestId("compact-open-json")).toBeVisible();
    await expect(page.getByTestId("save-settings-btn")).toBeInViewport();
    expect(await settings.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  });
}

test("작은 설정의 프로필 작업도 초안과 삭제 확인을 유지한다", async ({ appPage: page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.keyboard.press("Control+,");
  const settings = page.getByTestId("settings-view");
  await settings.evaluate((el) => {
    el.style.width = "320px";
  });
  const selection = page.getByTestId("compact-settings-section");
  const before = await selection.locator('option[value^="profile-"]').count();
  const theme = page.getByTestId("app-theme-select");
  const original = await theme.inputValue();
  await theme.selectOption({ index: 1 });
  await page.getByTestId("compact-add-profile").click();
  await expect(selection.locator('option[value^="profile-"]')).toHaveCount(before + 1);
  await selection.selectOption(`profile-${before}`);
  const remove = page.getByTestId("compact-remove-profile");
  await remove.click();
  await expect(remove).toHaveAttribute("data-confirming", "true");
  await expect(selection.locator('option[value^="profile-"]')).toHaveCount(before + 1);
  await remove.click();
  await expect(selection).toHaveValue("startup");
  await expect(selection.locator('option[value^="profile-"]')).toHaveCount(before);
  await expect(theme).not.toHaveValue(original);
  await expect(page.getByTestId("save-settings-btn")).toBeEnabled();
});
