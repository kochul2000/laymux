import { expect, test, type Page } from "@playwright/test";
import { remoteClientMarkupWithoutXterm } from "./remote-client-assets";

test.use({ hasTouch: true });

async function open(page: Page) {
  await page.route("http://remote.test/", (route) => route.fulfill({ body: "<!doctype html>" }));
  await page.goto("http://remote.test/");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(remoteClientMarkupWithoutXterm());
  await page.locator("#drawerSettingsButton").click();
  await page.getByRole("tab", { name: "Floating", exact: true }).click();
}

const stored = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("laymux.remote.keybar") || "{}").floating);

test("floating pads and repeated tap buttons persist with independent size and position", async ({
  page,
}, testInfo) => {
  await open(page);
  await expect(page.locator("#floatingControls > *")).toHaveCount(0);
  await page.getByLabel("Arrow pad enabled").check();
  await page.getByLabel("Pane / alert pad enabled").check();
  await page.getByLabel("Pane / alert pad Y").fill("35");
  await page.getByLabel("Pane / alert pad Y").dispatchEvent("change");
  await page.getByLabel("Arrow pad size").fill("88");
  await page.getByLabel("Arrow pad size").dispatchEvent("change");
  await page.getByLabel("Arrow pad X").fill("25");
  await page.getByLabel("Arrow pad X").dispatchEvent("change");
  await page.getByLabel("Floating button action").selectOption("composer");
  await page.getByRole("button", { name: "Add floating button", exact: true }).click();
  await page.getByRole("button", { name: "Add floating button", exact: true }).click();
  await expect(page.locator("#floatingControls > *")).toHaveCount(4);
  await page.screenshot({ path: testInfo.outputPath("floating-settings.png") });
  await page.locator("#navToggle").click();
  await expect(page.locator("#navToggle")).toHaveAttribute("aria-expanded", "false");
  await expect
    .poll(async () => {
      const box = (await page.locator("#navigationPanel").boundingBox())!;
      return box.x + box.width;
    })
    .toBeLessThanOrEqual(0);
  await page.locator('#floatingControls [data-input-action="composer"]').first().hover();
  await page.screenshot({ path: testInfo.outputPath("floating-controls.png") });
  await page.locator("#navToggle").click();
  await page.locator("#drawerSettingsButton").click();
  expect(await stored(page)).toMatchObject({ pads: { dpad: { size: 88, x: 0.25 } } });
  await page.getByLabel("Arrow pad enabled").uncheck();
  await expect(page.locator('#floatingControls [data-floating-id="dpad"]')).toHaveCount(0);
  await page.reload();
  await page.setContent(remoteClientMarkupWithoutXterm());
  await expect(page.locator("#floatingControls > *")).toHaveCount(3);
  await page.locator("#drawerSettingsButton").click();
  await page.getByRole("button", { name: "Remove floating button" }).first().click();
  await expect(page.locator("#floatingControls > *")).toHaveCount(2);
});

test("touch cancellation restores position and touch drag suppresses tap", async ({ page }) => {
  await open(page);
  await page.getByLabel("Floating button action").selectOption("composer");
  await page.getByRole("button", { name: "Add floating button", exact: true }).click();
  await page.locator("#navToggle").click();
  const button = page.locator('#floatingControls [data-input-action="composer"]');
  await button.hover();
  const box = (await button.boundingBox())!;
  const start = { x: box.x + 32, y: box.y + 32 };
  const initial = await stored(page);
  await page.touchscreen.tap(start.x, start.y);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("laymux.remote.inputMode")))
    .not.toBeNull();
  const mode = await page.evaluate(() => localStorage.getItem("laymux.remote.inputMode"));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: 140, y: 250 }],
  });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  expect(await stored(page)).toEqual(initial);
  expect((await button.boundingBox())!.y).toBeCloseTo(box.y, 0);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: 140, y: 250 }],
  });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  expect((await stored(page)).buttons[0].y).toBeLessThan(0.5);
  expect(await page.evaluate(() => localStorage.getItem("laymux.remote.inputMode"))).toBe(mode);
  const moved = (await button.boundingBox())!;
  await cdp.detach();
  await page.touchscreen.tap(moved.x + 32, moved.y + 32);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("laymux.remote.inputMode")))
    .not.toBe(mode);
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => localStorage.getItem("laymux.remote.inputMode"))).not.toBe(mode);
});

test("dragging a tap button never activates it, tap activates once, and resize keeps it reachable", async ({
  page,
}) => {
  await open(page);
  await page.getByLabel("Floating button action").selectOption("composer");
  await page.getByRole("button", { name: "Add floating button", exact: true }).click();
  await page.locator("#navToggle").click();
  const button = page.locator('#floatingControls [data-input-action="composer"]');
  const mode = () => page.evaluate(() => localStorage.getItem("laymux.remote.inputMode"));
  const before = await mode();
  await button.hover();
  const box = (await button.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(170, 300, { steps: 10 });
  await page.mouse.up();
  expect(await mode()).toBe(before);
  expect((await stored(page)).buttons[0].y).toBeLessThan(0.5);
  await button.click();
  expect(await mode()).not.toBe(before);
  await page.setViewportSize({ width: 240, height: 260 });
  await expect
    .poll(async () => {
      const rect = (await button.boundingBox())!;
      return rect.y + rect.height;
    })
    .toBeLessThanOrEqual(260);
  const resized = (await button.boundingBox())!;
  expect(resized.x).toBeGreaterThanOrEqual(0);
  expect(resized.y).toBeGreaterThanOrEqual(0);
  expect(resized.x + resized.width).toBeLessThanOrEqual(240);
  expect(resized.y + resized.height).toBeLessThanOrEqual(260);
});

test("header actions start Hidden, can be placed on a row, and remain in the header", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("tab", { name: "Input bar", exact: true }).click();
  for (const action of ["menu", "copyPane", "viewer", "skip", "desktop"]) {
    await expect(page.locator(`.layout-hidden [data-layout-action="${action}"]`)).toHaveCount(1);
  }
  await page.locator('.layout-hidden [data-layout-action="menu"]').click();
  await expect(page.locator('#keyRow [data-action-proxy="menu"]')).toHaveCount(1);
  await expect(page.locator("header #navToggle")).toHaveCount(1);
  await page.locator("#navToggle").click();
  await page.locator("#keyBarToggle").click();
  await page.locator('#keyRow [data-action-proxy="menu"]').click();
  await expect(page.locator("#navToggle")).toHaveAttribute("aria-expanded", "true");
});

test("a floating Keys toggle can own the expanded row while the row toggle is Hidden", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "laymux.remote.keybar",
      JSON.stringify({
        expanded: true,
        zones: {
          main: { left: [], center: [], right: [] },
          expanded: { left: ["soft:esc"], center: [], right: [] },
        },
        floating: { buttons: [{ id: "f-keys", actionId: "keys" }] },
      }),
    ),
  );
  await open(page);
  await expect(page.locator("#keyBar")).toBeVisible();
  await expect(page.locator("#keyBarToggle")).toBeHidden();
  await page.locator("#navToggle").click();
  const keys = page.locator('#floatingControls [data-action-proxy="keys"]');
  await keys.click();
  await expect(page.locator("#keyBar")).toBeHidden();
  await keys.click();
  await expect(page.locator("#keyBar")).toBeVisible();
  await page.locator("#navToggle").click();
  await page.locator("#drawerSettingsButton").click();
  await page.getByLabel("Keys enabled").uncheck();
  await expect(page.locator("#keyBar")).toBeHidden();
});

test("rejects unknown actions and malformed geometry without losing valid controls", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "laymux.remote.keybar",
      JSON.stringify({
        floating: {
          pads: { dpad: { enabled: true, size: 999, x: -1, y: 2 } },
          buttons: [
            { id: "f-good", actionId: "soft:esc", enabled: true, size: 60, x: 0.5, y: 0.5 },
            { id: "f-pad", actionId: "soft:dpad" },
            { id: "f-unknown", actionId: "__proto__" },
            { id: "f-good", actionId: "soft:tab" },
          ],
        },
      }),
    ),
  );
  await open(page);
  await expect(page.locator("#floatingControls > *")).toHaveCount(2);
  await expect(page.getByLabel("Arrow pad size")).toHaveValue("128");
  await expect(page.getByLabel("Arrow pad X")).toHaveValue("0");
  await expect(page.getByLabel("Arrow pad Y")).toHaveValue("100");
  await expect(
    page.getByLabel("Floating button action").locator('option[value="soft:dpad"]'),
  ).toHaveCount(0);
});
