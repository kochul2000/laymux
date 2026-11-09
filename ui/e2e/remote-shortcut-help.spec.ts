import { expect, test } from "@playwright/test";
import { installRemoteClientRoutes } from "./remote-client-assets";

test("단축키 도움말은 입력 설정에서 요청할 때만 펼치고 App에서는 제외한다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installRemoteClientRoutes(page);
  await page.goto("http://remote.test/remote/");
  await page.locator("#drawerBack").click();
  await page.locator("#drawerSettingsButton").click();
  await page.getByRole("tab", { name: "App", exact: true }).click();
  await expect(page.locator("#settingsPanelApp #keyboardShortcutList")).toHaveCount(0);
  await page.getByRole("tab", { name: "Input", exact: true }).click();
  await page.locator("#physicalKeyboardSection > summary").click();
  const help = page.locator("#keyboardShortcutsSection");
  await expect(help).not.toHaveAttribute("open", "");
  await expect(page.locator("#keyboardShortcutList")).toBeHidden();
  await help.locator("summary").click();
  await expect(page.locator("#keyboardShortcutList")).toBeVisible();
  await expect(page.locator("#keyboardShortcutList dt")).toHaveCount(26);
  await help.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#keyboardShortcutList")).toBeHidden();
});
