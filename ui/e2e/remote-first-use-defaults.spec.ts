import { expect, test, type Page } from "@playwright/test";

import { remoteClientMarkupWithoutXterm } from "./remote-client-assets";

const displayKey = "laymux.remote.displaySettings";
const keybarKey = "laymux.remote.keybar";

async function open(page: Page) {
  await page.route("http://remote.test/", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>remote test</title>" }),
  );
  await page.goto("http://remote.test/");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(remoteClientMarkupWithoutXterm());
}

test("fresh Remote device starts in composer with the requested controls", async ({ page }) => {
  await open(page);

  await expect(page.locator("#inputModeToggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#mainActionRow [data-input-action]")).toHaveCount(7);
  expect(
    await page
      .locator("#mainActionRow [data-input-action]")
      .evaluateAll((elements) =>
        elements.map((element) => (element as HTMLElement).dataset.inputAction),
      ),
  ).toEqual(["soft:c-c", "soft:q", "soft:esc", "soft:u-defaultclear", "keyboard", "keys", "send"]);
  await expect(page.locator('#mainActionRow [data-key="u-defaultclear"]')).toHaveText("/clr");
  await expect(page.locator('#mainActionRow [data-input-action="soft:u-p1-mg"]')).toHaveCount(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), displayKey)).toBeNull();
  expect(await page.evaluate((key) => localStorage.getItem(key), keybarKey)).toBeNull();

  await page.locator("#keyBarToggle").click();
  expect(
    await page
      .locator("#keyRow [data-input-action]")
      .evaluateAll((elements) =>
        elements.map((element) => (element as HTMLElement).dataset.inputAction),
      ),
  ).toEqual([
    "composer",
    "soft:navPad",
    "soft:notifOldest",
    "soft:tab",
    "soft:c-u",
    "soft:c-l",
    "soft:c-t",
    "soft:dpad",
    "soft:pgup",
    "soft:pgdn",
    "attachment",
  ]);

  const pads = page.locator("#floatingControls .floating-control");
  await expect(pads).toHaveCount(2);
  const geometry = await page.evaluate(() =>
    ["navPad", "dpad"].map((id) => {
      const layer = document.querySelector<HTMLElement>("#floatingControls")!;
      const item = document.querySelector(`#floatingControls [data-floating-id="${id}"]`)!;
      const bounds = item.getBoundingClientRect();
      return {
        id,
        x: bounds.x + bounds.width / 2,
        y: bounds.y + bounds.height / 2,
        normalizedX: parseFloat((item as HTMLElement).style.left) / (layer.clientWidth - 64),
        normalizedY: parseFloat((item as HTMLElement).style.top) / (layer.clientHeight - 64),
      };
    }),
  );
  expect(geometry[0].normalizedX).toBeCloseTo(0.10478285610595374, 5);
  expect(geometry[0].normalizedY).toBeCloseTo(0.5206913907023182, 5);
  expect(geometry[1].normalizedX).toBeCloseTo(0.9108609136460442, 5);
  expect(geometry[1].normalizedY).toBeCloseTo(0.5274580464716007, 5);
  expect(geometry[0].x).toBeLessThan(geometry[1].x);
  expect(geometry[0].y).toBeGreaterThan(300);
  expect(geometry[1].y).toBeGreaterThan(300);

  await page.locator("#drawerSettingsButton").click();
  await expect(page.locator("#remoteMainButtonScale")).toHaveText("100%");
  await expect(page.locator("#remoteKeysButtonScale")).toHaveText("100%");
});

test("saved direct mode, disabled pads, and custom key layout survive a reload", async ({
  page,
}) => {
  await page.addInitScript(
    ({ displayKey, keybarKey }) => {
      localStorage.setItem("laymux.remote.inputMode", "direct");
      localStorage.setItem(
        displayKey,
        JSON.stringify({ mainButtonScale: 130, navigationWidth: 420 }),
      );
      localStorage.setItem(
        keybarKey,
        JSON.stringify({
          expanded: false,
          userKeys: [],
          zones: {
            main: { left: ["soft:esc"], center: [], right: ["keyboard", "keys", "send"] },
            expanded: { left: [], center: [], right: [] },
          },
          floating: {
            enabled: true,
            pads: {
              navPad: { enabled: false, x: 0.21, y: 0.31 },
              dpad: { enabled: false, x: 0.72, y: 0.81 },
            },
            buttons: [],
          },
        }),
      );
    },
    { displayKey, keybarKey },
  );
  await open(page);
  await expect(page.locator("#inputModeToggle")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#floatingControls > *")).toHaveCount(0);
  expect(
    await page
      .locator("#mainActionRow [data-input-action]")
      .evaluateAll((elements) =>
        elements.map((element) => (element as HTMLElement).dataset.inputAction),
      ),
  ).toEqual(["soft:esc", "keyboard", "keys", "send"]);
  await page.locator("#drawerSettingsButton").click();
  await expect(page.locator("#remoteMainButtonScale")).toHaveText("130%");
  await expect(page.locator("#remoteNavigationWidth")).toHaveValue("420");
  await page.getByRole("tab", { name: "Floating", exact: true }).click();
  await expect(page.getByLabel("Arrow pad enabled")).not.toBeChecked();
  await expect(page.getByLabel("Pane / alert pad enabled")).not.toBeChecked();
  expect(
    await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).floating.pads, keybarKey),
  ).toMatchObject({ navPad: { x: 0.21, y: 0.31 }, dpad: { x: 0.72, y: 0.81 } });
});

test("missing and malformed preference data fall back to fresh-device defaults", async ({
  page,
}) => {
  await page.addInitScript(
    ({ displayKey, keybarKey }) => {
      localStorage.setItem("laymux.remote.inputMode", "unexpected");
      localStorage.setItem(displayKey, "not-json");
      localStorage.setItem(keybarKey, "not-json");
    },
    { displayKey, keybarKey },
  );
  await open(page);
  await expect(page.locator("#inputModeToggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('#mainActionRow [data-key="u-defaultclear"]')).toHaveText("/clr");
  await expect(page.locator("#floatingControls .floating-control")).toHaveCount(2);
  await page.locator("#drawerSettingsButton").click();
  await expect(page.locator("#remoteMainButtonScale")).toHaveText("100%");
});

test("a saved empty custom-key list cannot leave a dangling default action", async ({ page }) => {
  await page.addInitScript((key) => {
    localStorage.setItem(key, JSON.stringify({ userKeys: [], zones: {} }));
  }, keybarKey);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page);
  await expect(
    page.locator('#mainActionRow [data-input-action="soft:u-defaultclear"]'),
  ).toHaveCount(0);
  await expect(page.locator('#mainActionRow [data-input-action="soft:q"]')).toHaveCount(1);
  expect(errors.filter((message) => /reading 'label'|reading "label"/.test(message))).toEqual([]);
  expect(
    await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).userKeys, keybarKey),
  ).toEqual([]);
});

test("a complete saved empty layout remains empty", async ({ page }) => {
  await page.addInitScript((key) => {
    localStorage.setItem(
      key,
      JSON.stringify({
        userKeys: [],
        zones: {
          main: { left: [], center: [], right: [] },
          expanded: { left: [], center: [], right: [] },
        },
      }),
    );
  }, keybarKey);
  await open(page);
  await expect(page.locator("#mainActionRow [data-input-action]:visible")).toHaveCount(0);
  await expect(page.locator("#keyRow [data-input-action]:visible")).toHaveCount(0);
  expect(
    await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).userKeys, keybarKey),
  ).toEqual([]);
});

test("100% preserves the former 110% pixels and size controls scale from that baseline", async ({
  page,
}) => {
  await open(page);
  await page.locator("#keyBarToggle").click();
  const sizes = () =>
    page.evaluate(() => {
      const read = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector)!;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          height: rect.height,
          width: rect.width,
          font: parseFloat(style.fontSize),
          paddingTop: parseFloat(style.paddingTop),
          paddingRight: parseFloat(style.paddingRight),
        };
      };
      return {
        main: read('#mainActionRow [data-key="c-c"]'),
        keys: read('#keyRow [data-key="tab"]'),
        icon: read("#composerSend svg"),
      };
    });
  const initial = await sizes();
  expect(initial.main.height).toBeCloseTo(30.53125, 1);
  expect(initial.main.width).toBeCloseTo(59.390625, 1);
  expect(initial.main.font).toBeCloseTo(12.1, 2);
  expect(initial.main.paddingTop).toBeCloseTo(5.5, 2);
  expect(initial.main.paddingRight).toBeCloseTo(9.9, 2);
  expect(initial.keys.height).toBeCloseTo(28.59375, 1);
  expect(initial.keys.width).toBeCloseTo(41.75, 1);
  expect(initial.keys.font).toBeCloseTo(12.1, 2);
  expect(initial.keys.paddingTop).toBeCloseTo(4.4, 2);
  expect(initial.keys.paddingRight).toBeCloseTo(9.9, 2);
  expect(initial.icon.width).toBeCloseTo(22, 1);
  expect(initial.icon.height).toBeCloseTo(22, 1);

  await page.locator("#drawerSettingsButton").click();
  await page.locator("#inputButtonSizes > summary").click();
  await expect(page.locator("#remoteMainButtonScale")).toHaveText("100%");
  await expect(page.locator("#remoteKeysButtonScale")).toHaveText("100%");
  await page.getByRole("button", { name: "Increase Main button size" }).click();
  await page.getByRole("button", { name: "Decrease Keys button size" }).click();
  await expect(page.locator("#remoteMainButtonScale")).toHaveText("110%");
  await expect(page.locator("#remoteKeysButtonScale")).toHaveText("90%");
  const changed = await sizes();
  expect(changed.main.font).toBeCloseTo(initial.main.font * 1.1, 2);
  expect(changed.keys.font).toBeCloseTo(initial.keys.font * 0.9, 2);
  expect(changed.icon.width).toBeCloseTo(initial.icon.width * 1.1, 1);
  expect(
    await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), displayKey),
  ).toMatchObject({ mainButtonScale: 110, keysButtonScale: 90 });
  await page.getByRole("button", { name: "Reset button sizes" }).click();
  await expect(page.locator("#remoteMainButtonScale")).toHaveText("100%");
  await expect(page.locator("#remoteKeysButtonScale")).toHaveText("100%");
  expect(await sizes()).toEqual(initial);
  expect(
    await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), displayKey),
  ).toMatchObject({ mainButtonScale: 100, keysButtonScale: 100 });
});

test("a stored button percentage stays numeric and uses the new size baseline", async ({
  page,
}) => {
  await page.addInitScript((key) => {
    localStorage.setItem(key, JSON.stringify({ mainButtonScale: 110, keysButtonScale: 90 }));
  }, displayKey);
  await open(page);
  await page.locator("#keyBarToggle").click();
  await page.locator("#drawerSettingsButton").click();
  await page.locator("#inputButtonSizes > summary").click();
  await expect(page.locator("#remoteMainButtonScale")).toHaveText("110%");
  await expect(page.locator("#remoteKeysButtonScale")).toHaveText("90%");
  const fontSizes = await page.evaluate(() => ({
    main: parseFloat(
      getComputedStyle(document.querySelector('#mainActionRow [data-key="c-c"]')!).fontSize,
    ),
    keys: parseFloat(
      getComputedStyle(document.querySelector('#keyRow [data-key="tab"]')!).fontSize,
    ),
  }));
  expect(fontSizes.main).toBeCloseTo(12.1 * 1.1, 2);
  expect(fontSizes.keys).toBeCloseTo(12.1 * 0.9, 2);
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), displayKey)).toEqual({
    mainButtonScale: 110,
    keysButtonScale: 90,
  });
});

test("80% and 160% resolve to 0.88 and 1.76 physical scale", async ({ page }) => {
  await page.addInitScript((key) => {
    localStorage.setItem(key, JSON.stringify({ mainButtonScale: 80, keysButtonScale: 160 }));
  }, displayKey);
  await open(page);
  const scale = await page.evaluate(() => ({
    main: parseFloat(
      getComputedStyle(document.querySelector("#mainActionRow")!).getPropertyValue(
        "--input-button-scale",
      ),
    ),
    keys: parseFloat(
      getComputedStyle(document.querySelector("#keyRow")!).getPropertyValue("--input-button-scale"),
    ),
  }));
  expect(scale.main).toBeCloseTo(0.88, 5);
  expect(scale.keys).toBeCloseTo(1.76, 5);
  await page.locator("#drawerSettingsButton").click();
  await page.locator("#inputButtonSizes > summary").click();
  await expect(page.locator("#remoteMainButtonScale")).toHaveText("80%");
  await expect(page.locator("#remoteKeysButtonScale")).toHaveText("160%");
});
