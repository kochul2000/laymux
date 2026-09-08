import { test, expect } from "./fixtures";

test("settings fields stay readable and save actions stay visible at narrow widths", async ({
  appPage: page,
}) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.keyboard.press("Control+,");
  const settings = page.getByTestId("settings-view");
  await expect(settings).toBeVisible();
  await expect(settings).toHaveCSS("font-family", /"Pretendard Variable"/);
  const loadedFonts = await page.evaluate(async () => {
    const normal = await document.fonts.load('400 13px "Pretendard Variable"', "설정 Settings");
    const semibold = await document.fonts.load('600 13px "Pretendard Variable"', "설정 Settings");
    return [normal, semibold].map((faces) => faces.map((face) => face.status));
  });
  expect(loadedFonts).toEqual([["loaded"], ["loaded"]]);
  const language = page.getByTestId("language-select");
  const theme = page.getByTestId("app-theme-select");
  await expect(language).toHaveCSS("font-size", "13px");
  await expect(theme).toHaveCSS("border-radius", "0px");
  expect((await language.boundingBox())!.height).toBeGreaterThanOrEqual(34);
  expect((await language.boundingBox())!.height).toBe((await theme.boundingBox())!.height);
  await settings.screenshot({ path: "../.screenshots/settings-ux-startup.png" });

  await page.getByTestId("nav-terminal").click();
  const fields = settings.locator(".settings-fields");
  await fields.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.getByTestId("save-settings-btn")).toBeInViewport();
  await expect(page.getByTestId("discard-settings-btn")).toBeInViewport();
  await page.getByTestId("nav-startup").click();

  // Exercise the same container width as a narrow dock without changing user layout.
  await settings.evaluate((element) => {
    element.style.width = "520px";
  });
  const row = settings.locator(".settings-row").first();
  const label = row.locator(".settings-row-label");
  await expect
    .poll(async () => {
      const labelBox = (await label.boundingBox())!;
      return (await language.boundingBox())!.y >= labelBox.y + labelBox.height;
    })
    .toBe(true);
  expect(await fields.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await settings.screenshot({ path: "../.screenshots/settings-ux-narrow.png" });
});
