import { test, expect } from "./fixtures";

test("위치 선택·추가·이동·제거와 옵션이 좁은 설정 창에서도 동작한다", async ({ appPage: page }) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.keyboard.press("Control+,");
  await page.getByTestId("nav-widgets").click();
  const settings = page.getByTestId("settings-view");
  await expect(page.getByTestId("widgets-font-size")).toBeHidden();
  await expect(page.getByTestId(/^widgets-add-/)).toHaveCount(1);
  await page.getByTestId("widgets-slot-title-topBar.right").click();
  await page.getByTestId("widgets-add-topBar.right").selectOption("claudeUsage");
  const detail = page.getByTestId(/^widgets-detail-/);
  await expect(detail).toBeVisible();
  await page.getByTestId(/^widgets-add-/).selectOption("codexUsage");
  await expect(page.getByTestId(/^widgets-chip-/)).toHaveCount(2);
  await settings.screenshot({ path: "../.screenshots/widget-keys-pc-selected.png" });

  await settings.evaluate((element) => {
    element.style.width = "520px";
  });
  await page.getByTestId(/^widgets-move-/).selectOption("statusLine.left");
  await expect(page.getByTestId("widgets-slot-title-statusLine.left")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByTestId("widgets-add-statusLine.left")).toBeVisible();
  await expect(page.getByTestId(/^widgets-chip-/)).toHaveCount(1);
  const fields = settings.locator(".settings-fields");
  expect(await fields.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await detail.scrollIntoViewIfNeeded();
  await settings.screenshot({ path: "../.screenshots/widget-keys-pc-narrow.png" });
  await page.getByTestId(/^widgets-remove-/).click();
  await expect(detail).toHaveCount(0);
  await expect(page.getByTestId("widgets-add-statusLine.left")).toBeVisible();
  await page.locator(".widgets-appearance > summary").click();
  await page.getByTestId("widgets-font-size").fill("12");
  await expect(page.getByTestId("widgets-preview-topBar")).toHaveCSS("font-size", "12px");
  await page.getByTestId("widgets-status-line-toggle").click();
  await expect(page.getByTestId("save-settings-btn")).toBeEnabled();
  await page.getByTestId("discard-settings-btn").click();
  await expect(page.getByTestId("save-settings-btn")).toBeDisabled();
});
