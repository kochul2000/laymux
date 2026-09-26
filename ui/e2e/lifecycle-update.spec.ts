import { expect, test } from "@playwright/test";
import { installRemoteClientRoutes } from "./remote-client-assets";

for (const width of [320, 390]) {
  test(`Remote 업데이트 모달은 ${width}px에서 준비 상태를 표시하고 배경을 차단한다`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await installRemoteClientRoutes(page);
    const status = {
      enabled: true,
      channel: "stable",
      currentVersion: "1.0.14",
      availableVersion: "1.0.15",
      notes: "Shared shutdown and update progress.\nSave terminal history before restarting.",
      operation: "idle",
      downloadedBytes: 0,
      totalBytes: null,
      lastError: null,
      exitSettings: { interruptTerminals: true, interruptRounds: 3, settleMs: 700 },
    };
    await page.route("http://remote.test/remote/v1/update", (route) =>
      route.fulfill({ json: status }),
    );
    await page.route("http://remote.test/remote/v1/update/check", (route) =>
      route.fulfill({
        json: {
          ...status,
          operation: "preparing",
          preparation: { stage: "settling", completed: 350, total: 700 },
        },
      }),
    );
    await page.goto("http://remote.test/remote/");
    await page.locator("#drawerBack").click();
    await page.locator("#drawerSettingsButton").click();
    await page.getByRole("tab", { name: "App", exact: true }).click();
    await page.locator("#checkPcUpdate").click();
    const modal = page.getByRole("dialog", { name: "Connected PC update" });
    await expect(modal).toBeVisible();
    await expect(modal.getByRole("button", { name: "Update and restart" })).toBeDisabled();
    await modal.getByRole("button", { name: "Check for updates" }).click();
    await expect(modal.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
    await page.keyboard.press("Escape");
    await expect(modal).toBeVisible();
    const bounds = await modal.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(await modal.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    if (width === 390) await page.screenshot({ path: "../.screenshots/lifecycle-remote.png" });
  });
}
