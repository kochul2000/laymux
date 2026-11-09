import { test, expect } from "./fixtures";

test("설정 창 바깥 클릭과 닫기 뒤에도 편집 내용과 선택 페이지를 유지한다", async ({
  appPage: page,
}, info) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.keyboard.press("Control+,");
  const theme = page.getByTestId("app-theme-select");
  const originalTheme = await theme.inputValue();
  await theme.selectOption({ index: 1 });
  const changedTheme = await theme.inputValue();
  await page.getByTestId("settings-modal-backdrop").click({ position: { x: 2, y: 2 } });
  await page.keyboard.press("Control+,");
  await page.getByTestId("settings-view").screenshot({ path: info.outputPath("close-drafts.png") });
  await expect(theme).toHaveValue(changedTheme);
  await expect(page.getByTestId("save-settings-btn")).toBeEnabled();
  await page.getByTestId("nav-terminal").click();
  await page.getByTestId("settings-modal-close").click();
  await page.keyboard.press("Control+,");
  await expect(page.getByTestId("nav-terminal")).toHaveAttribute("aria-current", "page");
  await page.getByTestId("nav-startup").click();
  await expect(theme).toHaveValue(changedTheme);
  await page.getByTestId("discard-settings-btn").click();
  await expect(theme).toHaveValue(originalTheme);
});
