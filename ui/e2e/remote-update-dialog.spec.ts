import { expect, test } from "@playwright/test";

import { installRemoteClientRoutes } from "./remote-client-assets";

for (const origin of ["https://remote.laymux.invalid", "http://remote.test"]) {
  test(`업데이트 제목은 내부 주소나 물음표 없이 연결된 PC를 가리킨다: ${origin}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installRemoteClientRoutes(page, origin);
    await page.route(`${origin}/remote/v1/update`, (route) =>
      route.fulfill({
        json: {
          enabled: true,
          currentVersion: "1.0.21",
          availableVersion: null,
          channel: "beta",
          operation: "idle",
          exitSettings: { interruptTerminals: false },
        },
      }),
    );
    await page.goto(`${origin}/remote/`);
    await page.locator("#drawerBack").click();
    await page.locator("#drawerSettingsButton").click();
    await page.getByRole("tab", { name: "App", exact: true }).click();
    await page.getByRole("button", { name: "Open update", exact: true }).click();

    const dialog = page.getByRole("dialog", { name: "Connected PC update" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading")).toHaveText("Connected PC update");
    await expect(dialog.locator(".lifecycle-version")).toContainText("1.0.21");
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await page.screenshot({
      path: `../.screenshots/remote-update-${new URL(origin).hostname}.png`,
    });
  });
}
