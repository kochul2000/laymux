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
  await expect(page.locator("#remoteMainButtonScale")).toHaveText("110%");
  await expect(page.locator("#remoteKeysButtonScale")).toHaveText("110%");
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
  await expect(page.locator("#remoteMainButtonScale")).toHaveText("110%");
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
