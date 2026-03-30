import { test, expect } from "./fixtures";

test.describe("TerminalView", () => {
  test("terminal view renders in default pane", async ({ appPage: page }) => {
    // Default workspace has a TerminalView pane
    await expect(page.getByTestId("view-terminal")).toBeVisible();
  });

  test("terminal view has xterm container", async ({ appPage: page }) => {
    // The terminal container div should be present (even if xterm can't fully render)
    const terminalView = page.locator("[data-testid^='terminal-view-']");
    await expect(terminalView.first()).toBeVisible();
  });
});

test.describe("EmptyView", () => {
  test("empty view shows view selection buttons", async ({ appPage: page }) => {
    // Split to get an empty pane
    await page.getByTestId("edit-mode-toggle").click();
    await page.locator("[data-testid='workspace-pane-0']").click();
    await page.getByTestId("split-vertical-btn").click();

    const emptyView = page.locator("[data-testid='workspace-pane-1'] [data-testid='empty-view']");
    await expect(emptyView).toBeVisible();
    await expect(emptyView).toContainText("Select a view");
  });

  test("empty view has Terminal and Browser Preview buttons", async ({ appPage: page }) => {
    await page.getByTestId("edit-mode-toggle").click();
    await page.locator("[data-testid='workspace-pane-0']").click();
    await page.getByTestId("split-vertical-btn").click();

    const emptyView = page.locator("[data-testid='workspace-pane-1'] [data-testid='empty-view']");
    await expect(emptyView.getByText("Terminal")).toBeVisible();
    await expect(emptyView.getByText("Browser Preview")).toBeVisible();
  });

  test("clicking Terminal button in EmptyView switches to TerminalView", async ({
    appPage: page,
  }) => {
    await page.getByTestId("edit-mode-toggle").click();
    await page.locator("[data-testid='workspace-pane-0']").click();
    await page.getByTestId("split-vertical-btn").click();

    // Click Terminal in the empty view
    const emptyView = page.locator("[data-testid='workspace-pane-1'] [data-testid='empty-view']");
    await emptyView.getByText("Terminal").click();

    // Should now have a terminal view in pane 1
    await expect(
      page.locator("[data-testid='workspace-pane-1'] [data-testid='view-terminal']"),
    ).toBeVisible();
  });

  test("clicking Browser Preview in EmptyView switches to BrowserPreviewView", async ({
    appPage: page,
  }) => {
    await page.getByTestId("edit-mode-toggle").click();
    await page.locator("[data-testid='workspace-pane-0']").click();
    await page.getByTestId("split-vertical-btn").click();

    const emptyView = page.locator("[data-testid='workspace-pane-1'] [data-testid='empty-view']");
    await emptyView.getByText("Browser Preview").click();

    await expect(
      page.locator("[data-testid='workspace-pane-1'] [data-testid='browser-preview']"),
    ).toBeVisible();
  });
});

test.describe("BrowserPreviewView", () => {
  test.beforeEach(async ({ appPage: page }) => {
    // Switch the first pane to BrowserPreview via edit mode
    await page.getByTestId("edit-mode-toggle").click();
    await page.locator("[data-testid='workspace-pane-0']").click();
    await page.getByTestId("view-switcher-0").selectOption("BrowserPreviewView");
    await page.getByTestId("edit-mode-toggle").click(); // exit edit mode
  });

  test("renders with URL bar and iframe", async ({ appPage: page }) => {
    await expect(page.getByTestId("browser-preview")).toBeVisible();
    await expect(page.getByTestId("browser-url-input")).toBeVisible();
    await expect(page.getByTestId("browser-iframe")).toBeVisible();
  });

  test("has back, forward, and reload buttons", async ({ appPage: page }) => {
    await expect(page.getByTestId("browser-back-btn")).toBeVisible();
    await expect(page.getByTestId("browser-forward-btn")).toBeVisible();
    await expect(page.getByTestId("browser-reload-btn")).toBeVisible();
  });

  test("URL input has default value", async ({ appPage: page }) => {
    const urlInput = page.getByTestId("browser-url-input");
    const value = await urlInput.inputValue();
    expect(value).toBeTruthy(); // Should have some default URL
  });

  test("typing URL and pressing Enter navigates", async ({ appPage: page }) => {
    const urlInput = page.getByTestId("browser-url-input");
    await urlInput.fill("about:blank");
    await urlInput.press("Enter");

    const iframe = page.getByTestId("browser-iframe");
    const src = await iframe.getAttribute("src");
    expect(src).toBe("about:blank");
  });
});

test.describe("SettingsView (via dock)", () => {
  test.beforeEach(async ({ appPage: page }) => {
    // Wait for session persistence to finish loading before interacting
    await page.waitForTimeout(500);
    // Switch left dock to SettingsView
    await page.getByTestId("dock-icon-SettingsView").click();
    await expect(page.getByTestId("settings-view")).toBeVisible();
  });

  test("renders settings view with sections", async ({ appPage: page }) => {
    const sv = page.getByTestId("settings-view");
    await expect(sv).toBeVisible();
    await expect(sv.locator("h2")).toContainText("Settings");
    await expect(sv.locator("h3").filter({ hasText: "Font" })).toBeVisible();
    await expect(sv.locator("h3").filter({ hasText: "Default Profile" })).toBeVisible();
    await expect(sv.locator("h3").filter({ hasText: "Profiles" })).toBeVisible();
  });

  test("font face input has default value", async ({ appPage: page }) => {
    const fontInput = page.getByTestId("font-face-input");
    const value = await fontInput.inputValue();
    expect(value).toBeTruthy();
  });

  test("font size input has numeric value", async ({ appPage: page }) => {
    const sizeInput = page.getByTestId("font-size-input");
    const value = await sizeInput.inputValue();
    expect(parseInt(value)).toBeGreaterThan(0);
  });

  test("changing font face updates the input", async ({ appPage: page }) => {
    const fontInput = page.getByTestId("font-face-input");
    await fontInput.fill("Fira Code");
    await expect(fontInput).toHaveValue("Fira Code");
  });

  test("changing font size updates the input", async ({ appPage: page }) => {
    const sizeInput = page.getByTestId("font-size-input");
    await sizeInput.fill("18");
    await expect(sizeInput).toHaveValue("18");
  });

  test("default profile selector has options", async ({ appPage: page }) => {
    const select = page.getByTestId("default-profile-select");
    await expect(select).toBeVisible();

    const options = select.locator("option");
    const count = await options.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test("profiles section lists existing profiles", async ({ appPage: page }) => {
    // At least PowerShell should be listed within settings view
    const sv = page.getByTestId("settings-view");
    await expect(sv.locator("span.font-medium").filter({ hasText: "PowerShell" })).toBeVisible();
  });

  test("add profile button creates a new profile entry", async ({ appPage: page }) => {
    const sv = page.getByTestId("settings-view");
    const profilesBefore = await sv.locator("[data-testid^='remove-profile-']").count();

    await page.getByTestId("add-profile-btn").click();

    const profilesAfter = await sv.locator("[data-testid^='remove-profile-']").count();
    expect(profilesAfter).toBe(profilesBefore + 1);
  });

  test("remove profile button removes the profile", async ({ appPage: page }) => {
    // Add then remove
    await page.getByTestId("add-profile-btn").click();

    // Count profiles before
    const profiles = page.locator("[data-testid^='remove-profile-']");
    const countBefore = await profiles.count();

    // Remove last one
    await profiles.last().click();

    const countAfter = await page.locator("[data-testid^='remove-profile-']").count();
    expect(countAfter).toBe(countBefore - 1);
  });

  test("save button exists and is clickable", async ({ appPage: page }) => {
    const saveBtn = page.getByTestId("save-settings-btn");
    await expect(saveBtn).toBeVisible();
    await saveBtn.click();
    // Should not crash
    await expect(page.getByTestId("settings-view")).toBeVisible();
  });

  test("color schemes section shows empty state", async ({ appPage: page }) => {
    await expect(page.getByText("No custom color schemes")).toBeVisible();
  });

  test("add color scheme creates an entry", async ({ appPage: page }) => {
    await page.getByTestId("add-color-scheme-btn").click();
    await expect(page.getByText("No custom color schemes")).not.toBeVisible();
    await expect(page.locator("[data-testid='remove-color-scheme-0']")).toBeVisible();
  });

  test("keybindings section shows empty state", async ({ appPage: page }) => {
    await expect(page.getByText("No custom keybindings")).toBeVisible();
  });

  test("add keybinding creates an entry", async ({ appPage: page }) => {
    await page.getByTestId("add-keybinding-btn").click();
    await expect(page.getByText("No custom keybindings")).not.toBeVisible();
    await expect(page.locator("[data-testid='remove-keybinding-0']")).toBeVisible();
  });
});

test.describe("SettingsView (via modal with Ctrl+,)", () => {
  test("Ctrl+, opens settings modal", async ({ appPage: page }) => {
    await page.keyboard.press("Control+,");
    await expect(page.getByTestId("settings-modal")).toBeVisible();
    await expect(page.getByTestId("settings-view")).toBeVisible();
  });

  test("clicking modal backdrop closes settings modal", async ({ appPage: page }) => {
    await page.keyboard.press("Control+,");
    await expect(page.getByTestId("settings-modal")).toBeVisible();

    await page.getByTestId("settings-modal-backdrop").click({ position: { x: 10, y: 10 } });
    await expect(page.getByTestId("settings-modal")).not.toBeVisible();
  });
});
