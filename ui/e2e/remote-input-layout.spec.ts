import { expect, test } from "@playwright/test";

import { remoteClientMarkupWithoutXterm } from "./remote-client-assets";

const STORAGE_KEY = "laymux.remote.keybar";

async function openMarkup(page: import("@playwright/test").Page) {
  await page.route("http://remote.test/", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>remote test</title>" }),
  );
  await page.goto("http://remote.test/");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(remoteClientMarkupWithoutXterm());
}

test.describe("Remote input action layout", () => {
  test("uses the agreed legacy-style default and keeps 390px chrome on one row", async ({
    page,
  }) => {
    await page.addInitScript(() => localStorage.setItem("laymux.remote.inputMode", "composer"));
    await openMarkup(page);

    await expect(page.locator("#mainActionRow > button:not([hidden])")).toHaveCount(4);
    await expect
      .poll(() =>
        page
          .locator("#mainActionRow > button:not([hidden])")
          .evaluateAll((buttons) => buttons.map((button) => button.id)),
      )
      .toEqual(["ctrlC", "focusTerminal", "keyBarToggle", "composerSend"]);
    await expect(page.locator("#attachFile")).toBeHidden();

    await page.locator("#keyBarToggle").click();
    await expect(page.locator("#keyBar")).toBeVisible();
    await expect(page.locator("#keyRow").first()).toContainText("P↕N↔");
    await expect(page.locator("#keyRow > #inputModeToggle")).toHaveCount(1);
    await expect(page.locator("#keyBarSettings")).toHaveCount(0);
    await expect(page.locator("#keyPopover")).toHaveCount(0);

    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    const visibleButtonTops = await page
      .locator("#mainActionRow > button:not([hidden])")
      .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().top));
    expect(Math.max(...visibleButtonTops) - Math.min(...visibleButtonTops)).toBeLessThanOrEqual(1);
  });

  test("moves every action between main, Keys, and hidden from drawer Settings", async ({
    page,
  }) => {
    await openMarkup(page);

    await page.locator("#drawerSettingsButton").click();
    await expect(page.locator("#inputLayoutEditor")).toBeVisible();
    await page.getByLabel("Place Attach file").selectOption("main");
    await page.getByLabel("Place Keyboard").selectOption("expanded");
    await page.getByLabel("Place Esc").selectOption("main");
    await page.getByLabel("Place Send").selectOption("expanded");
    await page.getByLabel("Place Composer").selectOption("main");
    await page.getByLabel("Place Ctrl+C").selectOption("hidden");
    await page.getByLabel("Place Keys").selectOption("hidden");
    await page.getByLabel("Move Composer earlier").click();

    await expect(page.locator("#attachFile")).toBeVisible();
    await expect(page.locator("#ctrlC")).toBeHidden();
    await expect(page.locator("#inputModeToggle")).toBeVisible();
    await expect(page.locator("#focusTerminal")).toBeHidden();
    await expect(page.locator("#keyBarToggle")).toBeHidden();
    await expect(page.locator("#keyBar")).toBeHidden();
    await expect
      .poll(() =>
        page
          .locator("#mainActionRow > [data-input-action]:not([hidden])")
          .evaluateAll((actions) =>
            actions.map((action) => action.getAttribute("data-input-action")),
          ),
      )
      .toEqual(["attachment", "composer", "soft:esc"]);

    await page.getByLabel("Place Keys").selectOption("main");
    await page.locator("#keyBarToggle").click();
    await expect(page.locator("#keyRow > #focusTerminal")).toHaveCount(1);
    await expect(page.locator("#keyRow > #composerSend")).toBeHidden();
    await page.locator("#inputModeToggle").click();
    await expect(page.locator("#keyRow > #composerSend")).toBeVisible();

    await page.getByLabel("Place Esc").selectOption("hidden");
    await expect(page.locator('[data-input-action="soft:esc"]')).toHaveCount(0);

    await expect
      .poll(() =>
        page.evaluate((key) => {
          const stored = JSON.parse(localStorage.getItem(key) || "{}");
          return stored.zones;
        }, STORAGE_KEY),
      )
      .toMatchObject({
        main: expect.arrayContaining(["attachment", "composer", "keys"]),
        expanded: expect.arrayContaining(["keyboard", "send"]),
        hidden: expect.arrayContaining(["ctrl-c", "soft:esc"]),
      });

    await page.reload();
    await page.setContent(remoteClientMarkupWithoutXterm());
    await expect(page.locator("#attachFile")).toBeVisible();
    await expect(page.locator("#ctrlC")).toBeHidden();
    await expect(page.locator("#mainActionRow > #inputModeToggle")).toBeVisible();
    await expect(page.locator("#keyRow > #focusTerminal")).toHaveCount(1);
    await expect(page.locator("#keyRow > #composerSend")).toBeVisible();
  });

  test("falls back safely from malformed storage and only shows Send in Composer", async ({
    page,
  }) => {
    await page.addInitScript((key) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          expanded: "yes",
          sets: ["bad"],
          custom: ["unknown"],
          zones: { main: ["keys", "keys", 17], expanded: "bad", hidden: null },
        }),
      );
    }, STORAGE_KEY);
    await openMarkup(page);

    await expect
      .poll(() =>
        page
          .locator("#mainActionRow > button:not([hidden])")
          .evaluateAll((buttons) => buttons.map((button) => button.id)),
      )
      .toEqual(["ctrlC", "focusTerminal", "keyBarToggle"]);
    await expect(page.locator("#composerSend")).toBeHidden();

    await page.locator("#keyBarToggle").click();
    await expect(page.locator('#keyRow > [data-input-action="soft:esc"]')).toHaveCount(1);
    await page.locator("#inputModeToggle").click();
    await expect(page.locator("#composerSend")).toBeVisible();
    await page.locator("#inputModeToggle").click();
    await expect(page.locator("#composerSend")).toBeHidden();
  });

  test("keeps zone ownership while sets and custom keys only control activation", async ({
    page,
  }) => {
    await openMarkup(page);
    await page.locator("#drawerSettingsButton").click();

    await page.getByLabel("Place Esc").selectOption("main");
    const navigationSet = page
      .locator(".key-set-row")
      .filter({ hasText: "Navigation" })
      .locator('input[type="checkbox"]');
    await navigationSet.uncheck();
    await expect(page.locator('[data-input-action="soft:esc"]')).toHaveCount(0);
    await page
      .locator(".key-set-row")
      .filter({ hasText: "Navigation" })
      .locator('input[type="checkbox"]')
      .check();
    await expect(page.locator('#mainActionRow > [data-input-action="soft:esc"]')).toHaveCount(1);

    const customEnter = () =>
      page.locator(".key-chip-grid").getByRole("button", { name: "⏎", exact: true });
    await customEnter().click();
    await page.getByLabel("Place ⏎").selectOption("main");
    await customEnter().click();
    await expect(page.locator('[data-input-action="soft:enter"]')).toHaveCount(0);
    await customEnter().click();
    await expect(page.locator('#mainActionRow > [data-input-action="soft:enter"]')).toHaveCount(1);
  });
});
