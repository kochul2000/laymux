import { test, expect } from "./fixtures";

/**
 * Keyboard shortcut tests. Actual bindings use Ctrl+Alt for workspace operations,
 * Ctrl+Shift+B for sidebar, Ctrl+, for settings.
 */

/** Helper: create a second workspace via Ctrl+Alt+N shortcut. */
async function createSecondWorkspace(page: import("@playwright/test").Page) {
  await page.waitForTimeout(500);
  await page.keyboard.press("Control+Alt+N");
  await expect(page.locator("[data-testid^='workspace-item-']")).toHaveCount(2);
}

/** Helper: hover over pane to reveal PaneControlBar. */
async function hoverPane(page: import("@playwright/test").Page, index: number) {
  const pane = page.locator(`[data-testid='workspace-pane-${index}']`);
  await pane.hover();
  await expect(pane.locator("[data-testid='pane-control-bar']")).toBeVisible({ timeout: 3000 });
}

test.describe("Keyboard Shortcuts - Workspace Switching", () => {
  test.beforeEach(async ({ appPage: page }) => {
    await createSecondWorkspace(page);
  });

  test("Ctrl+Alt+1 switches to first workspace", async ({ appPage: page }) => {
    // Switch to second workspace first
    await page.locator("[data-testid^='workspace-item-']").nth(1).click();
    await expect(page.locator("[data-testid^='workspace-item-']").nth(1)).toHaveAttribute(
      "data-active",
      "true",
    );

    // Now Ctrl+Alt+1 should switch back to first
    await page.keyboard.press("Control+Alt+1");
    await expect(page.locator("[data-testid^='workspace-item-']").nth(0)).toHaveAttribute(
      "data-active",
      "true",
    );
  });

  test("Ctrl+Alt+2 switches to second workspace", async ({ appPage: page }) => {
    await page.keyboard.press("Control+Alt+2");
    await expect(page.locator("[data-testid^='workspace-item-']").nth(1)).toHaveAttribute(
      "data-active",
      "true",
    );
  });

  test("Ctrl+Alt+9 switches to last workspace", async ({ appPage: page }) => {
    await page.keyboard.press("Control+Alt+9");
    await expect(page.locator("[data-testid^='workspace-item-']").last()).toHaveAttribute(
      "data-active",
      "true",
    );
  });

  test("Ctrl+Alt+ArrowDown cycles to next workspace", async ({ appPage: page }) => {
    // Start on workspace 1
    await page.keyboard.press("Control+Alt+1");
    await expect(page.locator("[data-testid^='workspace-item-']").nth(0)).toHaveAttribute(
      "data-active",
      "true",
    );

    // Ctrl+Alt+ArrowDown goes to next
    await page.keyboard.press("Control+Alt+ArrowDown");
    await expect(page.locator("[data-testid^='workspace-item-']").nth(1)).toHaveAttribute(
      "data-active",
      "true",
    );
  });

  test("Ctrl+Alt+ArrowUp cycles to previous workspace", async ({ appPage: page }) => {
    // Start on workspace 2
    await page.keyboard.press("Control+Alt+2");

    // Ctrl+Alt+ArrowUp goes to previous
    await page.keyboard.press("Control+Alt+ArrowUp");
    await expect(page.locator("[data-testid^='workspace-item-']").nth(0)).toHaveAttribute(
      "data-active",
      "true",
    );
  });

  test("Ctrl+Alt+ArrowDown wraps around from last to first", async ({ appPage: page }) => {
    // Go to last workspace
    await page.keyboard.press("Control+Alt+9");
    await expect(page.locator("[data-testid^='workspace-item-']").last()).toHaveAttribute(
      "data-active",
      "true",
    );

    // Ctrl+Alt+ArrowDown should wrap to first
    await page.keyboard.press("Control+Alt+ArrowDown");
    await expect(page.locator("[data-testid^='workspace-item-']").nth(0)).toHaveAttribute(
      "data-active",
      "true",
    );
  });
});

test.describe("Keyboard Shortcuts - Sidebar Toggle", () => {
  test("Ctrl+Shift+B toggles left dock visibility", async ({ appPage: page }) => {
    await expect(page.getByTestId("dock-left")).toBeVisible();

    await page.keyboard.press("Control+Shift+B");
    await expect(page.getByTestId("dock-left")).not.toBeVisible();

    await page.keyboard.press("Control+Shift+B");
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
  test("Ctrl+Alt+W closes current workspace when multiple exist", async ({ appPage: page }) => {
    await page.waitForTimeout(500);
    await page.keyboard.press("Control+Alt+N");
    await expect(page.locator("[data-testid^='workspace-item-']")).toHaveCount(2);

    // Close current workspace
    await page.keyboard.press("Control+Alt+W");
    await expect(page.locator("[data-testid^='workspace-item-']")).toHaveCount(1);
  });

  test("Ctrl+Alt+W does nothing when only one workspace exists", async ({ appPage: page }) => {
    await expect(page.locator("[data-testid^='workspace-item-']")).toHaveCount(1);
    await page.keyboard.press("Control+Alt+W");
    await expect(page.locator("[data-testid^='workspace-item-']")).toHaveCount(1);
  });
});

test.describe("Keyboard Shortcuts - Rename Workspace", () => {
  test("Ctrl+Alt+R opens rename prompt", async ({ appPage: page }) => {
    page.on("dialog", async (dialog) => {
      expect(dialog.type()).toBe("prompt");
      expect(dialog.defaultValue()).toBe("Default");
      await dialog.accept("Renamed WS");
    });

    await page.keyboard.press("Control+Alt+R");

    // Workspace name should be updated in the selector
    await expect(page.getByTestId("workspace-name-ws-default")).toHaveText("Renamed WS");
  });

  test("Ctrl+Alt+R cancel does not rename", async ({ appPage: page }) => {
    page.on("dialog", async (dialog) => {
      await dialog.dismiss();
    });

    await page.keyboard.press("Control+Alt+R");

    // Name should remain "Default"
    await expect(page.getByTestId("workspace-name-ws-default")).toHaveText("Default");
  });
});

test.describe("Keyboard Shortcuts - Delete Pane", () => {
  test("Delete key removes focused pane when multiple exist", async ({ appPage: page }) => {
    // Split to get 2 panes
    await hoverPane(page, 0);
    await page.getByTestId("pane-control-split-v").click();
    await expect(page.locator("[data-testid^='workspace-pane-']")).toHaveCount(2);

    // Focus second pane via mousedown (sets focusedPaneIndex) then blur text inputs
    await page.locator("[data-testid='workspace-pane-1']").dispatchEvent("mousedown");
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    await page.keyboard.press("Delete");

    await expect(page.locator("[data-testid^='workspace-pane-']")).toHaveCount(1);
  });
});
