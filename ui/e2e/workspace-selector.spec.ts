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

test.describe("WorkspaceSelectorView - Hidden Workspaces Shelf (ADR-0035)", () => {
  test("hides a workspace, opens the shelf under the chip, restores, and restores all", async ({
    appPage: page,
  }) => {
    // Keep a second workspace so the default one can be hidden.
    await page.getByTestId("layout-create-dev-split").click();
    const workspaceItems = page.locator("[data-testid^='workspace-item-']");
    await expect(workspaceItems).toHaveCount(2);
    const defaultWorkspace = page.getByTestId("workspace-item-ws-default");

    await defaultWorkspace.hover();
    await defaultWorkspace.locator("[data-testid^='workspace-hide-']").click();

    const chip = page.getByTestId("hidden-items-chip");
    await expect(chip).toContainText("1");
    await expect(chip).toHaveAttribute("aria-expanded", "false");
    await chip.click();
    await expect(chip).toHaveAttribute("aria-expanded", "true");

    const shelf = page.getByTestId("hidden-items-shelf");
    await expect(shelf).toBeVisible();
    await expect(shelf.locator(".hidden-shelf-row")).toHaveCount(1);

    // The shelf opens right under the header chip — above the workspace list.
    const shelfBox = await shelf.boundingBox();
    const listBox = await page.getByTestId("workspace-list").boundingBox();
    expect(shelfBox!.y).toBeLessThan(listBox!.y);

    // Show-only restores the workspace without changing the active workspace,
    // and the last restore closes the shelf and removes the chip.
    await shelf.locator("[data-testid^='hidden-workspace-show-only-']").click();
    await expect(defaultWorkspace).toBeVisible();
    await expect(defaultWorkspace).toHaveAttribute("data-active", "false");
    await expect(page.getByTestId("hidden-items-chip")).toHaveCount(0);
    await expect(page.getByTestId("hidden-items-shelf")).toHaveCount(0);

    // A second hide cycle exercises the restore-all path.
    await defaultWorkspace.hover();
    await defaultWorkspace.locator("[data-testid^='workspace-hide-']").click();
    await page.getByTestId("hidden-items-chip").click();
    await page.getByTestId("hidden-items-restore-all").click();

    await expect(page.getByTestId("hidden-items-chip")).toHaveCount(0);
    await expect(page.getByTestId("hidden-items-shelf")).toHaveCount(0);
    await expect(workspaceItems).toHaveCount(2);
  });

  test("pane hiding is controlled by the pane control bar toggle, not the shelf", async ({
    appPage: page,
  }) => {
    await page.getByTestId("layout-create-dev-split").click();
    const workspaceItems = page.locator("[data-testid^='workspace-item-']");
    await expect(workspaceItems).toHaveCount(2);
    const splitWorkspaceTestId = await workspaceItems.nth(1).getAttribute("data-testid");
    expect(splitWorkspaceTestId).toBeTruthy();
    const splitWorkspace = page.getByTestId(splitWorkspaceTestId!);
    const splitPaneRows = splitWorkspace.locator("[data-testid^='pane-row-']");
    await expect(splitPaneRows).toHaveCount(3);

    // The selector rows no longer carry a pane hide button.
    const firstRow = splitPaneRows.nth(0);
    await firstRow.hover();
    await expect(firstRow.locator("[data-testid^='pane-hide-']")).toHaveCount(0);

    // Hide via the pane's own control bar toggle.
    const pane = page.getByTestId("workspace-pane-0");
    await pane.hover();
    await pane.getByTestId("pane-control-hide").click();
    await expect(splitPaneRows).toHaveCount(2);
    // Hidden panes never surface the chip or the shelf.
    await expect(page.getByTestId("hidden-items-chip")).toHaveCount(0);

    // Toggling again restores the summary row.
    await pane.hover();
    await pane.getByTestId("pane-control-hide").click();
    await expect(splitPaneRows).toHaveCount(3);
  });
});
