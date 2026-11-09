import { expect, test } from "@playwright/test";
import { installRemoteClientRoutes } from "./remote-client-assets";

for (const [width, menuFontSize] of [
  [200, 13],
  [300, 13],
  [720, 13],
  [200, 24],
  [300, 24],
]) {
  test(`${width}px 메뉴·${menuFontSize}px 글자에서 여섯 설정 분류가 가로 스크롤 없이 보인다`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: Math.max(320, width + 40), height: 844 });
    await installRemoteClientRoutes(page);
    await page.addInitScript(
      (settings) => {
        localStorage.setItem("laymux.remote.displaySettings", JSON.stringify(settings));
      },
      { navigationWidth: width, menuFontSize },
    );
    await page.goto("http://remote.test/remote/");
    await page.locator("#drawerBack").click();
    await page.locator("#drawerSettingsButton").click();
    const tabs = page.getByRole("tablist");
    expect(await tabs.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    for (const tab of await tabs.getByRole("tab").all()) {
      const inside = await tab.evaluate((el) => {
        const bounds = el.parentElement!.getBoundingClientRect();
        const rect = el.getBoundingClientRect();
        return rect.left >= bounds.left && rect.right <= bounds.right + 1 && rect.height >= 44;
      });
      expect(inside, JSON.stringify(await tab.boundingBox())).toBe(true);
      const wordLines = await tab.evaluate((element) => {
        if (/\s/.test(element.textContent!.trim())) return 1;
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getClientRects().length;
      });
      expect(wordLines, `${await tab.textContent()}: 분류 이름의 단어를 쪼개지 않는다`).toBe(1);
    }
    await tabs.getByRole("tab", { name: "Input bar", exact: true }).focus();
    await page.keyboard.press("End");
    await expect(tabs.getByRole("tab", { name: "App", exact: true })).toBeFocused();
  });
}
