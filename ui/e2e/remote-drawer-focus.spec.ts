import { expect, test } from "@playwright/test";
import { installRemoteClientRoutes } from "./remote-client-assets";

test("닫힌 메뉴에 Tab이 들어가지 않고 닫으면 메뉴 버튼으로 복귀한다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installRemoteClientRoutes(page);
  await page.goto("http://remote.test/remote/");
  const menu = page.locator("#navToggle");
  const drawer = page.locator("#navigationPanel");
  await page.locator("#drawerBack").click();
  await page.locator("#navScrim").click({ position: { x: 380, y: 100 } });
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await expect(drawer).toHaveJSProperty("inert", true);
  await menu.focus();
  await page.keyboard.press("Tab");
  expect(await drawer.evaluate((el) => el.contains(document.activeElement))).toBe(false);
  await menu.focus();
  await page.keyboard.press("Enter");
  await expect(drawer).toHaveJSProperty("inert", false);
  await expect(page.locator("#navigationPin")).toBeFocused();
  await page.locator("#drawerSettingsButton").click();
  await page.locator("#drawerBack").click();
  await expect(drawer).toHaveJSProperty("inert", false);
  await page.locator("#navigationPin").focus();
  await page.evaluate(() =>
    (
      window as Window & { laymuxRemoteUi: { dismissTopLayer: () => boolean } }
    ).laymuxRemoteUi.dismissTopLayer(),
  );
  await expect(menu).toBeFocused();
  await expect(drawer).toHaveJSProperty("inert", true);
});
