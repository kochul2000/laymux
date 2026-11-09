import { expect, test } from "@playwright/test";
import { installRemoteClientRoutes } from "./remote-client-assets";

test("불투명도 순서와 연동 조정을 해당 입력 옆에서 설명한다", async ({ page }) => {
  await installRemoteClientRoutes(page);
  await page.goto("http://remote.test/remote/");
  await page.locator("#drawerBack").click();
  await page.locator("#drawerSettingsButton").click();
  await page.getByRole("tab", { name: "Display", exact: true }).click();
  await expect(page.locator("#remoteComposerOpacityHint")).toContainText("Idle ≤ Focused ≤ Active");
  await page.locator("#remoteComposerActiveOpacity").fill("40");
  await page.locator("#remoteComposerActiveOpacity").press("Tab");
  await expect(page.locator("#remoteComposerOpacityStatus")).toContainText(
    "Also adjusted: Idle 40%, Focused 40%.",
  );
  await expect(page.locator("#remoteComposerIdleOpacity")).toHaveValue("40");
  await expect(page.locator("#remoteComposerFocusedOpacity")).toHaveValue("40");
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem("laymux.remote.displaySettings")!)),
  ).toMatchObject({
    composerIdleOpacity: 40,
    composerFocusedOpacity: 40,
    composerActiveOpacity: 40,
  });
  await page.reload();
  await page.locator("#drawerBack").click();
  await page.locator("#drawerSettingsButton").click();
  await expect(page.locator("#remoteComposerActiveOpacity")).toHaveValue("40");
});
