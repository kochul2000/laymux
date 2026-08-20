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

  test("rejects prototype names from legacy soft-key storage", async ({ page }) => {
    await page.addInitScript((key) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          expanded: true,
          sets: [],
          custom: ["constructor", "__proto__"],
          usedCustom: ["constructor", "__proto__"],
          order: ["constructor", "__proto__"],
        }),
      );
    }, STORAGE_KEY);
    await openMarkup(page);

    await expect(
      page.locator('[data-input-action="soft:constructor"], [data-input-action="soft:__proto__"]'),
    ).toHaveCount(0);
    await expect(page.locator("#keyRow > .key-btn")).toHaveCount(0);

    await page.locator("#keyBarToggle").click();
    await expect
      .poll(() =>
        page.evaluate((key) => {
          const stored = JSON.parse(localStorage.getItem(key) || "{}");
          return {
            custom: stored.custom,
            usedCustom: stored.usedCustom,
            invalidOrder: stored.order?.filter((id: string) =>
              ["constructor", "__proto__"].includes(id),
            ),
            invalidZones: Object.values(stored.zones || {})
              .flat()
              .filter((id) => ["soft:constructor", "soft:__proto__"].includes(String(id))),
          };
        }, STORAGE_KEY),
      )
      .toEqual({ custom: [], usedCustom: [], invalidOrder: [], invalidZones: [] });
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

  test("updates the Keys-row empty state when Send becomes visible in Composer", async ({
    page,
  }) => {
    await page.addInitScript((key) => {
      localStorage.setItem("laymux.remote.inputMode", "direct");
      localStorage.setItem(
        key,
        JSON.stringify({
          expanded: true,
          sets: [],
          custom: [],
          zones: {
            main: ["keys", "composer"],
            expanded: ["send"],
            hidden: ["ctrl-c", "keyboard", "attachment"],
          },
        }),
      );
    }, STORAGE_KEY);
    await openMarkup(page);

    const emptyState = page.locator("#keyRow > .key-row-empty");
    await expect(page.locator("#keyBar")).toBeVisible();
    await expect(page.locator("#keyRow > #composerSend")).toBeHidden();
    await expect(emptyState).toBeVisible();

    await page.locator("#mainActionRow > #inputModeToggle").click();
    await expect(page.locator("#keyRow > #composerSend")).toBeVisible();
    await expect(emptyState).toHaveCount(0);

    await page.locator("#mainActionRow > #inputModeToggle").click();
    await expect(page.locator("#keyRow > #composerSend")).toBeHidden();
    await expect(emptyState).toBeVisible();
  });

  test("projects Action placement soft-key order into Key order and reload", async ({ page }) => {
    const renderedSoftKeys = () =>
      page.evaluate(() =>
        ["mainActionRow", "keyRow"].flatMap((rowId) =>
          [...document.querySelectorAll(`#${rowId} > .key-btn`)].map(
            (button) => (button as HTMLElement).dataset.key,
          ),
        ),
      );
    const keyOrderChips = () =>
      page
        .locator("#inputLayoutEditor .key-order-chip")
        .evaluateAll((chips) => chips.map((chip) => (chip as HTMLElement).dataset.orderKey));
    const customEnter = () =>
      page.locator(".key-chip-grid").getByRole("button", { name: "⏎", exact: true });

    await openMarkup(page);
    await page.locator("#drawerSettingsButton").click();
    await page.getByLabel("Move Tab earlier").click();
    await expect.poll(renderedSoftKeys).toEqual(await keyOrderChips());
    expect((await renderedSoftKeys()).indexOf("tab")).toBeLessThan(
      (await renderedSoftKeys()).indexOf("esc"),
    );
    await page.getByLabel("Place Tab").selectOption("main");
    await expect.poll(renderedSoftKeys).toEqual(await keyOrderChips());
    await expect(page.locator('#mainActionRow > [data-input-action="soft:tab"]')).toHaveCount(1);

    await page.reload();
    await page.setContent(remoteClientMarkupWithoutXterm());
    await page.locator("#drawerSettingsButton").click();
    await expect.poll(renderedSoftKeys).toEqual(await keyOrderChips());

    await customEnter().click();
    await page.getByLabel("Move ⏎ earlier").click();
    const configuredOrder = await renderedSoftKeys();
    await customEnter().click();
    await expect(page.locator('[data-input-action="soft:enter"]')).toHaveCount(0);
    await customEnter().click();
    await expect.poll(renderedSoftKeys).toEqual(configuredOrder);
    await expect.poll(keyOrderChips).toEqual(configuredOrder);

    await page.reload();
    await page.setContent(remoteClientMarkupWithoutXterm());
    await page.locator("#drawerSettingsButton").click();
    await expect.poll(renderedSoftKeys).toEqual(configuredOrder);
    await expect.poll(keyOrderChips).toEqual(configuredOrder);
  });

  test("limits legacy Key order controls to the selected action row", async ({ page }) => {
    await page.addInitScript((key) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          expanded: true,
          sets: [],
          custom: ["tab", "enter", "esc", "stab"],
          usedCustom: ["tab", "enter", "esc", "stab"],
          zones: {
            main: ["ctrl-c", "keyboard", "keys", "send", "soft:tab", "soft:enter"],
            expanded: ["composer", "soft:esc", "soft:stab"],
            hidden: ["attachment"],
          },
        }),
      );
    }, STORAGE_KEY);
    await openMarkup(page);
    await page.locator("#drawerSettingsButton").click();

    const tab = page.locator('.key-order-chip[data-order-key="tab"]');
    const enter = page.locator('.key-order-chip[data-order-key="enter"]');
    const esc = page.locator('.key-order-chip[data-order-key="esc"]');
    await expect(tab).toHaveAttribute("data-order-zone", "main");
    await expect(tab).toHaveAttribute("aria-describedby", "keyOrderZoneMain");
    await expect(esc).toHaveAttribute("data-order-zone", "expanded");
    await expect(esc).toHaveAttribute("aria-describedby", "keyOrderZoneExpanded");

    await enter.click();
    await expect(page.getByRole("button", { name: "Move Enter left" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Move Enter right" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Move Enter to end" })).toBeDisabled();

    await esc.click();
    await expect(page.getByRole("button", { name: "Move Esc to start" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Move Esc left" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Move Esc right" })).toBeEnabled();

    await enter.scrollIntoViewIfNeeded();
    await esc.scrollIntoViewIfNeeded();
    const enterBox = await enter.boundingBox();
    const escBox = await esc.boundingBox();
    expect(enterBox).not.toBeNull();
    expect(escBox).not.toBeNull();
    await page.mouse.move(enterBox!.x + enterBox!.width / 2, enterBox!.y + enterBox!.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(250);
    await page.mouse.move(escBox!.x + 2, escBox!.y + escBox!.height / 2, { steps: 4 });
    await expect(esc).not.toHaveClass(/drop-before|drop-after/);
    await page.mouse.up();

    await expect
      .poll(() =>
        page
          .locator("#mainActionRow > .key-btn")
          .evaluateAll((buttons) => buttons.map((button) => (button as HTMLElement).dataset.key)),
      )
      .toEqual(["tab", "enter"]);
    await expect
      .poll(() =>
        page
          .locator("#keyRow > .key-btn")
          .evaluateAll((buttons) => buttons.map((button) => (button as HTMLElement).dataset.key)),
      )
      .toEqual(["esc", "stab"]);
    await expect
      .poll(() =>
        page
          .locator(".key-order-chip")
          .evaluateAll((chips) => chips.map((chip) => (chip as HTMLElement).dataset.orderKey)),
      )
      .toEqual(["tab", "enter", "esc", "stab"]);
  });

  test("preserves the Settings scroll position while placement changes rerender", async ({
    page,
  }) => {
    await openMarkup(page);
    await page.locator("#drawerSettingsButton").click();

    const settingsView = page.locator("#drawerSettingsView");
    await page.getByLabel("Place Attach file").scrollIntoViewIfNeeded();
    expect(await settingsView.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await page.getByLabel("Place Attach file").selectOption("expanded");
    await expect
      .poll(() => settingsView.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);

    await page.getByLabel("Move Attach file earlier").scrollIntoViewIfNeeded();
    expect(await settingsView.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await page.getByLabel("Move Attach file earlier").click();
    await expect
      .poll(() => settingsView.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
  });
});
