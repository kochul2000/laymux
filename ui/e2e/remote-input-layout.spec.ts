import { expect, test } from "@playwright/test";

import { remoteClientMarkupWithoutXterm } from "./remote-client-assets";

const STORAGE_KEY = "laymux.remote.keybar";

type Page = import("@playwright/test").Page;

async function openMarkup(page: Page) {
  await page.route("http://remote.test/", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>remote test</title>" }),
  );
  await page.goto("http://remote.test/");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(remoteClientMarkupWithoutXterm());
}

function segment(page: Page, row: "mainActionRow" | "keyRow", name: "left" | "center" | "right") {
  return page.locator(`#${row} > [data-segment="${name}"]`);
}

/** Visible placed action ids of a row, in render order. */
function renderedActions(page: Page, row: "mainActionRow" | "keyRow") {
  return page.evaluate(
    (rowId) =>
      [...document.querySelectorAll(`#${rowId} [data-input-action]`)]
        .filter((element) => !(element as HTMLElement).hidden)
        .map((element) => (element as HTMLElement).dataset.inputAction),
    row,
  );
}

function storedConfig(page: Page) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "{}"), STORAGE_KEY);
}

function chip(page: Page, actionId: string) {
  return page.locator(`#inputLayoutEditor .layout-chip[data-layout-action="${actionId}"]`).first();
}

/** Selecting a chip is a toggle, so only click when it is not already selected. */
async function selectChip(page: Page, actionId: string) {
  const target = chip(page, actionId);
  if ((await target.getAttribute("aria-pressed")) !== "true") await target.click();
}

async function place(page: Page, actionId: string, hint: string, value: string) {
  await selectChip(page, actionId);
  await page.getByLabel(`Place ${hint}`).selectOption(value);
}

/** Long-press drag: the chip editor commits on pointerup, never via native DnD. */
async function dragChipOnto(page: Page, sourceId: string, targetId: string, toRightHalf = false) {
  const from = chip(page, sourceId);
  await from.scrollIntoViewIfNeeded();
  const fromBox = await from.boundingBox();
  const to = chip(page, targetId);
  await to.scrollIntoViewIfNeeded();
  const toBox = await to.boundingBox();
  expect(fromBox).not.toBeNull();
  expect(toBox).not.toBeNull();
  await page.mouse.move(fromBox!.x + fromBox!.width / 2, fromBox!.y + fromBox!.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(250);
  await page.mouse.move(
    toBox!.x + (toRightHalf ? toBox!.width - 2 : 2),
    toBox!.y + toBox!.height / 2,
    { steps: 4 },
  );
  await page.mouse.up();
}

test.describe("Remote input action layout", () => {
  test("defaults to segment-aligned rows and keeps 390px chrome on one row", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("laymux.remote.inputMode", "composer"));
    await openMarkup(page);

    await expect
      .poll(() => renderedActions(page, "mainActionRow"))
      .toEqual(["soft:c-c", "keyboard", "keys", "send"]);
    await expect(page.locator('#mainActionRow [data-key="c-c"]')).toHaveText("^C");
    await expect(page.locator("#attachFile")).toBeHidden();

    // ^C hugs the left edge and the input controls hug the right — the whole
    // point of segments once the row is wider than its contents.
    const geometry = await page.evaluate(() => {
      const row = document.querySelector("#mainActionRow")!.getBoundingClientRect();
      const first = document
        .querySelector('#mainActionRow [data-input-action="soft:c-c"]')!
        .getBoundingClientRect();
      const last = document.querySelector("#composerSend")!.getBoundingClientRect();
      return {
        leftGap: Math.round(first.left - row.left),
        rightGap: Math.round(row.right - last.right),
        spread: Math.round(last.left - first.right),
      };
    });
    expect(geometry.leftGap).toBeLessThanOrEqual(1);
    expect(geometry.rightGap).toBeLessThanOrEqual(1);
    expect(geometry.spread).toBeGreaterThan(40);

    await page.locator("#keyBarToggle").click();
    await expect(page.locator("#keyBar")).toBeVisible();
    await expect(segment(page, "keyRow", "left")).toContainText("P↕N↔");
    await expect(segment(page, "keyRow", "right")).toContainText("^L");
    await expect(page.locator("#keyBarSettings")).toHaveCount(0);
    await expect(page.locator("#keyPopover")).toHaveCount(0);

    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    // Segments are independent grid items, so "still one row" is a statement
    // about shared vertical centres, not about equal button heights.
    const buttonCentres = await page
      .locator("#mainActionRow button:not([hidden])")
      .evaluateAll((buttons) =>
        buttons.map((button) => {
          const rect = button.getBoundingClientRect();
          return rect.top + rect.height / 2;
        }),
      );
    expect(Math.max(...buttonCentres) - Math.min(...buttonCentres)).toBeLessThanOrEqual(1);
  });

  test("moves an action across rows, segments, and the hidden section from Settings", async ({
    page,
  }) => {
    await openMarkup(page);
    await page.locator("#drawerSettingsButton").click();
    await expect(page.locator("#inputLayoutEditor")).toBeVisible();

    await place(page, "keyboard", "Keyboard", "expanded:center");
    await expect(segment(page, "keyRow", "center").locator("#focusTerminal")).toHaveCount(1);

    await place(page, "soft:c-c", "Ctrl+C (interrupt)", "main:right");
    await expect.poll(() => renderedActions(page, "mainActionRow")).toEqual(["keys", "soft:c-c"]);

    // Hidden round trip: unplacing hides the button, replacing restores it.
    await place(page, "soft:c-c", "Ctrl+C (interrupt)", "hidden");
    await expect(page.locator('#mainActionRow [data-input-action="soft:c-c"]')).toHaveCount(0);
    await place(page, "soft:c-c", "Ctrl+C (interrupt)", "main:left");
    await expect(segment(page, "mainActionRow", "left")).toContainText("^C");

    const zones = (await storedConfig(page)).zones;
    expect(zones.main.left).toEqual(["soft:c-c"]);
    expect(zones.main.right).toEqual(["keys", "send"]);
    expect(zones.expanded.center).toEqual(["keyboard"]);

    await page.reload();
    await page.setContent(remoteClientMarkupWithoutXterm());
    await expect(segment(page, "mainActionRow", "left")).toContainText("^C");
    await expect(segment(page, "keyRow", "center").locator("#focusTerminal")).toHaveCount(1);
  });

  test("reorders inside a segment and drags across segment and row boundaries", async ({
    page,
  }) => {
    await openMarkup(page);
    await page.locator("#drawerSettingsButton").click();

    await selectChip(page, "soft:tab");
    await page.getByRole("button", { name: "Move Tab to start" }).click();
    await expect
      .poll(async () => (await storedConfig(page)).zones.expanded.left[0])
      .toBe("soft:tab");
    await expect(page.getByRole("button", { name: "Move Tab left" })).toBeDisabled();

    // Segment and row boundaries are no longer walls: one drag crosses both.
    await dragChipOnto(page, "soft:tab", "soft:c-l", true);
    await expect
      .poll(async () => (await storedConfig(page)).zones.expanded.right)
      .toContain("soft:tab");

    await dragChipOnto(page, "soft:tab", "soft:c-c", true);
    await expect
      .poll(() => renderedActions(page, "mainActionRow"))
      .toEqual(["soft:c-c", "soft:tab", "keyboard", "keys"]);
  });

  test("keeps Keys out of the row it opens and closes the bar when it is unplaced", async ({
    page,
  }) => {
    await openMarkup(page);
    await page.locator("#keyBarToggle").click();
    await expect(page.locator("#keyBar")).toBeVisible();
    await page.locator("#drawerSettingsButton").click();

    await selectChip(page, "keys");
    await expect
      .poll(() =>
        page
          .getByLabel("Place Keys")
          .locator("option")
          .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)),
      )
      .toEqual(["main:left", "main:center", "main:right", "hidden"]);

    // A drag into the Keys row must be refused, not silently accepted.
    await dragChipOnto(page, "keys", "soft:esc", true);
    await expect(page.locator("#keyRow #keyBarToggle")).toHaveCount(0);

    await place(page, "keys", "Keys", "hidden");
    await expect(page.locator("#keyBarToggle")).toBeHidden();
    await expect(page.locator("#keyBar")).toBeHidden();
    await expect.poll(async () => (await storedConfig(page)).expanded).toBe(false);
  });

  test("tapping a hidden key uses it at once and opens its position controls", async ({ page }) => {
    await openMarkup(page);
    await page.locator("#drawerSettingsButton").click();

    // One tap is "use this": it lands at the end of the Keys row and stays
    // selected, so choosing to use a key and choosing where it goes are one
    // gesture apart rather than two screens apart.
    await chip(page, "soft:f1").click();
    await expect
      .poll(async () => (await storedConfig(page)).zones.expanded.left.at(-1))
      .toBe("soft:f1");
    await expect(page.getByLabel("Place F1")).toHaveValue("expanded:left");
    await expect(page.getByRole("button", { name: "Move F1 to end" })).toBeDisabled();
    await expect(segment(page, "keyRow", "left")).toContainText("F1");

    // Keys cannot enter the row it opens, so it lands on the main row instead.
    await place(page, "keys", "Keys", "hidden");
    await chip(page, "keys").click();
    await expect.poll(async () => (await storedConfig(page)).zones.main.right).toContain("keys");
  });

  test("treats placement as activation, with no set or custom toggles left", async ({ page }) => {
    await openMarkup(page);
    await page.locator("#drawerSettingsButton").click();

    // Nothing gates a key any more: the sets checklist and the custom-key
    // custom-key toggle are gone, leaving placement as the only signal.
    await expect(page.locator("#inputLayoutEditor").getByText("Key sets")).toHaveCount(0);
    await expect(page.locator("#inputLayoutEditor .layout-hidden")).toBeVisible();

    await place(page, "soft:f1", "F1", "main:center");
    await expect(segment(page, "mainActionRow", "center")).toContainText("F1");

    await place(page, "soft:f1", "F1", "hidden");
    await expect(segment(page, "mainActionRow", "center")).not.toContainText("F1");
    await expect(
      page.locator('#inputLayoutEditor .layout-hidden [data-layout-action="soft:f1"]'),
    ).toHaveCount(1);
  });

  test("falls back to defaults for legacy and malformed storage", async ({ page }) => {
    await page.addInitScript((key) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          expanded: true,
          sets: ["nav"],
          custom: ["c-a"],
          order: ["esc", "tab"],
          zones: {
            main: ["ctrl-c", "keyboard", "keys", "send"],
            expanded: ["composer", "soft:c-a"],
            hidden: ["attachment"],
          },
        }),
      );
    }, STORAGE_KEY);
    await openMarkup(page);

    // The flat ADR-0186 arrays are not a v2 layout, so the bar resets instead of
    // inventing an alignment the user never chose.
    await expect
      .poll(() => renderedActions(page, "mainActionRow"))
      .toEqual(["soft:c-c", "keyboard", "keys"]);
    await expect(page.locator('[data-input-action="soft:c-a"]')).toHaveCount(0);
    await expect(page.locator("#composerSend")).toBeHidden();

    // `expanded` is validated on its own, so the bar stays open across the
    // zones reset.
    await expect(page.locator("#keyBar")).toBeVisible();
    await expect(page.locator('#keyRow [data-input-action="soft:esc"]')).toHaveCount(1);
    await page.locator("#inputModeToggle").click();
    await expect(page.locator("#composerSend")).toBeVisible();
    await page.locator("#inputModeToggle").click();
    await expect(page.locator("#composerSend")).toBeHidden();
  });

  test("rejects prototype names and out-of-bounds custom keys from storage", async ({ page }) => {
    await page.addInitScript((key) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          expanded: true,
          userKeys: [
            { id: "__proto__", label: "x", seq: "x" },
            { id: "constructor", label: "y", seq: "y" },
            { id: "u-blank", label: "  ", seq: "z" },
            { id: "u-toolong", label: "abcdefghij", seq: "z" },
            { id: "u-noseq", label: "^N", seq: "" },
            { id: "u-good", label: "^G", seq: "" },
          ],
          zones: {
            main: {
              left: ["soft:constructor", "soft:__proto__", "soft:u-good", "soft:u-noseq"],
              center: [],
              right: ["keys"],
            },
            expanded: { left: [], center: [], right: [] },
          },
        }),
      );
    }, STORAGE_KEY);
    await openMarkup(page);

    await expect(
      page.locator('[data-input-action="soft:constructor"], [data-input-action="soft:__proto__"]'),
    ).toHaveCount(0);
    await expect
      .poll(() => renderedActions(page, "mainActionRow"))
      .toEqual(["soft:u-good", "keys"]);

    // Blank labels, over-long labels, and empty sequences are dropped one by
    // one — a single bad entry must not take the whole list with it.
    await page.locator("#drawerSettingsButton").click();
    await expect(page.locator('#inputLayoutEditor [data-layout-action^="soft:u-"]')).toHaveCount(1);
    await page.getByLabel("Custom key kind").selectOption("raw");
    await page.getByLabel("Custom key label").fill("^Q");
    await page.getByLabel("Custom key sequence").fill("\\x11");
    await page.getByRole("button", { name: "Add custom key" }).click();
    await expect
      .poll(async () =>
        ((await storedConfig(page)).userKeys || []).map((entry: { id: string }) => entry.id),
      )
      .toHaveLength(2);
    await expect
      .poll(async () =>
        ((await storedConfig(page)).userKeys || []).map((entry: { id: string }) => entry.id),
      )
      .toContain("u-good");
  });

  test("registers a Ctrl combination custom key and deletes it again", async ({ page }) => {
    await openMarkup(page);
    await page.locator("#drawerSettingsButton").click();

    await page.getByLabel("Custom key kind").selectOption("combo");
    await page.getByLabel("Custom key modifier").selectOption("ctrl");
    await page.getByLabel("Custom key base key").selectOption("g");
    await expect(page.locator(".user-key-preview")).toContainText("^G → \\x07");
    // Ctrl+Shift+X is the same byte as Ctrl+X, so Shift is offered only with Alt.
    await expect(page.getByLabel("Custom key uses Shift")).toBeDisabled();
    await page.getByRole("button", { name: "Add custom key" }).click();

    const registered = page.locator('#keyRow [data-input-action^="soft:u-"]');
    await expect(registered).toHaveCount(1);
    await expect(registered).toHaveText("^G");
    await expect
      .poll(async () =>
        ((await storedConfig(page)).userKeys || []).map((entry: { seq: string }) => entry.seq),
      )
      .toEqual(["\u0007"]);

    await page.getByRole("button", { name: "Delete custom key ^G" }).click();
    await expect(page.locator('[data-input-action^="soft:u-"]')).toHaveCount(0);
    await expect.poll(async () => (await storedConfig(page)).userKeys).toEqual([]);
  });

  test("registers a raw escape sequence and reports invalid input", async ({ page }) => {
    await openMarkup(page);
    await page.locator("#drawerSettingsButton").click();
    await page.getByLabel("Custom key kind").selectOption("raw");

    await page.getByLabel("Custom key label").fill("C→");
    await page.getByLabel("Custom key sequence").fill("\\q");
    await page.getByRole("button", { name: "Add custom key" }).click();
    await expect(page.locator(".user-key-error")).toHaveText("Unknown escape \\q.");

    await page.getByLabel("Custom key sequence").fill("\\e[1;5C");
    await page.getByRole("button", { name: "Add custom key" }).click();
    await expect(page.locator(".user-key-error")).toHaveCount(0);
    await expect(page.locator('#keyRow [data-input-action^="soft:u-"]')).toHaveText("C→");
    await expect
      .poll(async () =>
        ((await storedConfig(page)).userKeys || []).map((entry: { seq: string }) => entry.seq),
      )
      .toEqual(["\u001b[1;5C"]);

    await page.reload();
    await page.setContent(remoteClientMarkupWithoutXterm());
    await expect(page.locator('#keyRow [data-input-action^="soft:u-"]')).toHaveText("C→");
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
          userKeys: [],
          zones: {
            main: { left: [], center: [], right: ["keys", "composer"] },
            expanded: { left: [], center: [], right: ["send"] },
          },
        }),
      );
    }, STORAGE_KEY);
    await openMarkup(page);

    const emptyState = page.locator("#keyRow > .key-row-empty");
    await expect(page.locator("#keyBar")).toBeVisible();
    await expect(page.locator("#composerSend")).toBeHidden();
    await expect(emptyState).toBeVisible();

    await page.locator("#mainActionRow #inputModeToggle").click();
    await expect(page.locator("#composerSend")).toBeVisible();
    await expect(emptyState).toHaveCount(0);

    await page.locator("#mainActionRow #inputModeToggle").click();
    await expect(page.locator("#composerSend")).toBeHidden();
    await expect(emptyState).toBeVisible();
  });

  test("paginates Settings and remembers the chosen tab", async ({ page }) => {
    await openMarkup(page);
    await page.locator("#drawerSettingsButton").click();

    // Input bar first, everything else out of the layout — that is the point of
    // paginating: one subject at a time instead of one long scroll.
    await expect(page.locator("#settingsPanelInputBar")).toBeVisible();
    for (const panel of ["composer", "display", "app"]) {
      await expect(
        page.locator(`#drawerSettingsView [data-settings-panel="${panel}"].settings-panel`),
      ).toBeHidden();
    }
    // Composer settings render in their own panel, no longer inside Input bar.
    await expect(page.locator("#inputLayoutEditor")).not.toContainText("History sharing");

    const displayTab = page.locator('#settingsTabs [data-settings-panel="display"]');
    await displayTab.click();
    await expect(displayTab).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#displaySection")).toBeVisible();
    await expect(page.locator("#settingsPanelInputBar")).toBeHidden();

    // Roving tabindex: arrows move within the tablist.
    await displayTab.press("ArrowRight");
    await expect(page.locator("#settingsPanelApp")).toBeVisible();
    await expect(page.locator('#settingsTabs [data-settings-panel="app"]')).toBeFocused();

    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("laymux.remote.settingsPanel")))
      .toBe("app");

    await page.reload();
    await page.setContent(remoteClientMarkupWithoutXterm());
    await page.locator("#drawerSettingsButton").click();
    await expect(page.locator("#settingsPanelApp")).toBeVisible();
  });

  test("keeps the Settings tab strip visible above a long Input bar panel", async ({ page }) => {
    await openMarkup(page);
    await page.setViewportSize({ width: 390, height: 390 });
    await page.locator("#drawerSettingsButton").click();

    const settingsView = page.locator("#drawerSettingsView");
    const settingsTabs = page.locator("#settingsTabs");
    const readGeometry = () =>
      settingsTabs.evaluate((tabs) => {
        const tab = tabs.querySelector<HTMLElement>("[data-settings-panel]");
        const view = tabs.parentElement;
        const tabsRect = tabs.getBoundingClientRect();
        const viewRect = view?.getBoundingClientRect();
        return {
          tabsHeight: tabsRect.height,
          firstTabHeight: tab?.getBoundingClientRect().height ?? 0,
          tabsTop: tabsRect.top,
          viewTop: viewRect?.top ?? 0,
        };
      });

    const initial = await readGeometry();
    expect(initial.tabsHeight).toBeGreaterThan(30);
    expect(initial.firstTabHeight).toBeGreaterThan(20);

    await settingsView.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const scrolled = await readGeometry();
    expect(scrolled.tabsHeight).toBe(initial.tabsHeight);
    expect(scrolled.firstTabHeight).toBe(initial.firstTabHeight);
    expect(Math.abs(scrolled.tabsTop - scrolled.viewTop)).toBeLessThanOrEqual(1);
  });

  test("keeps the Settings tab strip readable and scrollable at 240px", async ({ page }) => {
    await openMarkup(page);
    await page.setViewportSize({ width: 240, height: 844 });
    await page.locator("#drawerSettingsButton").click();

    // Tabs may only grow, never shrink: a squeezed tab pushes its label past
    // its own box (nowrap, no ellipsis) instead of scrolling the strip.
    const strip = await page.locator("#settingsTabs").evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      overflowX: getComputedStyle(element).overflowX,
    }));
    expect(strip.overflowX).toBe("auto");
    expect(strip.scrollWidth).toBeGreaterThan(strip.clientWidth);

    const overflowingLabels = await page
      .locator("#settingsTabs [data-settings-panel]")
      .evaluateAll((tabs) =>
        tabs.filter((tab) => tab.scrollWidth > tab.clientWidth).map((tab) => tab.textContent),
      );
    expect(overflowingLabels).toEqual([]);
    // The strip scrolls inside itself; the document never does.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(240);
  });

  test("falls back to the first Settings tab for an unknown stored panel", async ({ page }) => {
    await page.addInitScript(() =>
      localStorage.setItem("laymux.remote.settingsPanel", "__proto__"),
    );
    await openMarkup(page);
    await page.locator("#drawerSettingsButton").click();

    await expect(page.locator("#settingsPanelInputBar")).toBeVisible();
    await expect(page.locator('#settingsTabs [data-settings-panel="inputBar"]')).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  test("preserves the Settings scroll position while placement changes rerender", async ({
    page,
  }) => {
    await openMarkup(page);
    await page.locator("#drawerSettingsButton").click();

    const settingsView = page.locator("#drawerSettingsView");
    await settingsView.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const before = await settingsView.evaluate((element) => element.scrollTop);
    expect(before).toBeGreaterThan(0);

    await place(page, "attachment", "Attach file", "expanded:right");
    await expect
      .poll(() => settingsView.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await expect(segment(page, "keyRow", "right").locator("#attachFile")).toHaveCount(1);
  });
});
