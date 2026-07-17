import { expect, test, type WebSocketRoute } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const remotePagePath = new URL("../../src-tauri/src/remote_server/page.html", import.meta.url);
const remoteRoot = fileURLToPath(new URL("../../src-tauri/src/remote_server/", import.meta.url));

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
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

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

  test("keeps terminal keyboard focus while sending every soft-key sequence", async ({ page }) => {
    const writes: string[] = [];
    let outputSocket: WebSocketRoute | null = null;
    await page.addInitScript(() => {
      localStorage.setItem("laymux.remote.inputMode", "direct");
      localStorage.setItem(
        "laymux.remote.keybar",
        JSON.stringify({ visible: true, sets: ["nav", "edit", "ctrl", "fn"], custom: [] }),
      );
    });
    await page.route("http://remote.test/remote/", (route) =>
      route.fulfill({
        path: `${remoteRoot}page.html`,
        contentType: "text/html; charset=utf-8",
      }),
    );
    await page.route("http://remote.test/remote/vendor/xterm.js", (route) =>
      route.fulfill({
        path: `${remoteRoot}assets/xterm.js`,
        contentType: "application/javascript; charset=utf-8",
      }),
    );
    await page.route("http://remote.test/remote/vendor/addon-fit.js", (route) =>
      route.fulfill({
        path: `${remoteRoot}assets/addon-fit.js`,
        contentType: "application/javascript; charset=utf-8",
      }),
    );
    await page.route("http://remote.test/remote/vendor/xterm.css", (route) =>
      route.fulfill({
        path: `${remoteRoot}assets/xterm.css`,
        contentType: "text/css; charset=utf-8",
      }),
    );
    await page.route("http://remote.test/remote/v1/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/remote/v1/session/claim") {
        await route.fulfill({ json: { leaseId: "lease-1", heartbeatTimeoutSeconds: 45 } });
        return;
      }
      if (url.pathname === "/remote/v1/navigation") {
        await route.fulfill({
          json: {
            terminals: [{ id: "term-1", title: "Shell", appearance: {} }],
            activeWorkspace: {
              focusedPaneNumber: 1,
              panes: [
                {
                  paneNumber: 1,
                  terminalId: "term-1",
                  terminalLive: true,
                  viewType: "TerminalView",
                },
              ],
            },
            workspaces: [],
            docks: [],
            notifications: [],
          },
        });
        return;
      }
      if (url.pathname === "/remote/v1/terminals/term-1/write") {
        const body = route.request().postDataJSON() as { data: string };
        writes.push(body.data);
      }
      await route.fulfill({ json: {} });
    });
    await page.routeWebSocket(/\/remote\/v1\/terminals\/term-1\/output/, (socket) => {
      outputSocket = socket;
    });

    const cdp = await page.context().newCDPSession(page);
    await page.goto("http://remote.test/remote/#token=test-token");
    await page.locator("#connect").click();
    await expect(page.locator("#focusTerminal")).toBeEnabled();
    await page.locator("#focusTerminal").tap();

    const helperTextarea = page.locator(".xterm-helper-textarea");
    await expect(helperTextarea).toBeFocused();

    const fixedCases = [
      { id: "esc", sequence: "\x1b" },
      { id: "tab", sequence: "\t" },
      { id: "stab", sequence: "\x1b[Z" },
      { id: "enter", sequence: "\r" },
      { id: "bksp", sequence: "\x7f" },
      { id: "ins", sequence: "\x1b[2~" },
      { id: "del", sequence: "\x1b[3~" },
      { id: "pgup", sequence: "\x1b[5~" },
      { id: "pgdn", sequence: "\x1b[6~" },
      { id: "c-a", sequence: "\x01" },
      { id: "c-c", sequence: "\x03" },
      { id: "c-d", sequence: "\x04" },
      { id: "c-e", sequence: "\x05" },
      { id: "c-k", sequence: "\x0b" },
      { id: "c-l", sequence: "\x0c" },
      { id: "c-r", sequence: "\x12" },
      { id: "c-u", sequence: "\x15" },
      { id: "c-w", sequence: "\x17" },
      { id: "c-z", sequence: "\x1a" },
      { id: "f1", sequence: "\x1bOP" },
      { id: "f2", sequence: "\x1bOQ" },
      { id: "f3", sequence: "\x1bOR" },
      { id: "f4", sequence: "\x1bOS" },
      { id: "f5", sequence: "\x1b[15~" },
      { id: "f6", sequence: "\x1b[17~" },
      { id: "f7", sequence: "\x1b[18~" },
      { id: "f8", sequence: "\x1b[19~" },
      { id: "f9", sequence: "\x1b[20~" },
      { id: "f10", sequence: "\x1b[21~" },
      { id: "f11", sequence: "\x1b[23~" },
      { id: "f12", sequence: "\x1b[24~" },
    ];
    const cursorCases = [
      { id: "up", final: "A" },
      { id: "down", final: "B" },
      { id: "left", final: "D" },
      { id: "right", final: "C" },
      { id: "home", final: "H" },
      { id: "end", final: "F" },
    ];
    const renderedKeyIds = await page
      .locator("#keyRow .key-btn")
      .evaluateAll((buttons) => buttons.map((button) => (button as HTMLButtonElement).dataset.key));
    expect(renderedKeyIds).toEqual([
      "esc",
      "tab",
      "stab",
      "dpad",
      "up",
      "down",
      "left",
      "right",
      "home",
      "end",
      "enter",
      "bksp",
      "ins",
      "del",
      "pgup",
      "pgdn",
      "c-a",
      "c-c",
      "c-d",
      "c-e",
      "c-k",
      "c-l",
      "c-r",
      "c-u",
      "c-w",
      "c-z",
      "f1",
      "f2",
      "f3",
      "f4",
      "f5",
      "f6",
      "f7",
      "f8",
      "f9",
      "f10",
      "f11",
      "f12",
    ]);

    const pressKey = async (id: string, sequence: string) => {
      const writeIndex = writes.length;
      await page.locator(`[data-key="${id}"]`).tap();
      await expect(helperTextarea).toBeFocused();
      await expect.poll(() => writes.length).toBe(writeIndex + 1);
      expect(writes[writeIndex]).toBe(sequence);
    };

    const flickKey = async (dx: number, dy: number, sequence: string) => {
      const flickButton = page.locator('[data-key="dpad"]');
      await flickButton.scrollIntoViewIfNeeded();
      const box = await flickButton.boundingBox();
      expect(box).not.toBeNull();
      const writeIndex = writes.length;
      const x = box!.x + box!.width / 2;
      const y = box!.y + box!.height / 2;
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y, id: 1 }],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x + dx, y: y + dy, id: 1 }],
      });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await expect(helperTextarea).toBeFocused();
      await expect.poll(() => writes.length).toBe(writeIndex + 1);
      expect(writes[writeIndex]).toBe(sequence);
    };

    for (const key of fixedCases) {
      await pressKey(key.id, key.sequence);
    }
    for (const key of cursorCases) {
      await pressKey(key.id, `\x1b[${key.final}`);
    }
    await flickKey(0, -32, "\x1b[A");
    await flickKey(32, 0, "\x1b[C");
    await flickKey(0, 32, "\x1b[B");
    await flickKey(-32, 0, "\x1b[D");

    await expect.poll(() => outputSocket).not.toBeNull();
    outputSocket!.send(Buffer.from("\x1b[?1hAPP-MODE"));
    await expect(page.locator(".xterm-rows")).toContainText("APP-MODE");
    for (const key of cursorCases) {
      await pressKey(key.id, `\x1bO${key.final}`);
    }
    await flickKey(0, -32, "\x1bOA");
    await flickKey(32, 0, "\x1bOC");
    await flickKey(0, 32, "\x1bOB");
    await flickKey(-32, 0, "\x1bOD");
  });

  test("copies a selection when mouseup lands outside the terminal", async ({ page }) => {
    await page.addInitScript(() => {
      class MockTerminal {
        options: Record<string, unknown>;
        modes = { applicationCursorKeysMode: false };
        cols = 80;
        rows = 24;
        selection = "";

        constructor(options: Record<string, unknown>) {
          this.options = options;
          Object.defineProperty(window, "__mockTerminal", { value: this, configurable: true });
        }

        loadAddon(_addon: unknown) {}
        open(_element: HTMLElement) {}
        onData(_listener: (data: string) => void) {}
        onResize(_listener: (size: { cols: number; rows: number }) => void) {}
        onSelectionChange(_listener: () => void) {}
        onScroll(_listener: () => void) {}
        hasSelection() {
          return Boolean(this.selection);
        }
        getSelection() {
          return this.selection;
        }
        getSelectionPosition() {
          return null;
        }
        reset() {}
        refresh(_start: number, _end: number) {}
        write(_data: string | Uint8Array, callback?: () => void) {
          callback?.();
        }
        focus() {}
        scrollLines(_amount: number) {}
      }

      class MockFitAddon {
        fit() {}
      }

      class MockResizeObserver {
        observe(_target: Element) {}
        disconnect() {}
      }

      class MockWebSocket {
        binaryType = "";
        onopen: (() => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onclose: (() => void) | null = null;
        onerror: (() => void) | null = null;
        close() {}
      }

      Object.defineProperty(window, "Terminal", { value: MockTerminal, configurable: true });
      Object.defineProperty(window, "FitAddon", {
        value: { FitAddon: MockFitAddon },
        configurable: true,
      });
      Object.defineProperty(window, "ResizeObserver", {
        value: MockResizeObserver,
        configurable: true,
      });
      Object.defineProperty(window, "WebSocket", {
        value: MockWebSocket,
        configurable: true,
      });
    });
    await page.route("http://remote.test/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>remote test</title>",
      }),
    );
    await page.route("**/remote/v1/**", (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.endsWith("/session/claim")) {
        return route.fulfill({ json: { leaseId: "lease-1", heartbeatTimeoutSeconds: 45 } });
      }
      if (pathname.endsWith("/navigation")) {
        return route.fulfill({
          json: {
            terminals: [{ id: "term-1", title: "Shell", appearance: {} }],
            activeWorkspace: {
              focusedPaneNumber: 1,
              panes: [
                {
                  paneNumber: 1,
                  terminalId: "term-1",
                  terminalLive: true,
                  viewType: "TerminalView",
                },
              ],
            },
            workspaces: [],
            docks: [],
            notifications: [],
          },
        });
      }
      return route.fulfill({ json: {} });
    });
    await page.goto("http://remote.test/");
    await page.setContent(await loadRemotePageMarkup(true));
    await page.locator("#token").fill("test-token");
    await page.locator("#connect").click();
    await expect(page.locator("#ctrlC")).toBeEnabled();

    await page.evaluate(() => {
      const testWindow = window as Window & {
        __copiedText?: string[];
        __mockTerminal?: { selection: string };
      };
      testWindow.__copiedText = [];
      Object.defineProperty(document, "execCommand", {
        configurable: true,
        value: (command: string) => {
          if (command !== "copy") return false;
          const active = document.activeElement as HTMLTextAreaElement | null;
          testWindow.__copiedText?.push(active?.value || "");
          return true;
        },
      });
      document.addEventListener(
        "mouseup",
        () => {
          if (testWindow.__mockTerminal) {
            testWindow.__mockTerminal.selection = "selected outside terminal";
          }
        },
        { once: true },
      );
      document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });

    await expect
      .poll(() =>
        page.evaluate(() => (window as Window & { __copiedText?: string[] }).__copiedText || []),
      )
      .toEqual(["selected outside terminal"]);
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
