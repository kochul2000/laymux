import { test, expect } from "./fixtures";

test("app loads and renders root", async ({ appPage: page }) => {
  await expect(page.getByTestId("app-root")).toBeVisible();
});

test("grid edit toolbar is visible", async ({ appPage: page }) => {
  await expect(page.getByTestId("grid-edit-toolbar")).toBeVisible();
});

test("left dock renders with WorkspaceSelectorView", async ({ appPage: page }) => {
  await expect(page.getByTestId("dock-left")).toBeVisible();
  await expect(page.getByTestId("workspace-selector")).toBeVisible();
});

test("workspace area renders", async ({ appPage: page }) => {
  await expect(page.getByTestId("workspace-area")).toBeVisible();
});
