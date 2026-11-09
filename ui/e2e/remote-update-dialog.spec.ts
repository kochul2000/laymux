import { expect, test } from "@playwright/test";

import { installRemoteClientRoutes } from "./remote-client-assets";

test("언어를 바꿔도 다운로드 진행률과 막대를 보존한다", async ({ page }) => {
  await installRemoteClientRoutes(page);
  await page.route("http://remote.test/remote/v1/update", (route) =>
    route.fulfill({
      json: {
        enabled: true,
        currentVersion: "1.0.0",
        availableVersion: "1.1.0",
        channel: "stable",
        operation: "downloading",
        downloadedBytes: 50,
        totalBytes: 100,
      },
    }),
  );
  await page.goto("http://remote.test/remote/");
  await page.locator("#drawerBack").click();
  await page.locator("#drawerSettingsButton").click();
  const dialog = page.locator(".remote-update-dialog");
  const bar = dialog.getByRole("progressbar");
  await expect(bar).toHaveAttribute("aria-valuenow", "50");
  const afterChange = await page
    .locator("#remoteLanguage")
    .evaluate((select: HTMLSelectElement) => {
      select.value = "ko";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return {
        bars: document.querySelectorAll('.remote-update-dialog [role="progressbar"]').length,
        detail: document.querySelector(".remote-update-dialog .lifecycle-step-detail")?.textContent,
      };
    });
  await page.screenshot({ path: "test-results/remote-update-language.png" });
  expect(afterChange).toEqual({ bars: 1, detail: "50%" });
  await expect(bar).toHaveAttribute("aria-valuenow", "50");
  await expect(dialog.locator(".lifecycle-step-detail")).toHaveText("50%");
  await expect(bar).toHaveAccessibleName(/[가-힣]/);
});

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
