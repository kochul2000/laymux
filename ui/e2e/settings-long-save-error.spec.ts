import { test, expect } from "./fixtures";

for (const language of ["en", "ko"]) {
  test(`긴 저장 오류 뒤에도 ${language} 재시도와 편집 영역을 유지한다`, async ({
    appPage: page,
  }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.keyboard.press("Control+,");
    await page.getByTestId("language-select").selectOption(language);
    const settings = page.getByTestId("settings-view");
    await settings.evaluate((el) => {
      el.style.width = "320px";
    });
    await page.evaluate(() => {
      const target = window as unknown as {
        __TAURI_INTERNALS__: { invoke: (command: string, args: unknown) => Promise<unknown> };
      };
      const original = target.__TAURI_INTERNALS__.invoke;
      target.__TAURI_INTERNALS__.invoke = (command, args) => {
        if (
          [
            "get_terminal_cwds",
            "get_terminal_session_attributions",
            "load_terminal_display_contexts",
          ].includes(command)
        )
          return Promise.resolve({});
        if (command === "save_settings")
          return Promise.reject(
            new Error("PermissionDenied_" + "very_long_directory_name_".repeat(20)),
          );
        return original(command, args);
      };
    });
    await page.getByTestId("app-theme-select").selectOption({ index: 1 });
    await page.getByTestId("save-settings-btn").click();
    await expect(settings.locator('[role="alert"]')).toContainText("PermissionDenied");
    await settings.screenshot({ path: test.info().outputPath(`error-${language}.png`) });
    const status = settings.locator('[role="alert"]');
    const statusBox = (await status.boundingBox())!;
    const barBox = (await settings.locator(".settings-save-bar").boundingBox())!;
    expect(statusBox.x).toBeGreaterThanOrEqual(barBox.x);
    expect(statusBox.x + statusBox.width).toBeLessThanOrEqual(barBox.x + barBox.width);
    const retry = page.getByTestId("save-settings-btn");
    await expect(retry).toBeInViewport();
    expect(await settings.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect((await settings.locator(".settings-fields").boundingBox())!.height).toBeGreaterThan(200);
    await status.focus();
    await page.keyboard.press("End");
    await expect.poll(() => status.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  });
}
