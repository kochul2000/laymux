import { test as base, type Page } from "@playwright/test";
import { TAURI_MOCK_SCRIPT } from "./tauri-mock";

/**
 * Custom test fixture that injects the Tauri mock before every page navigation.
 */
export const test = base.extend<{ appPage: Page }>({
  appPage: async ({ page }, use) => {
    await page.addInitScript(TAURI_MOCK_SCRIPT);
    await page.goto("/", { waitUntil: "networkidle" });
    // Wait for app to hydrate
    await page.waitForSelector("[data-testid='app-root']", { timeout: 10000 });
    await use(page);
  },
});

export { expect } from "@playwright/test";
