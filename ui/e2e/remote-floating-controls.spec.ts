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

test("floating controls stay above the composer and below menus, viewer, and feedback", async ({
  page,
}) => {
  await open(page);
  const z = await page.evaluate(() => {
    const terminal = document.getElementById("terminal")!;
    for (const className of [
      "touch-selection-handle",
      "remote-link-chip",
      "touch-selection-magnifier",
    ]) {
      const element = document.createElement("div");
      element.className = className;
      terminal.append(element);
    }
    return [
      "#scrollToBottom",
      "#terminalComposer",
      "#floatingControls",
      "#navScrim",
      ".touch-selection-handle",
      ".remote-link-chip",
      "#navigationPanel",
      "#composerStarEditorScrim",
      "#keyFlickHint",
      "#fileViewerOverlay",
      "#oauthRelayScrim",
      ".touch-selection-magnifier",
    ].map((selector) => Number(getComputedStyle(document.querySelector(selector)!).zIndex));
  });
  expect(z).toEqual([5, 7, 8, 10, 12, 13, 20, 55, 60, 60, 60, 1000]);
});

test("round pads move only after a central hold and keyboard uses an icon", async ({ page }) => {
  await open(page);
  await expect(page.getByLabel("Arrow pad opacity")).toHaveValue("50");
  await expect(page.getByLabel("Pane / alert pad opacity")).toHaveValue("50");
  await page.getByLabel("Arrow pad enabled").check();
  await page.getByLabel("Floating button action").selectOption("keyboard");
  await page.getByRole("button", { name: "Add floating button", exact: true }).click();
  await expect(page.getByLabel("Keyboard opacity")).toHaveValue("50");
  await page.locator("#navToggle").click();
  const pad = page.locator('#floatingControls [data-key="dpad"]');
  await expect(pad.locator('[data-remote-icon-name="Move"]')).toHaveCount(1);
  await expect(
    page.locator('#keyRow [data-key="navPad"] [data-remote-icon-name="GamepadDirectional"]'),
  ).toHaveCount(1);
  await expect(
    page.locator('#keyRow [data-key="navPad"] [data-remote-icon-name="GamepadDirectional"]'),
  ).toHaveAttribute("fill", "currentColor");
  await expect(page.locator(".floating-handle")).toHaveCount(0);
  await expect(page.locator('#floatingControls [data-remote-icon-name="Keyboard"]')).toHaveCount(1);
  await expect(pad).toHaveCSS("border-radius", "50%");
  await page.locator("#keyBarToggle").click();
  for (const selector of ['#keyRow [data-key="navPad"]', '#floatingControls [data-key="dpad"]']) {
    const offset = await page.locator(selector).evaluate((button) => {
      const b = button.getBoundingClientRect();
      const i = button.querySelector("svg")!.getBoundingClientRect();
      return {
        x: i.x + i.width / 2 - b.x - b.width / 2,
        y: i.y + i.height / 2 - b.y - b.height / 2,
      };
    });
    expect(Math.abs(offset.x)).toBeLessThan(1);
    expect(Math.abs(offset.y)).toBeLessThan(1);
  }
  // No lease in this DOM fixture; enable only the gesture target.
  await pad.evaluate((button: HTMLButtonElement) => {
    button.disabled = false;
  });
  await pad.hover();
  const box = (await pad.boundingBox())!;
  const initial = await stored(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 40, box.y + 32);
  await page.mouse.up();
  expect(await stored(page)).toEqual(initial);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(page.locator(".floating-control.dragging")).toHaveCount(1);
  await page.mouse.move(150, 240);
  await page.mouse.up();
  expect((await stored(page)).pads.dpad.y).toBeLessThan(initial.pads.dpad.y);
});

test("pad hints switch between square chevrons and arrows only during use", async ({
  page,
}, testInfo) => {
  await open(page);
  await page.getByLabel("Arrow pad enabled").check();
  await page.getByLabel("Pane / alert pad enabled").check();
  await page.locator("#navToggle").click();
  await expect
    .poll(async () => {
      const box = (await page.locator("#navigationPanel").boundingBox())!;
      return box.x + box.width;
    })
    .toBeLessThanOrEqual(0);
  for (const [id, idle, active] of [
    ["navPad", "GamepadDirectional", "SquareChevron"],
    ["dpad", "Move", "Arrow"],
  ]) {
    const pad = page.locator(`#floatingControls [data-key="${id}"]`);
    await expect(pad.locator(`[data-remote-icon-name="${idle}"]`)).toHaveCount(1);
    await expect(pad.locator(`[data-remote-icon-name="${idle}"]`)).toHaveAttribute(
      "fill",
      id === "navPad" ? "currentColor" : "none",
    );
    await page.screenshot({ path: testInfo.outputPath(`${id}-idle.png`) });
    await pad.evaluate((button: HTMLButtonElement) => {
      button.disabled = false;
    });
    await pad.hover();
    const box = (await pad.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.85, box.y + box.height / 2);
    await page.mouse.down();
    await expect(page.locator("#keyFlickHint")).toBeVisible();
    for (const direction of ["Up", "Down", "Left", "Right"]) {
      await expect(
        page.locator(
          `#keyFlickHint [data-flick-direction="${direction.toLowerCase()}"] [data-remote-icon-name="${active}${direction}"]`,
        ),
      ).toHaveCount(1);
    }
    await page.screenshot({ path: testInfo.outputPath(`${id}-active.png`) });
    await page.mouse.up();
    await expect(page.locator("#keyFlickHint")).toBeHidden();
  }
});

test("floating pads and repeated tap buttons persist with independent size and position", async ({
  page,
}, testInfo) => {
  await open(page);
  await expect(page.locator("#floatingControls > *")).toHaveCount(0);
  await page.getByLabel("Arrow pad enabled").check();
  await page.getByLabel("Pane / alert pad enabled").check();
  await expect(page.getByLabel("Pane / alert pad Y", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("Hold the center of a pad, then drag to move.", { exact: false }),
  ).toBeVisible();
  await page.getByLabel("Arrow pad size").fill("88");
  await page.getByLabel("Arrow pad size").dispatchEvent("change");
  await expect(page.getByLabel("Arrow pad X", { exact: true })).toHaveCount(0);
  await page.getByLabel("Arrow pad opacity").fill("40");
  await page.getByLabel("Arrow pad opacity").dispatchEvent("change");
  await expect(page.locator('[data-floating-id="dpad"]')).toHaveCSS("opacity", "0.4");
  await expect(page.locator('[data-floating-id="dpad"] button')).toHaveCSS(
    "-webkit-tap-highlight-color",
    "rgba(0, 0, 0, 0)",
  );
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
  expect(await stored(page)).toMatchObject({ pads: { dpad: { size: 88, opacity: 0.4 } } });
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
  await expect(page.getByLabel("Arrow pad opacity")).toHaveValue("50");
  await expect(
    page.getByLabel("Floating button action").locator('option[value="soft:dpad"]'),
  ).toHaveCount(0);
});
