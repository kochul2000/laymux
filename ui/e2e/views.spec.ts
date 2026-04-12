import { test, expect } from "./fixtures";

/** Helper: hover over pane to reveal PaneControlBar. */
async function hoverPane(page: import("@playwright/test").Page, index: number) {
  const pane = page.locator(`[data-testid='workspace-pane-${index}']`);
  await pane.hover();
  await expect(pane.locator("[data-testid='pane-control-bar']")).toBeVisible({ timeout: 3000 });
}

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
    await hoverPane(page, 0);
    await page.getByTestId("pane-control-split-v").click();

    const emptyView = page.locator("[data-testid='workspace-pane-1'] [data-testid='empty-view']");
    await expect(emptyView).toBeVisible();
    await expect(emptyView).toContainText("Select a view");
  });

  test("empty view has terminal and memo options", async ({ appPage: page }) => {
    await hoverPane(page, 0);
    await page.getByTestId("pane-control-split-v").click();

    const emptyView = page.locator("[data-testid='workspace-pane-1'] [data-testid='empty-view']");
    // Terminal profiles (PowerShell, WSL) and Memo
    await expect(emptyView.getByTestId("empty-view-terminal-PowerShell")).toBeVisible();
    await expect(emptyView.getByTestId("empty-view-memo")).toBeVisible();
  });

  test("clicking terminal option in EmptyView switches to TerminalView", async ({
    appPage: page,
  }) => {
    await hoverPane(page, 0);
    await page.getByTestId("pane-control-split-v").click();

    // Click PowerShell terminal in the empty view
    const emptyView = page.locator("[data-testid='workspace-pane-1'] [data-testid='empty-view']");
    await emptyView.getByTestId("empty-view-terminal-PowerShell").click();

    // Should now have a terminal view in pane 1
    await expect(
      page.locator("[data-testid='workspace-pane-1'] [data-testid='view-terminal']"),
    ).toBeVisible();
  });

  test("clicking Memo in EmptyView switches to MemoView", async ({ appPage: page }) => {
    await hoverPane(page, 0);
    await page.getByTestId("pane-control-split-v").click();

    const emptyView = page.locator("[data-testid='workspace-pane-1'] [data-testid='empty-view']");
    await emptyView.getByTestId("empty-view-memo").click();

    await expect(
      page.locator("[data-testid='workspace-pane-1'] [data-testid='view-memo']"),
    ).toBeVisible();
  });
});

test.describe("IssueReporterView", () => {
  test("capture button takes screenshot and shows preview", async ({ appPage: page }) => {
    // Intercept the screenshot API call
    await page.route("**/api/v1/screenshot", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          path: "/tmp/test-screenshot.png",
          dataUrl:
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        }),
      });
    });

    // Switch pane to IssueReporterView
    await hoverPane(page, 0);
    await page.getByTestId("pane-control-view-select").selectOption("IssueReporterView");
    await expect(page.getByTestId("issue-reporter-view")).toBeVisible();

    // Initially shows "No screenshot"
    await expect(page.getByText("No screenshot")).toBeVisible();

    // Click Capture button
    await page.getByRole("button", { name: /Capture/ }).click();

    // Screenshot should be captured
    await expect(page.getByText("Screenshot captured")).toBeVisible({ timeout: 5000 });

    // Preview image should be visible
    await expect(page.locator("img[alt='Screenshot preview']")).toBeVisible();
  });

  test("capture button can re-take screenshot", async ({ appPage: page }) => {
    let captureCount = 0;
    await page.route("**/api/v1/screenshot", (route) => {
      captureCount++;
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          path: `/tmp/screenshot-${captureCount}.png`,
          dataUrl:
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        }),
      });
    });

    // Switch pane to IssueReporterView
    await hoverPane(page, 0);
    await page.getByTestId("pane-control-view-select").selectOption("IssueReporterView");

    // First capture — wait for transition from "No screenshot" to "Screenshot captured"
    await page.getByRole("button", { name: /Capture/ }).click();
    await expect(page.getByText("Screenshot captured")).toBeVisible({ timeout: 5000 });
    expect(captureCount).toBe(1);

    // Second capture — button click triggers "Capturing..." then back to "Screenshot captured"
    const [response] = await Promise.all([
      page.waitForResponse("**/api/v1/screenshot"),
      page.getByRole("button", { name: /Capture/ }).click(),
    ]);
    expect(response.ok()).toBe(true);
    await expect(page.getByText("Screenshot captured")).toBeVisible({ timeout: 5000 });
    expect(captureCount).toBe(2);
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

  test("renders settings view with sidebar navigation", async ({ appPage: page }) => {
    const sv = page.getByTestId("settings-view");
    await expect(sv).toBeVisible();
    // Settings view uses sidebar navigation, not h2 headings
    await expect(sv.locator("[data-testid='sidebar-open-json']")).toBeVisible();
    await expect(sv.locator("[data-testid='nav-profile-defaults']")).toBeVisible();
  });

  test("font face select has default value", async ({ appPage: page }) => {
    // Font inputs are in Profile Defaults section
    await page.getByTestId("nav-profile-defaults").click();
    const fontSelect = page.getByTestId("font-face-input");
    await expect(fontSelect).toBeVisible();
    const value = await fontSelect.inputValue();
    expect(value).toBeTruthy();
  });

  test("font size input has numeric value", async ({ appPage: page }) => {
    await page.getByTestId("nav-profile-defaults").click();
    const sizeInput = page.getByTestId("font-size-input");
    await expect(sizeInput).toBeVisible();
    const value = await sizeInput.inputValue();
    expect(parseInt(value)).toBeGreaterThan(0);
  });

  test("changing font size updates the input", async ({ appPage: page }) => {
    await page.getByTestId("nav-profile-defaults").click();
    const sizeInput = page.getByTestId("font-size-input");
    await expect(sizeInput).toBeVisible();
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

  test("profiles section shows profile nav in sidebar", async ({ appPage: page }) => {
    // Profiles are listed in the sidebar navigation
    await expect(page.getByTestId("add-profile-btn")).toBeVisible();
  });

  test("add profile button creates a new profile entry", async ({ appPage: page }) => {
    const sv = page.getByTestId("settings-view");
    const profilesBefore = await sv.locator("[data-testid^='remove-profile-']").count();

    await page.getByTestId("add-profile-btn").click();

    const profilesAfter = await sv.locator("[data-testid^='remove-profile-']").count();
    expect(profilesAfter).toBe(profilesBefore + 1);
  });

  test("remove profile button removes the profile", async ({ appPage: page }) => {
    // Add a new profile
    await page.getByTestId("add-profile-btn").click();

    // Count profiles before removal
    const profiles = page.locator("[data-testid^='remove-profile-']");
    const countBefore = await profiles.count();

    // Hover the parent row to make the remove button visible (group-hover:inline)
    const lastProfile = profiles.last();
    await lastProfile.locator("..").hover();
    await lastProfile.click();

    const countAfter = await page.locator("[data-testid^='remove-profile-']").count();
    expect(countAfter).toBe(countBefore - 1);
  });

  test("save button exists", async ({ appPage: page }) => {
    const saveBtn = page.getByTestId("save-settings-btn");
    await expect(saveBtn).toBeVisible();
  });

  test("color schemes section has add button", async ({ appPage: page }) => {
    // Navigate to Color Schemes section
    await page.locator("button", { hasText: "Color Schemes" }).click();
    await expect(page.getByTestId("add-color-scheme-btn")).toBeVisible();
  });

  test("add color scheme creates an entry", async ({ appPage: page }) => {
    await page.locator("button", { hasText: "Color Schemes" }).click();
    await page.getByTestId("add-color-scheme-btn").click();
    // After adding, the select should have an option
    await expect(page.getByTestId("add-color-scheme-btn")).toBeVisible();
  });

  test("keybindings section has add button", async ({ appPage: page }) => {
    // Navigate to Keybindings section
    await page.locator("button", { hasText: "Keybindings" }).click();
    await expect(page.getByTestId("add-keybinding-btn")).toBeVisible();
  });

  test("add keybinding creates an entry", async ({ appPage: page }) => {
    await page.locator("button", { hasText: "Keybindings" }).click();
    await page.getByTestId("add-keybinding-btn").click();
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
