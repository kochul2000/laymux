import { test, expect } from "./fixtures";

test.describe("AppLayout structure", () => {
  test("renders full layout hierarchy: toolbar → docks → workspace area", async ({
    appPage: page,
  }) => {
    await expect(page.getByTestId("grid-edit-toolbar")).toBeVisible();
    await expect(page.getByTestId("dock-left")).toBeVisible();
    await expect(page.getByTestId("workspace-area")).toBeVisible();
  });

  test("workspace area contains at least one pane", async ({ appPage: page }) => {
    const panes = page.locator("[data-testid^='workspace-pane-']");
    await expect(panes).toHaveCount(1);
  });

  test("left dock has icon bar with W and S icons", async ({ appPage: page }) => {
    const iconBar = page.getByTestId("dock-icon-bar");
    await expect(iconBar).toBeVisible();

    const wsIcon = page.getByTestId("dock-icon-WorkspaceSelectorView");
    const settingsIcon = page.getByTestId("dock-icon-SettingsView");
    await expect(wsIcon).toBeVisible();
    await expect(settingsIcon).toBeVisible();
  });

  test("WorkspaceSelectorView icon is active by default", async ({ appPage: page }) => {
    const wsIcon = page.getByTestId("dock-icon-WorkspaceSelectorView");
    await expect(wsIcon).toHaveAttribute("data-active", "true");

    const settingsIcon = page.getByTestId("dock-icon-SettingsView");
    await expect(settingsIcon).toHaveAttribute("data-active", "false");
  });

  test("clicking SettingsView icon switches dock content", async ({ appPage: page }) => {
    await page.getByTestId("dock-icon-SettingsView").click();
    await expect(page.getByTestId("settings-view")).toBeVisible();
    await expect(page.getByTestId("workspace-selector")).not.toBeVisible();

    // Switch back
    await page.getByTestId("dock-icon-WorkspaceSelectorView").click();
    await expect(page.getByTestId("workspace-selector")).toBeVisible();
  });

  test("workspace area occupies more space than left dock", async ({ appPage: page }) => {
    const dockBox = await page.getByTestId("dock-left").boundingBox();
    const areaBox = await page.getByTestId("workspace-area").boundingBox();
    expect(dockBox).toBeTruthy();
    expect(areaBox).toBeTruthy();
    expect(areaBox!.width).toBeGreaterThan(dockBox!.width);
  });

  test("pane fills workspace area completely (single pane layout)", async ({ appPage: page }) => {
    const areaBox = await page.getByTestId("workspace-area").boundingBox();
    const paneBox = await page.locator("[data-testid='workspace-pane-0']").boundingBox();
    expect(areaBox).toBeTruthy();
    expect(paneBox).toBeTruthy();
    // Pane should approximately fill the area
    expect(paneBox!.width).toBeGreaterThan(areaBox!.width * 0.9);
    expect(paneBox!.height).toBeGreaterThan(areaBox!.height * 0.9);
  });
});
