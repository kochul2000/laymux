import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/**
 * The window controls outrank every other top bar occupant (ADR-0123): at any
 * width the app can be shown at, minimize / maximize / close stay whole and
 * on screen, and whatever else the bar carries yields the space instead.
 *
 * Boxes are polled rather than read once — the toolbar reflows over a frame
 * after a viewport change, and under a loaded dev server the stylesheet can
 * still be landing when the first measurement would run.
 */

const CONTROL_IDS = ["window-minimize", "window-maximize", "window-close"] as const;

async function controlBoxes(page: Page) {
  const boxes: Record<string, { x: number; width: number } | null> = {};
  for (const id of CONTROL_IDS) {
    boxes[id] = await page.getByTestId(id).boundingBox();
  }
  return boxes;
}

async function expectControlsWhole(page: Page, viewportWidth: number) {
  await expect
    .poll(
      async () => {
        const boxes = await controlBoxes(page);
        return CONTROL_IDS.map((id) => {
          const box = boxes[id];
          if (!box) return `${id}: no box`;
          if (box.width < 46) return `${id}: squeezed to ${box.width}`;
          if (box.x < 0) return `${id}: starts at ${box.x}`;
          if (box.x + box.width > viewportWidth + 1) {
            return `${id}: ends at ${box.x + box.width} past ${viewportWidth}`;
          }
          return `${id}: ok`;
        }).join(", ");
      },
      { timeout: 5000 },
    )
    .toBe(CONTROL_IDS.map((id) => `${id}: ok`).join(", "));
}

test.describe("Top bar window controls", () => {
  // 300px is the narrowest width the decision claims: three 46px buttons plus
  // the reserved drag region and the bar's own padding and gaps floor at ~262.
  for (const width of [1200, 700, 480, 360, 300]) {
    test(`stay whole and on screen at ${width}px`, async ({ appPage: page }) => {
      await page.setViewportSize({ width, height: 600 });
      await expect(page.getByTestId("grid-edit-toolbar")).toBeVisible();

      await expectControlsWhole(page, width);
    });
  }

  test("close button hugs the right edge when the bar is crowded", async ({ appPage: page }) => {
    await page.setViewportSize({ width: 420, height: 600 });
    await expect(page.getByTestId("grid-edit-toolbar")).toBeVisible();
    await expectControlsWhole(page, 420);

    const close = await page.getByTestId("window-close").boundingBox();
    expect(close).toBeTruthy();
    expect(close!.x + close!.width).toBeGreaterThan(420 - 2);
  });

  test("app chrome yields before the window controls do", async ({ appPage: page }) => {
    await page.setViewportSize({ width: 360, height: 600 });
    await expect(page.getByTestId("grid-edit-toolbar")).toBeVisible();
    await expectControlsWhole(page, 360);

    // The dock cross is the first thing the right cluster sheds; the settings
    // gear next to the window controls is the last. Whichever survives, none of
    // it may sit on top of the window controls.
    const minimize = await page.getByTestId("window-minimize").boundingBox();
    const gear = await page.getByTestId("settings-gear-btn").boundingBox();
    expect(minimize).toBeTruthy();
    if (gear && gear.width > 0) {
      expect(gear.x + gear.width).toBeLessThanOrEqual(minimize!.x + 1);
    }
  });
});
