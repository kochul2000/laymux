import { expect, test } from "@playwright/test";
import { installRemoteClientRoutes } from "./remote-client-assets";

test("Composer의 동작과 모양을 한곳에서 편집하고 키보드는 선택해서 펼친다", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installRemoteClientRoutes(page);
  await page.goto("http://remote.test/remote/");
  await page.locator("#drawerBack").click();
  await page.locator("#drawerSettingsButton").click();
  await page.getByRole("tab", { name: "Composer", exact: true }).click();
  await page.screenshot({ path: info.outputPath("composer-groups.png") });
  await expect(page.locator("#remoteComposerFontSize")).toBeVisible();
  await expect(page.locator("#remoteComposerActiveOpacity")).toBeVisible();
  await page.locator("#remoteComposerFontSize").fill("22");
  await page.locator("#remoteComposerFontSize").press("Tab");
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem("laymux.remote.displaySettings")!).composerFontSize,
      ),
    )
    .toBe(22);
  await page.locator('#settingsTabs [data-settings-panel="inputBar"]').click();
  await expect(page.locator("#physicalKeyboardSection")).not.toHaveAttribute("open", "");
  await expect(page.locator("#inputLayoutEditor")).toBeVisible();
  await page.locator("#physicalKeyboardSection > summary").click();
  await page.locator("#keyboardShortcutsSection > summary").click();
  await expect(page.locator("#keyboardShortcutList")).toBeVisible();
});
