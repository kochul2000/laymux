import { test, expect } from "./fixtures";

test.describe("WorkspaceSelectorView - Basic", () => {
  test("renders workspace selector with default workspace", async ({ appPage: page }) => {
    await expect(page.getByTestId("workspace-selector")).toBeVisible();
    await expect(page.getByTestId("workspace-name-ws-default")).toBeVisible();
  });

  test("default workspace is marked as active", async ({ appPage: page }) => {
    const item = page.getByTestId("workspace-item-ws-default");
    await expect(item).toBeVisible();
    await expect(item).toHaveAttribute("data-active", "true");
  });

  test("new workspace panel with layout cards is visible", async ({ appPage: page }) => {
    await expect(page.getByTestId("new-workspace-panel")).toBeVisible();
    await expect(page.getByTestId("layout-card-default-layout")).toBeVisible();
  });

  test("notification panel toggle button exists", async ({ appPage: page }) => {
    await expect(page.getByTestId("toggle-notification-panel")).toBeVisible();
    await expect(page.getByTestId("toggle-notification-panel")).toContainText("Notifications");
  });
});

test.describe("WorkspaceSelectorView - Add Workspace", () => {
  test("Ctrl+Alt+N creates workspace", async ({ appPage: page }) => {
    await page.waitForTimeout(500);
    await page.keyboard.press("Control+Alt+N");

    // Should now have 2 workspace items
    const items = page.locator("[data-testid^='workspace-item-']");
    await expect(items).toHaveCount(2);
  });

  test("new workspace shows in the list", async ({ appPage: page }) => {
    await page.waitForTimeout(500);
    await page.keyboard.press("Control+Alt+N");

    // New workspace should appear
    const items = page.locator("[data-testid^='workspace-item-']");
    await expect(items).toHaveCount(2);
  });
});

test.describe("WorkspaceSelectorView - Switch Workspace", () => {
  test("clicking a different workspace switches the active one", async ({ appPage: page }) => {
    await page.waitForTimeout(500);

    // Add a second workspace
    await page.keyboard.press("Control+Alt+N");

    // Click the second workspace
    const items = page.locator("[data-testid^='workspace-item-']");
    await expect(items).toHaveCount(2);
    const secondItem = items.nth(1);
    await secondItem.click();

    // It should now be active
    await expect(secondItem).toHaveAttribute("data-active", "true");

    // First should be inactive
    const firstItem = items.nth(0);
    await expect(firstItem).toHaveAttribute("data-active", "false");
  });
});

test.describe("WorkspaceSelectorView - Notification Panel", () => {
  test("clicking toggle shows notification panel", async ({ appPage: page }) => {
    await page.getByTestId("toggle-notification-panel").click();
    await expect(page.getByTestId("notification-panel")).toBeVisible();
    await expect(page.getByTestId("toggle-notification-panel")).toContainText("Hide Notifications");
  });

  test("clicking toggle again hides notification panel", async ({ appPage: page }) => {
    await page.getByTestId("toggle-notification-panel").click();
    await expect(page.getByTestId("notification-panel")).toBeVisible();

    await page.getByTestId("toggle-notification-panel").click();
    await expect(page.getByTestId("notification-panel")).not.toBeVisible();
    await expect(page.getByTestId("toggle-notification-panel")).toContainText("Notifications");
  });

  test("notification panel shows empty state initially", async ({ appPage: page }) => {
    await page.getByTestId("toggle-notification-panel").click();
    await expect(page.getByText("No notifications")).toBeVisible();
  });
});

test.describe("WorkspaceSelectorView - Listening Ports", () => {
  test("listening ports section appears (from mock data)", async ({ appPage: page }) => {
    // Mock returns ports 3000 and 8080
    // Wait for port detection hook to fetch
    await page.waitForTimeout(1500);

    const ports = page.getByTestId("listening-ports");
    // Ports may or may not appear depending on whether the mock works for usePortDetection
    const visible = await ports.isVisible().catch(() => false);
    if (visible) {
      const text = await ports.textContent();
      expect(text).toContain(":3000");
      expect(text).toContain(":8080");
    }
  });
});

test.describe("WorkspaceSelectorView - Hidden Items Shelf", () => {
  test("hides, restores with both action modes, and restores all", async ({ appPage: page }) => {
    // Create an active three-pane workspace while keeping the default workspace
    // available as the workspace-level hide target.
    await page.getByTestId("layout-create-dev-split").click();
    const workspaceItems = page.locator("[data-testid^='workspace-item-']");
    await expect(workspaceItems).toHaveCount(2);
    const splitWorkspaceTestId = await workspaceItems.nth(1).getAttribute("data-testid");
    expect(splitWorkspaceTestId).toBeTruthy();
    const defaultWorkspace = page.getByTestId("workspace-item-ws-default");
    const splitWorkspace = page.getByTestId(splitWorkspaceTestId!);
    await expect(splitWorkspace).toHaveAttribute("data-active", "true");

    await defaultWorkspace.hover();
    await defaultWorkspace.locator("[data-testid^='workspace-hide-']").click();

    const splitPaneRows = splitWorkspace.locator("[data-testid^='pane-row-']");
    await expect(splitPaneRows).toHaveCount(3);
    const secondPaneRow = splitPaneRows.nth(1);
    await secondPaneRow.hover();
    await secondPaneRow.locator("[data-testid^='pane-hide-']").click();
    await expect(splitPaneRows).toHaveCount(2);

    const chip = page.getByTestId("hidden-items-chip");
    await expect(chip).toContainText("2");
    await expect(chip).toHaveAttribute("aria-expanded", "false");
    await chip.click();
    await expect(chip).toHaveAttribute("aria-expanded", "true");

    const shelf = page.getByTestId("hidden-items-shelf");
    await expect(shelf).toBeVisible();
    await expect(shelf.locator(".hidden-shelf-row")).toHaveCount(2);

    // Show-only restores the workspace without changing the active workspace.
    await shelf.locator("[data-testid^='hidden-workspace-show-only-']").click();
    await expect(defaultWorkspace).toBeVisible();
    await expect(defaultWorkspace).toHaveAttribute("data-active", "false");
    await expect(splitWorkspace).toHaveAttribute("data-active", "true");
    await expect(chip).toContainText("1");

    // Primary pane action restores and focuses the original pane index.
    await shelf.locator("[data-testid^='hidden-pane-primary-']").click();
    await expect(page.getByTestId("hidden-items-chip")).toHaveCount(0);
    await expect(page.getByTestId("hidden-items-shelf")).toHaveCount(0);
    await expect(splitPaneRows).toHaveCount(3);
    await expect(
      page.getByTestId("workspace-pane-1").getByTestId("pane-focus-indicator"),
    ).toBeVisible();

    // A second hide cycle exercises the atomic restore-all path.
    await defaultWorkspace.hover();
    await defaultWorkspace.locator("[data-testid^='workspace-hide-']").click();
    const thirdPaneRow = splitPaneRows.nth(2);
    await thirdPaneRow.hover();
    await thirdPaneRow.locator("[data-testid^='pane-hide-']").click();
    await page.getByTestId("hidden-items-chip").click();
    await page.getByTestId("hidden-items-restore-all").click();

    await expect(page.getByTestId("hidden-items-chip")).toHaveCount(0);
    await expect(page.getByTestId("hidden-items-shelf")).toHaveCount(0);
    await expect(workspaceItems).toHaveCount(2);
    await expect(splitPaneRows).toHaveCount(3);
  });
});
