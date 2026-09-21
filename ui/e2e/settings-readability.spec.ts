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
  const row = settings.locator(".settings-field").first();
  const label = row.locator(".settings-field__label");
  await expect
    .poll(async () => {
      const labelBox = (await label.boundingBox())!;
      return (await language.boundingBox())!.y >= labelBox.y + labelBox.height;
    })
    .toBe(true);
  expect(await fields.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await settings.screenshot({ path: "../.screenshots/settings-ux-narrow.png" });
});

test("settings navigation and controls remain reachable in a compact dock", async ({
  appPage: page,
}) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.keyboard.press("Control+,");
  const settings = page.getByTestId("settings-view");
  await settings.evaluate((element) => {
    element.style.width = "520px";
  });
  const sidebar = settings.locator(".settings-sidebar");
  expect((await sidebar.boundingBox())!.width).toBeLessThanOrEqual(64);
  await expect(page.getByTestId("sidebar-open-json")).toBeInViewport();
  const fields = settings.locator(".settings-fields");

  for (const section of [
    "startup",
    "update",
    "font",
    "interface",
    "workspaceDisplay",
    "widgets",
    "terminal",
    "colorSchemes",
    "paste",
    "keybindings",
    "memo",
    "fileExplorer",
    "viewer",
    "github",
    "issueReporter",
    "claude",
    "codex",
    "grok",
    "remote",
    "profile-defaults",
  ]) {
    const nav = page.getByTestId(`nav-${section}`);
    await expect(nav).toHaveAccessibleName(/.+/);
    await nav.click();
    await expect(nav).toHaveAttribute("aria-current", "page");
    expect(await fields.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    const clipped = await fields.locator("input, select, textarea").evaluateAll((controls) =>
      controls
        .filter((control) => {
          const bounds = control.getBoundingClientRect();
          const parent = control.closest(".settings-fields")!.getBoundingClientRect();
          return bounds.width > 0 && (bounds.left < parent.left || bounds.right > parent.right);
        })
        .map((control) => control.getAttribute("data-testid")),
    );
    expect(clipped).toEqual([]);
    await expect(page.getByTestId("save-settings-btn")).toBeInViewport();
  }
});

test("switching settings pages starts at the title and keeps edits until discarded", async ({
  appPage: page,
}) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.keyboard.press("Control+,");
  const settings = page.getByTestId("settings-view");
  const theme = page.getByTestId("app-theme-select");
  const initialTheme = await theme.inputValue();
  await theme.selectOption({ index: 1 });
  await expect(page.getByTestId("save-settings-btn")).toBeEnabled();
  await page.getByTestId("nav-terminal").click();
  const fields = settings.locator(".settings-fields");
  await fields.evaluate((element) => {
    element.scrollTop = 700;
  });
  expect(await fields.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await page.getByTestId("nav-remote").click();
  await expect(settings.locator(".settings-page__title")).toBeInViewport();
  expect(await fields.evaluate((element) => element.scrollTop)).toBe(0);
  await page.getByTestId("nav-startup").click();
  await expect(theme).not.toHaveValue(initialTheme);
  await page.getByTestId("discard-settings-btn").click();
  await expect(theme).toHaveValue(initialTheme);
  await expect(page.getByTestId("save-settings-btn")).toBeDisabled();
});
