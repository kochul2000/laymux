import { test, expect } from "./fixtures";

for (const width of [320, 420, 421, 520, 1040]) {
  test(`긴 프로필 제목도 ${width}px 설정 본문 안에 표시한다`, async ({ appPage: page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.keyboard.press("Control+,");
    const settings = page.getByTestId("settings-view");
    await page.getByTestId("language-select").selectOption(width === 320 ? "ko" : "en");
    await settings.evaluate((el, size) => {
      el.style.width = `${size}px`;
    }, width);
    const compact = page.getByTestId("compact-settings-section");
    if (width <= 420) await compact.selectOption("profile-0");
    else await settings.locator(".settings-profile-nav .settings-nav-button").first().click();
    const longName = "LongProfileNameWithoutSpaces".repeat(3);
    await page.getByTestId("profile-name-input").fill(longName);
    await expect(settings.locator(".settings-page__title")).toHaveText(longName);
    await settings.screenshot({ path: test.info().outputPath(`profile-${width}.png`) });
    const fields = settings.locator(".settings-fields");
    expect(await fields.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    const title = fields.locator(".settings-page__title");
    expect(await title.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  });
}
