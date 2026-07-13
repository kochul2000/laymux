import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const remotePagePath = new URL("../../src-tauri/src/remote_server/page.html", import.meta.url);

async function loadRemotePageMarkup(runInlineScript = false): Promise<string> {
  const html = await readFile(remotePagePath, "utf8");
  const withoutExternalAssets = html
    .replace(/<script\s+src=[^>]*><\/script>/g, "")
    .replace(/<link[^>]*xterm\.css[^>]*>/g, "");
  return runInlineScript
    ? withoutExternalAssets
    : withoutExternalAssets.replace(/<script[\s\S]*?<\/script>/g, "");
}

test.describe("remote mobile layout", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.setContent(await loadRemotePageMarkup());
  });

  test("keeps the hidden-key footer compact", async ({ page }) => {
    const footer = page.locator("footer");
    const terminalMeta = page.locator("#terminalMeta");

    await expect(page.locator("#keyBar")).toBeHidden();
    await expect(terminalMeta).toBeHidden();
    expect((await footer.boundingBox())?.height).toBeLessThan(50);
    const footerButtons = await footer.locator("button").evaluateAll((buttons) =>
      buttons.map((button) => ({
        width: button.getBoundingClientRect().width,
        minWidth: getComputedStyle(button).minWidth,
      })),
    );
    expect(footerButtons).toHaveLength(3);
    const widths = footerButtons.map(({ width }) => width);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(0.1);
    expect(footerButtons.every(({ minWidth }) => minWidth === "0px")).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);

    await page.setViewportSize({ width: 180, height: 844 });
    const narrowFooter = await footer.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      buttonWidths: Array.from(
        element.querySelectorAll("button"),
        (button) => button.getBoundingClientRect().width,
      ),
    }));
    expect(narrowFooter.scrollWidth).toBe(narrowFooter.clientWidth);
    expect(
      Math.max(...narrowFooter.buttonWidths) - Math.min(...narrowFooter.buttonWidths),
    ).toBeLessThan(0.1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(180);
  });

  test("confines horizontal scrolling to the soft-key row", async ({ page }) => {
    await page.locator("#keyRow").evaluate((row) => {
      for (const label of [
        "Esc",
        "Tab",
        "Shift+Tab",
        "Up",
        "Down",
        "Left",
        "Right",
        "Home",
        "End",
      ]) {
        const button = document.createElement("button");
        button.className = "key-btn";
        button.textContent = label;
        row.append(button);
      }
    });
    await page.locator("#keyBar").evaluate((bar) => {
      bar.hidden = false;
    });

    const keyRow = page.locator("#keyRow");
    const overflow = await keyRow.evaluate((row) => ({
      clientWidth: row.clientWidth,
      scrollWidth: row.scrollWidth,
      overflowX: getComputedStyle(row).overflowX,
      scrollbarWidth: getComputedStyle(row).scrollbarWidth,
      webkitScrollbarDisplay: getComputedStyle(row, "::-webkit-scrollbar").display,
      settingsInsideRow: row.firstElementChild?.id === "keyBarSettings",
      buttonRows: new Set(Array.from(row.children, (child) => (child as HTMLElement).offsetTop))
        .size,
    }));

    expect(overflow.scrollWidth).toBeGreaterThan(overflow.clientWidth);
    expect(overflow.overflowX).toBe("auto");
    expect(overflow.scrollbarWidth).toBe("none");
    expect(overflow.webkitScrollbarDisplay).toBe("none");
    expect(overflow.settingsInsideRow).toBe(true);
    expect(overflow.buttonRows).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);

    const settingsMovement = await keyRow.evaluate((row) => {
      const settings = row.querySelector<HTMLElement>("#keyBarSettings")!;
      const before = settings.getBoundingClientRect().x;
      row.scrollLeft = row.scrollWidth;
      const after = settings.getBoundingClientRect().x;
      row.scrollLeft = 0;
      return { before, after };
    });
    expect(settingsMovement.after).toBeLessThan(settingsMovement.before);
  });

  test("keeps the key-bar height stable across empty and populated states", async ({ page }) => {
    const keyBar = page.locator("#keyBar");
    const keyRow = page.locator("#keyRow");
    await keyBar.evaluate((bar) => {
      bar.hidden = false;
    });

    const settingsOnlyHeight = (await keyBar.boundingBox())?.height;

    await keyRow.evaluate((row) => {
      const empty = document.createElement("div");
      empty.className = "key-row-empty";
      empty.textContent = "No keys selected";
      row.append(empty);
    });
    const emptyMessageHeight = (await keyBar.boundingBox())?.height;

    await keyRow.evaluate((row) => {
      row.querySelector(".key-row-empty")?.remove();
      const button = document.createElement("button");
      button.className = "key-btn";
      button.textContent = "Esc";
      row.append(button);
    });
    const populatedHeight = (await keyBar.boundingBox())?.height;

    expect(settingsOnlyHeight).toBe(emptyMessageHeight);
    expect(emptyMessageHeight).toBe(populatedHeight);
  });

  test("offers a four-way flick direction key", async ({ page }) => {
    await page.route("http://remote.test/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>remote test</title>",
      }),
    );
    await page.goto("http://remote.test/");
    await page.setContent(await loadRemotePageMarkup(true));
    await page.locator("#keyBarToggle").click();

    const flickButton = page.locator('[data-key="dpad"]');
    const flickHint = page.locator("#keyFlickHint");
    await expect(flickButton).toHaveCount(1);
    await flickButton.evaluate((button: HTMLButtonElement) => {
      button.disabled = false;
    });
    await expect(flickButton).toHaveAttribute(
      "aria-label",
      "Flick for arrow key: up, right, down, or left",
    );

    const directions = [
      { name: "up", dx: 0, dy: -32 },
      { name: "right", dx: 32, dy: 0 },
      { name: "down", dx: 0, dy: 32 },
      { name: "left", dx: -32, dy: 0 },
    ] as const;
    for (const { name, dx, dy } of directions) {
      const box = await flickButton.boundingBox();
      expect(box).not.toBeNull();
      const x = box!.x + box!.width / 2;
      const y = box!.y + box!.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await expect(flickHint).toBeVisible();
      await expect(flickHint.locator("[data-flick-direction]")).toHaveCount(4);

      await page.mouse.move(x + dx, y + dy);
      await expect(flickHint).toHaveAttribute("data-direction", name);
      await expect(flickHint.locator(`[data-flick-direction="${name}"]`)).toHaveClass(/active/);

      await page.mouse.up();
      await expect(flickHint).toBeHidden();
    }
  });

  test("tracks the restored visual viewport height", async ({ page }) => {
    await page.route("http://remote.test/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>remote test</title>",
      }),
    );
    await page.goto("http://remote.test/");
    await page.setContent(await loadRemotePageMarkup(true));
    const app = page.locator(".app");

    await expect(page.locator("#keyRow .key-btn")).toHaveCount(10);
    await expect(page.locator("#keyBar")).toBeHidden();
    await page.locator("#keyBarToggle").click();
    await expect(page.locator("#keyBar")).toBeVisible();

    await page.setViewportSize({ width: 390, height: 500 });
    await expect(app).toHaveCSS("height", "500px");

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(app).toHaveCSS("height", "844px");
    expect((await app.boundingBox())?.height).toBe(844);
  });
});
