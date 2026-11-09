import { expect, test } from "@playwright/test";
import { installRemoteClientRoutes } from "./remote-client-assets";

test.use({ locale: "ko-KR" });

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installRemoteClientRoutes(page);
  await page.goto("http://remote.test/remote/");
  await page.locator("#drawerBack").click();
  await page.locator("#drawerSettingsButton").click();
});

test("통합된 키보드 안내와 덮어쓴 단축키가 같은 기기 언어를 따른다", async ({ page }) => {
  await page.locator("#physicalKeyboardSection > summary").click();
  await expect(page.locator("#physicalKeyboardStatus")).toContainText("이 브라우저는");
  await expect(page.locator("#physicalKeyboardStatus")).not.toContainText("Android");
  await page.locator("#keyboardShortcutsSection > summary").click();
  await expect(page.locator("#keyboardShortcutList")).toHaveCount(1);
  await expect(page.locator("#remoteNavigationShortcutNotice")).toContainText("리모트 탐색:");
  await expect(page.locator("#keyboardShortcutList .keyboard-shortcut-note").first()).toHaveText(
    "리모트 탐색이 대신하는 PC 단축키",
  );
  await expect(page.locator("#keyboardShortcutList s")).toHaveCount(5);
  await page.locator("#settingsTabApp").click();
  await page.locator("#remoteLanguage").selectOption("en");
  await page.locator("#settingsTabInputBar").click();
  await expect(page.locator("#keyboardShortcutList .keyboard-shortcut-note").first()).toHaveText(
    "PC shortcut overridden by Remote Nav",
  );
  await expect(page.locator("#keyboardShortcutList s")).toHaveCount(5);
});

test("Composer 연동 설명과 실행 결과는 언어 전환 뒤에도 번역된다", async ({ page }) => {
  await page.locator("#settingsTabComposer").click();
  await expect(page.locator("#remoteComposerOpacityHint")).toContainText("대기 ≤ 포커스 ≤ 사용 중");
  await page.locator("#remoteComposerActiveOpacity").fill("40");
  await page.locator("#remoteComposerActiveOpacity").press("Tab");
  await expect(page.locator("#remoteComposerOpacityStatus")).toHaveText(
    "함께 조정됨: 대기 40%, 포커스 40%.",
  );
  await page.locator("#settingsTabApp").click();
  await page.locator("#remoteLanguage").selectOption("en");
  await page.locator("#settingsTabComposer").click();
  await expect(page.locator("#remoteComposerOpacityStatus")).toHaveText(
    "Also adjusted: Idle 40%, Focused 40%.",
  );
});

test("닫힌 메뉴의 포커스 차단과 번역된 열기 이름을 함께 유지한다", async ({ page }) => {
  await page.locator("#navToggle").click();
  await expect(page.locator("#navigationPanel")).toHaveAttribute("inert", "");
  await expect(page.locator("#navToggle")).toHaveAccessibleName("탐색 열기");
  await page.locator("#navToggle").focus();
  await page.keyboard.press("Tab");
  expect(
    await page.locator("#navigationPanel").evaluate((el) => el.contains(document.activeElement)),
  ).toBe(false);
});
