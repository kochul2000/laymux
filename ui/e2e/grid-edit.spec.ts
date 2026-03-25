import { test, expect } from "./fixtures";

test.describe("Grid Edit Mode", () => {
  test("edit mode toggle button shows Edit OFF by default", async ({ appPage: page }) => {
    const toggle = page.getByTestId("edit-mode-toggle");
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveText("Edit OFF");
  });

  test("clicking toggle switches to Edit ON and shows edit controls", async ({ appPage: page }) => {
    await page.getByTestId("edit-mode-toggle").click();
    await expect(page.getByTestId("edit-mode-toggle")).toHaveText("Edit ON");

    // All edit mode buttons should appear
    await expect(page.getByTestId("split-horizontal-btn")).toBeVisible();
    await expect(page.getByTestId("split-vertical-btn")).toBeVisible();
    await expect(page.getByTestId("delete-pane-btn")).toBeVisible();
    await expect(page.getByTestId("save-btn")).toBeVisible();
    await expect(page.getByTestId("save-propagate-btn")).toBeVisible();
    await expect(page.getByTestId("save-as-btn")).toBeVisible();
    await expect(page.getByTestId("revert-btn")).toBeVisible();
  });

  test("edit controls hidden when mode is OFF", async ({ appPage: page }) => {
    await expect(page.getByTestId("split-horizontal-btn")).not.toBeVisible();
    await expect(page.getByTestId("split-vertical-btn")).not.toBeVisible();
    await expect(page.getByTestId("delete-pane-btn")).not.toBeVisible();
    await expect(page.getByTestId("save-btn")).not.toBeVisible();
  });

  test("toggle back to OFF hides edit controls", async ({ appPage: page }) => {
    await page.getByTestId("edit-mode-toggle").click();
    await expect(page.getByTestId("split-horizontal-btn")).toBeVisible();

    await page.getByTestId("edit-mode-toggle").click();
    await expect(page.getByTestId("edit-mode-toggle")).toHaveText("Edit OFF");
    await expect(page.getByTestId("split-horizontal-btn")).not.toBeVisible();
  });
});

test.describe("Pane Split", () => {
  test("clicking pane in edit mode focuses it (shows outline)", async ({ appPage: page }) => {
    // Enter edit mode
    await page.getByTestId("edit-mode-toggle").click();

    // Click the first pane
    await page.locator("[data-testid='workspace-pane-0']").click();

    // Pane should get an outline (accent color)
    const style = await page.locator("[data-testid='workspace-pane-0']").getAttribute("style");
    expect(style).toContain("outline");
  });

  test("split horizontal creates 2 panes stacked vertically", async ({ appPage: page }) => {
    await page.getByTestId("edit-mode-toggle").click();
    await page.locator("[data-testid='workspace-pane-0']").click();
    await page.getByTestId("split-horizontal-btn").click();

    const panes = page.locator("[data-testid^='workspace-pane-']");
    await expect(panes).toHaveCount(2);

    // Second pane should be below the first
    const box0 = await page.locator("[data-testid='workspace-pane-0']").boundingBox();
    const box1 = await page.locator("[data-testid='workspace-pane-1']").boundingBox();
    expect(box0).toBeTruthy();
    expect(box1).toBeTruthy();
    expect(box1!.y).toBeGreaterThan(box0!.y);
  });

  test("split vertical creates 2 panes side by side", async ({ appPage: page }) => {
    await page.getByTestId("edit-mode-toggle").click();
    await page.locator("[data-testid='workspace-pane-0']").click();
    await page.getByTestId("split-vertical-btn").click();

    const panes = page.locator("[data-testid^='workspace-pane-']");
    await expect(panes).toHaveCount(2);

    // Second pane should be to the right of the first
    const box0 = await page.locator("[data-testid='workspace-pane-0']").boundingBox();
    const box1 = await page.locator("[data-testid='workspace-pane-1']").boundingBox();
    expect(box0).toBeTruthy();
    expect(box1).toBeTruthy();
    expect(box1!.x).toBeGreaterThan(box0!.x);
  });

  test("multiple splits create multiple panes", async ({ appPage: page }) => {
    await page.getByTestId("edit-mode-toggle").click();
    await page.locator("[data-testid='workspace-pane-0']").click();
    await page.getByTestId("split-vertical-btn").click();
    await expect(page.locator("[data-testid^='workspace-pane-']")).toHaveCount(2);

    // Focus the first pane again and split horizontally
    await page.locator("[data-testid='workspace-pane-0']").click();
    await page.getByTestId("split-horizontal-btn").click();
    await expect(page.locator("[data-testid^='workspace-pane-']")).toHaveCount(3);
  });

  test("new panes default to EmptyView", async ({ appPage: page }) => {
    await page.getByTestId("edit-mode-toggle").click();
    await page.locator("[data-testid='workspace-pane-0']").click();
    await page.getByTestId("split-vertical-btn").click();

    // The new pane (pane 1) should contain an EmptyView
    await expect(page.locator("[data-testid='workspace-pane-1'] [data-testid='empty-view']")).toBeVisible();
  });
});

test.describe("Pane Delete", () => {
  test("delete button removes focused pane", async ({ appPage: page }) => {
    // Split first to have 2 panes
    await page.getByTestId("edit-mode-toggle").click();
    await page.locator("[data-testid='workspace-pane-0']").click();
    await page.getByTestId("split-vertical-btn").click();
    await expect(page.locator("[data-testid^='workspace-pane-']")).toHaveCount(2);

    // Focus and delete the second pane
    await page.locator("[data-testid='workspace-pane-1']").click();
    await page.getByTestId("delete-pane-btn").click();

    await expect(page.locator("[data-testid^='workspace-pane-']")).toHaveCount(1);
  });
});

test.describe("View Switcher in Edit Mode", () => {
  test("focused pane shows view type selector dropdown", async ({ appPage: page }) => {
    await page.getByTestId("edit-mode-toggle").click();
    await page.locator("[data-testid='workspace-pane-0']").click();
    await expect(page.getByTestId("view-switcher-0")).toBeVisible();
  });

  test("changing view type in dropdown switches the view", async ({ appPage: page }) => {
    await page.getByTestId("edit-mode-toggle").click();
    await page.locator("[data-testid='workspace-pane-0']").click();

    // Change to BrowserPreviewView
    await page.getByTestId("view-switcher-0").selectOption("BrowserPreviewView");
    await expect(page.getByTestId("browser-preview")).toBeVisible();
  });

  test("view switcher not visible when edit mode is OFF", async ({ appPage: page }) => {
    await expect(page.locator("[data-testid='view-switcher-0']")).not.toBeVisible();
  });
});

test.describe("Save Actions", () => {
  test("revert restores layout to original state after split", async ({ appPage: page }) => {
    await page.getByTestId("edit-mode-toggle").click();
    await page.locator("[data-testid='workspace-pane-0']").click();
    await page.getByTestId("split-vertical-btn").click();
    await expect(page.locator("[data-testid^='workspace-pane-']")).toHaveCount(2);

    await page.getByTestId("revert-btn").click();
    await expect(page.locator("[data-testid^='workspace-pane-']")).toHaveCount(1);
  });

  test("save button does not throw (calls persistSession)", async ({ appPage: page }) => {
    await page.getByTestId("edit-mode-toggle").click();
    // Just verify the button is clickable without error
    await page.getByTestId("save-btn").click();
    // Page should still be functional
    await expect(page.getByTestId("grid-edit-toolbar")).toBeVisible();
  });

  test("save-as prompts for layout name", async ({ appPage: page }) => {
    await page.getByTestId("edit-mode-toggle").click();

    // Set up dialog handler before clicking
    page.on("dialog", async (dialog) => {
      expect(dialog.type()).toBe("prompt");
      await dialog.accept("My Custom Layout");
    });

    await page.getByTestId("save-as-btn").click();

    // Page should still be stable
    await expect(page.getByTestId("grid-edit-toolbar")).toBeVisible();
  });
});

test.describe("Boundary Handles", () => {
  test("boundary handles appear between panes in edit mode", async ({ appPage: page }) => {
    await page.getByTestId("edit-mode-toggle").click();
    await page.locator("[data-testid='workspace-pane-0']").click();
    await page.getByTestId("split-vertical-btn").click();

    const handles = page.locator("[data-testid^='boundary-handle-']");
    await expect(handles.first()).toBeVisible();
  });

  test("no boundary handles in normal mode", async ({ appPage: page }) => {
    const handles = page.locator("[data-testid^='boundary-handle-']");
    await expect(handles).toHaveCount(0);
  });

  test("no boundary handles with single pane in edit mode", async ({ appPage: page }) => {
    await page.getByTestId("edit-mode-toggle").click();
    const handles = page.locator("[data-testid^='boundary-handle-']");
    await expect(handles).toHaveCount(0);
  });
});
