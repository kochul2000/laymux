import { expect, test } from "@playwright/test";

import { installRemoteClientRoutes } from "./remote-client-assets";

for (const [width, drawerWidth] of [
  [320, 360],
  [390, 360],
  [1024, 720],
  [320, 200],
]) {
  test(`Remote 설정은 ${width}px 화면·${drawerWidth}px 메뉴에서 읽기 쉬운 행과 잘리지 않는 컨트롤을 유지한다`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await installRemoteClientRoutes(page);
    await page.addInitScript((navigationWidth) => {
      localStorage.setItem("laymux.remote.displaySettings", JSON.stringify({ navigationWidth }));
    }, drawerWidth);
    await page.goto("http://remote.test/remote/");
    await page.locator("#drawerBack").click();
    await page.locator("#drawerSettingsButton").click();
    await page.getByRole("tab", { name: "Display", exact: true }).click();

    const input = page.locator("#remoteTerminalFontSize");
    await expect(input).toBeEnabled();
    expect((await input.boundingBox())!.height).toBeGreaterThanOrEqual(36);
    const type = await page.locator('label[for="remoteTerminalFontSize"]').evaluate((row) => ({
      label: parseFloat(getComputedStyle(row.querySelector(".nav-toggle-name")!).fontSize),
      description: parseFloat(getComputedStyle(row.querySelector(".nav-number-desc")!).fontSize),
    }));
    expect(type.label).toBeGreaterThanOrEqual(14);
    expect(type.description).toBeGreaterThanOrEqual(12);

    await input.fill("20");
    await input.press("Tab");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            JSON.parse(localStorage.getItem("laymux.remote.displaySettings") || "{}")
              .terminalFontSize,
        ),
      )
      .toBe(20);

    if (width === 390) {
      await page.screenshot({ path: "../.screenshots/settings-remote-display.png" });
    }

    for (const name of ["Input bar", "Floating", "Composer", "Display", "Panels", "App"]) {
      await page.getByRole("tab", { name, exact: true }).click();
      const panel = page.getByRole("tabpanel");
      await expect(panel).toBeVisible();
      const overflow = await panel.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return Array.from(
          element.querySelectorAll<HTMLElement>(
            "input, select, button, .nav-toggle-desc, .key-set-desc",
          ),
        )
          .filter((control) => control.getBoundingClientRect().width > 0)
          .filter((control) => {
            const rect = control.getBoundingClientRect();
            return (
              rect.left < bounds.left - 1 ||
              rect.right > bounds.right + 1 ||
              control.scrollWidth > control.clientWidth + 1
            );
          })
          .map((control) => control.id || control.textContent?.trim());
      });
      expect(overflow, `${name}: 내용이나 입력칸이 가로로 잘리지 않아야 한다`).toEqual([]);
      if (width === 390 && name === "Composer") {
        await page.screenshot({ path: "../.screenshots/settings-remote-composer.png" });
      }
    }

    // Mouse, keyboard and touch share the same native tab/toggle controls.
    await page.getByRole("tab", { name: "Panels", exact: true }).click();
    await page.locator("#edgeSwipeDrawersToggle").uncheck();
    await page.getByRole("tab", { name: "Panels", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "App", exact: true })).toBeFocused();
    await page.reload();
    await page.locator("#drawerBack").click();
    await page.locator("#drawerSettingsButton").click();
    await expect(page.getByRole("tab", { name: "App", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.getByRole("tab", { name: "Panels", exact: true }).click();
    await expect(page.locator("#edgeSwipeDrawersToggle")).not.toBeChecked();
  });
}
