import { expect, test } from "@playwright/test";
import { installRemoteClientRoutes } from "./remote-client-assets";

for (const locale of ["en-US", "ko-KR"]) {
  for (const navigationWidth of [200, 300]) {
    test.describe(`${locale} · ${navigationWidth}px 메뉴 · 24px 글자`, () => {
      test.use({ locale });
      test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await installRemoteClientRoutes(page);
        await page.addInitScript((width) => {
          localStorage.setItem(
            "laymux.remote.displaySettings",
            JSON.stringify({ navigationWidth: width, menuFontSize: 24 }),
          );
        }, navigationWidth);
        await page.goto("http://remote.test/remote/");
        await page.locator("#drawerBack").click();
        await page.locator("#drawerSettingsButton").click();
      });

      test("단축키의 설명과 키 조합이 겹치거나 잘리지 않는다", async ({ page }) => {
        await page.locator("#physicalKeyboardSection > summary").click();
        await page.locator("#keyboardShortcutsSection > summary").click();
        const failures = await page.locator("#keyboardShortcutList").evaluate((list) => {
          const bounds = list.getBoundingClientRect();
          return [...list.querySelectorAll("dt")].flatMap((term) => {
            const combo = term.nextElementSibling as HTMLElement;
            const a = term.getBoundingClientRect();
            const b = combo.getBoundingClientRect();
            const separated = a.right <= b.left + 1 || a.bottom <= b.top + 1;
            const readable =
              term.scrollWidth <= term.clientWidth + 1 &&
              combo.scrollWidth <= combo.clientWidth + 1 &&
              a.left >= bounds.left - 1 &&
              b.right <= bounds.right + 1;
            return separated && readable ? [] : [term.textContent];
          });
        });
        expect(failures).toEqual([]);
      });
    });
  }
}
