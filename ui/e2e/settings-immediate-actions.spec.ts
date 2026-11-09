import { test, expect } from "./fixtures";

test("언어와 프로필의 즉시 적용을 설명하고 프로필 삭제를 확인한다", async ({
  appPage: page,
}, info) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.keyboard.press("Control+,");
  await page.getByTestId("language-select").selectOption("en");
  await page
    .getByTestId("settings-view")
    .screenshot({ path: info.outputPath("immediate-actions.png") });
  await expect(page.locator(".settings-save-bar")).toContainText("applied immediately");
  await expect(page.getByTestId("save-settings-btn")).toBeDisabled();
  const before = await page.locator("[data-testid^='remove-profile-']").count();
  await page.getByTestId("add-profile-btn").click();
  const remove = page.locator("[data-testid^='remove-profile-']").last();
  await expect(page.locator("[data-testid^='remove-profile-']")).toHaveCount(before + 1);
  await remove.click();
  await expect(remove).toHaveAttribute("data-confirming", "true");
  await expect(page.locator("[data-testid^='remove-profile-']")).toHaveCount(before + 1);
  await page.keyboard.press("Escape");
  await expect(remove).not.toHaveAttribute("data-confirming", "true");
  await remove.click();
  await remove.click();
  await expect(page.locator("[data-testid^='remove-profile-']")).toHaveCount(before);
  await page.getByTestId("language-select").selectOption("ko");
  await expect(page.locator(".settings-save-bar")).toContainText("언어 즉시 적용됨");
});

test("삭제 확인은 좁은 메뉴에서도 프로필 이름을 가리지 않는다", async ({ appPage: page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.keyboard.press("Control+,");
  const settings = page.getByTestId("settings-view");
  await settings.evaluate((element) => {
    element.style.width = "520px";
  });
  await page.getByTestId("add-profile-btn").click();
  const remove = page.locator("[data-testid^='remove-profile-']").last();
  await remove.click();
  await expect(remove).toHaveAttribute("data-confirming", "true");
  const row = remove.locator("..");
  const name = await row.locator(".settings-nav-label").boundingBox();
  const confirm = await remove.boundingBox();
  expect(name).not.toBeNull();
  expect(confirm!.y).toBeGreaterThanOrEqual(name!.y + name!.height);
  expect(await row.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});
