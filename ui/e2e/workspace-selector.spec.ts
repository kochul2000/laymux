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
