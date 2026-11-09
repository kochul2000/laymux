import { expect, test } from "@playwright/test";
import { installRemoteClientRoutes } from "./remote-client-assets";

for (const locale of ["en-US", "ko-KR"]) {
  test.describe(`기본 300px 메뉴 · 13px 글자 · ${locale}`, () => {
    test.use({ locale });
    test("Composer 입력은 이름 옆에 유지해 기본 화면 밀도를 보존한다", async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await installRemoteClientRoutes(page);
      await page.goto("http://remote.test/remote/");
      await page.locator("#drawerBack").click();
      await page.locator("#drawerSettingsButton").click();
      await page.locator("#settingsTabComposer").click();
      for (const id of [
        "remoteComposerFontSize",
        "remoteComposerIdleOpacity",
        "remoteComposerFocusedOpacity",
        "remoteComposerActiveOpacity",
      ]) {
        const row = page.locator(`label[for="${id}"]`);
        const copy = (await row.locator(".nav-number-copy").boundingBox())!;
        const input = (await page.locator(`#${id}`).boundingBox())!;
        expect(input.y).toBeLessThan(copy.y + copy.height);
        expect(input.x).toBeGreaterThanOrEqual(copy.x + copy.width);
      }
    });
  });
}

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

      test("Composer 숫자 설정의 이름을 한 글자씩 쪼개지 않고 입력을 유지한다", async ({
        page,
      }) => {
        await page.locator("#settingsTabComposer").click();
        const copy = page.locator('label[for="remoteComposerFontSize"] .nav-number-copy');
        const dimensions = await copy.evaluate((element) => {
          const label = element.querySelector(".nav-toggle-name")!;
          const style = getComputedStyle(label);
          const canvas = document.createElement("canvas");
          const context = canvas.getContext("2d")!;
          context.font = `${style.fontSize} ${style.fontFamily}`;
          return {
            width: element.getBoundingClientRect().width,
            wordWidth: context.measureText("Composer").width,
          };
        });
        expect(dimensions.width).toBeGreaterThanOrEqual(dimensions.wordWidth);
        const input = page.locator("#remoteComposerFontSize");
        await input.fill("22");
        await input.press("Tab");
        await expect(input).toHaveValue("22");
        await page.locator("#drawerSettingsView").evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        await page.locator("#settingsTabApp").focus();
        await page.keyboard.press("Home");
        await expect(page.locator("#settingsTabInputBar")).toBeFocused();
        expect(
          await page.locator("#drawerSettingsView").evaluate((element) => element.scrollTop),
        ).toBe(0);
      });
    });
  }
}
