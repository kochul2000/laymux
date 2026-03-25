import { test, expect } from "./fixtures";

test.describe("Keyboard Shortcuts - Workspace Switching", () => {
  test.beforeEach(async ({ appPage: page }) => {
    // Wait for session persistence to load
    await page.waitForTimeout(500);

    // Create a second workspace
    await page.getByTestId("add-workspace-btn").click();
    const dialog = page.getByTestId("layout-select-dialog");
    if (await dialog.isVisible().catch(() => false)) {
      await page.getByTestId("layout-option-0").click();
    }
    // Ensure we have 2 workspaces
    await expect(page.locator("[data-testid^='workspace-item-']")).toHaveCount(2);
  });

  test("Ctrl+1 switches to first workspace", async ({ appPage: page }) => {
    // Switch to second workspace first
    await page.locator("[data-testid^='workspace-item-']").nth(1).click();
    await expect(page.locator("[data-testid^='workspace-item-']").nth(1)).toHaveAttribute("data-active", "true");

    // Now Ctrl+1 should switch back to first
    await page.keyboard.press("Control+1");
    await expect(page.locator("[data-testid^='workspace-item-']").nth(0)).toHaveAttribute("data-active", "true");
  });

  test("Ctrl+2 switches to second workspace", async ({ appPage: page }) => {
    await page.keyboard.press("Control+2");
    await expect(page.locator("[data-testid^='workspace-item-']").nth(1)).toHaveAttribute("data-active", "true");
  });

  test("Ctrl+9 switches to last workspace", async ({ appPage: page }) => {
    await page.keyboard.press("Control+9");
    await expect(page.locator("[data-testid^='workspace-item-']").last()).toHaveAttribute("data-active", "true");
  });

  test("Ctrl+] cycles to next workspace", async ({ appPage: page }) => {
    // Start on workspace 1
    await page.keyboard.press("Control+1");
    await expect(page.locator("[data-testid^='workspace-item-']").nth(0)).toHaveAttribute("data-active", "true");

    // Ctrl+] goes to next
    await page.keyboard.press("Control+]");
    await expect(page.locator("[data-testid^='workspace-item-']").nth(1)).toHaveAttribute("data-active", "true");
  });

  test("Ctrl+[ cycles to previous workspace", async ({ appPage: page }) => {
    // Start on workspace 2
    await page.keyboard.press("Control+2");

    // Ctrl+[ goes to previous
    await page.keyboard.press("Control+[");
    await expect(page.locator("[data-testid^='workspace-item-']").nth(0)).toHaveAttribute("data-active", "true");
  });

  test("Ctrl+] wraps around from last to first", async ({ appPage: page }) => {
    // Go to last workspace
    await page.keyboard.press("Control+9");
    await expect(page.locator("[data-testid^='workspace-item-']").last()).toHaveAttribute("data-active", "true");

    // Ctrl+] should wrap to first
    await page.keyboard.press("Control+]");
    await expect(page.locator("[data-testid^='workspace-item-']").nth(0)).toHaveAttribute("data-active", "true");
  });
});

test.describe("Keyboard Shortcuts - Sidebar Toggle", () => {
  test("Ctrl+B toggles left dock visibility", async ({ appPage: page }) => {
    await expect(page.getByTestId("dock-left")).toBeVisible();

    await page.keyboard.press("Control+b");
    await expect(page.getByTestId("dock-left")).not.toBeVisible();

    await page.keyboard.press("Control+b");
    await expect(page.getByTestId("dock-left")).toBeVisible();
  });
});

test.describe("Keyboard Shortcuts - Settings Modal", () => {
  test("Ctrl+, toggles settings modal", async ({ appPage: page }) => {
    await expect(page.getByTestId("settings-modal")).not.toBeVisible();

    await page.keyboard.press("Control+,");
    await expect(page.getByTestId("settings-modal")).toBeVisible();

    await page.keyboard.press("Control+,");
    await expect(page.getByTestId("settings-modal")).not.toBeVisible();
  });
});

test.describe("Keyboard Shortcuts - Close Workspace", () => {
  test("Ctrl+Shift+W closes current workspace when multiple exist", async ({ appPage: page }) => {
    await page.waitForTimeout(500);

    // Add a second workspace
    await page.getByTestId("add-workspace-btn").click();
    const dialog = page.getByTestId("layout-select-dialog");
    if (await dialog.isVisible().catch(() => false)) {
      await page.getByTestId("layout-option-0").click();
    }
    await expect(page.locator("[data-testid^='workspace-item-']")).toHaveCount(2);

    // Close current workspace
    await page.keyboard.press("Control+Shift+W");
    await expect(page.locator("[data-testid^='workspace-item-']")).toHaveCount(1);
  });

  test("Ctrl+Shift+W does nothing when only one workspace exists", async ({ appPage: page }) => {
    await expect(page.locator("[data-testid^='workspace-item-']")).toHaveCount(1);
    await page.keyboard.press("Control+Shift+W");
    await expect(page.locator("[data-testid^='workspace-item-']")).toHaveCount(1);
  });
});

test.describe("Keyboard Shortcuts - Rename Workspace", () => {
  test("Ctrl+Shift+R opens rename prompt", async ({ appPage: page }) => {
    page.on("dialog", async (dialog) => {
      expect(dialog.type()).toBe("prompt");
      expect(dialog.defaultValue()).toBe("Default");
      await dialog.accept("Renamed WS");
    });

    await page.keyboard.press("Control+Shift+R");

    // Workspace name should be updated in the selector
    await expect(page.getByText("Renamed WS")).toBeVisible();
  });

  test("Ctrl+Shift+R cancel does not rename", async ({ appPage: page }) => {
    page.on("dialog", async (dialog) => {
      await dialog.dismiss();
    });

    await page.keyboard.press("Control+Shift+R");

    // Name should remain "Default"
    await expect(page.getByText("Default")).toBeVisible();
  });
});

test.describe("Keyboard Shortcuts - Delete Pane", () => {
  test("Delete key removes focused pane in edit mode", async ({ appPage: page }) => {
    // Enter edit mode and split
    await page.getByTestId("edit-mode-toggle").click();
    await page.locator("[data-testid='workspace-pane-0']").click();
    await page.getByTestId("split-vertical-btn").click();
    await expect(page.locator("[data-testid^='workspace-pane-']")).toHaveCount(2);

    // Focus second pane and press Delete
    await page.locator("[data-testid='workspace-pane-1']").click();
    await page.keyboard.press("Delete");

    await expect(page.locator("[data-testid^='workspace-pane-']")).toHaveCount(1);
  });

  test("Delete key does nothing when edit mode is off", async ({ appPage: page }) => {
    // Split first, then exit edit mode
    await page.getByTestId("edit-mode-toggle").click();
    await page.locator("[data-testid='workspace-pane-0']").click();
    await page.getByTestId("split-vertical-btn").click();
    await page.getByTestId("edit-mode-toggle").click(); // exit

    await expect(page.locator("[data-testid^='workspace-pane-']")).toHaveCount(2);

    await page.keyboard.press("Delete");
    // Should still have 2 panes
    await expect(page.locator("[data-testid^='workspace-pane-']")).toHaveCount(2);
  });
});
