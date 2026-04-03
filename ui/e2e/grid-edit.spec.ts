import { test, expect } from "./fixtures";

/**
 * Grid edit tests use PaneControlBar (hover-based) for split/delete/view-switch.
 * There is no global "edit mode toggle" — pane controls appear on hover.
 */

/** Helper: hover over pane to reveal PaneControlBar. */
async function hoverPane(page: import("@playwright/test").Page, index: number) {
  const pane = page.locator(`[data-testid='workspace-pane-${index}']`);
  await pane.hover();
  // Wait for the control bar to appear
  await expect(pane.locator("[data-testid='pane-control-bar']")).toBeVisible({ timeout: 3000 });
}

test.describe("Pane Split", () => {
  test("hovering a pane shows control bar", async ({ appPage: page }) => {
    await hoverPane(page, 0);
    await expect(
      page.locator("[data-testid='workspace-pane-0']").locator("[data-testid='pane-control-bar']"),
    ).toBeVisible();
  });

  test("split horizontal creates 2 panes stacked vertically", async ({ appPage: page }) => {
    await hoverPane(page, 0);
    await page.getByTestId("pane-control-split-h").click();

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
    await hoverPane(page, 0);
    await page.getByTestId("pane-control-split-v").click();

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
    await hoverPane(page, 0);
    await page.getByTestId("pane-control-split-v").click();
    await expect(page.locator("[data-testid^='workspace-pane-']")).toHaveCount(2);

    // Hover first pane again and split horizontally
    await hoverPane(page, 0);
    await page.getByTestId("pane-control-split-h").click();
    await expect(page.locator("[data-testid^='workspace-pane-']")).toHaveCount(3);
  });

  test("new panes default to EmptyView", async ({ appPage: page }) => {
    await hoverPane(page, 0);
    await page.getByTestId("pane-control-split-v").click();

    // The new pane (pane 1) should contain an EmptyView
    await expect(
      page.locator("[data-testid='workspace-pane-1'] [data-testid='empty-view']"),
    ).toBeVisible();
  });
});

test.describe("Pane Delete", () => {
  test("delete button removes a pane", async ({ appPage: page }) => {
    // Split first to have 2 panes
    await hoverPane(page, 0);
    await page.getByTestId("pane-control-split-v").click();
    await expect(page.locator("[data-testid^='workspace-pane-']")).toHaveCount(2);

    // Hover second pane and delete it
    await hoverPane(page, 1);
    await page.getByTestId("pane-control-delete").click();

    await expect(page.locator("[data-testid^='workspace-pane-']")).toHaveCount(1);
  });
});

test.describe("View Switcher", () => {
  test("pane control bar has view type selector", async ({ appPage: page }) => {
    await hoverPane(page, 0);
    await expect(page.getByTestId("pane-control-view-select")).toBeVisible();
  });

  test("changing view type in dropdown switches the view", async ({ appPage: page }) => {
    await hoverPane(page, 0);
    await page.getByTestId("pane-control-view-select").selectOption("BrowserPreviewView");
    await expect(page.getByTestId("browser-preview")).toBeVisible();
  });
});

test.describe("Layout Export", () => {
  test("grid edit toolbar has export button", async ({ appPage: page }) => {
    await expect(page.getByTestId("grid-edit-toolbar")).toBeVisible();
    await expect(page.getByTestId("export-new-btn")).toBeVisible();
  });

  test("export-new prompts for layout name", async ({ appPage: page }) => {
    // Set up dialog handler before clicking
    page.on("dialog", async (dialog) => {
      expect(dialog.type()).toBe("prompt");
      await dialog.accept("My Custom Layout");
    });

    await page.getByTestId("export-new-btn").click();

    // Page should still be stable
    await expect(page.getByTestId("grid-edit-toolbar")).toBeVisible();
  });
});

test.describe("Boundary Handles", () => {
  test("boundary handles appear between panes after split", async ({ appPage: page }) => {
    await hoverPane(page, 0);
    await page.getByTestId("pane-control-split-v").click();

    const handles = page.locator("[data-testid^='boundary-handle-']");
    await expect(handles.first()).toBeVisible();
  });

  test("no boundary handles with single pane", async ({ appPage: page }) => {
    const handles = page.locator("[data-testid^='boundary-handle-']");
    await expect(handles).toHaveCount(0);
  });
});
