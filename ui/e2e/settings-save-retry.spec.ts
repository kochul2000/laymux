import { test, expect } from "./fixtures";

test("저장 실패 후 오류가 사라지지 않고 같은 값으로 재시도할 수 있다", async ({
  appPage: page,
}, info) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.keyboard.press("Control+,");
  await page.evaluate(() => {
    const target = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: unknown) => Promise<unknown> };
      __restoreSave?: () => void;
    };
    const original = target.__TAURI_INTERNALS__.invoke;
    let fail = true;
    target.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (
        command === "get_terminal_cwds" ||
        command === "get_terminal_session_attributions" ||
        command === "load_terminal_display_contexts"
      )
        return Promise.resolve({});
      if (command === "save_settings" && fail) return Promise.reject(new Error("disk full"));
      return original(command, args);
    };
    target.__restoreSave = () => {
      fail = false;
    };
  });
  await page.getByTestId("app-theme-select").selectOption({ index: 1 });
  await page.getByTestId("save-settings-btn").click();
  await expect(page.locator(".settings-save-bar")).toContainText(/Error|failed/);
  await page.waitForTimeout(2200);
  await page.getByTestId("settings-view").screenshot({ path: info.outputPath("save-retry.png") });
  await expect(page.getByTestId("save-settings-btn")).toBeEnabled();
  await expect(page.locator(".settings-save-bar")).toContainText("disk full");
  await page.evaluate(() => (window as unknown as { __restoreSave: () => void }).__restoreSave());
  await page.getByTestId("save-settings-btn").click();
  await expect(page.getByTestId("save-settings-btn")).toBeDisabled();
  await expect(page.locator(".settings-save-bar")).toContainText("Saved");
});
