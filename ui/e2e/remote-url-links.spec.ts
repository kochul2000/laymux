import { expect, test, type BrowserContext } from "@playwright/test";
import { fulfillRemoteClientAsset } from "./remote-client-assets";

const navigation = {
  activeWorkspace: {
    id: "ws-1",
    name: "Main",
    focusedPaneNumber: 1,
    panes: [
      {
        id: "pane-1",
        location: "workspace",
        workspaceId: "ws-1",
        paneIndex: 0,
        paneNumber: 1,
        viewType: "terminal",
        terminalId: "terminal-1",
        terminalLive: true,
        title: "Shell",
        profile: "PowerShell",
        cwd: "C:\\work",
        branch: "main",
        activity: { type: "shell" },
        outputActive: false,
        commandRunning: false,
        isFocused: true,
        unreadCount: 0,
        hidden: false,
        collapsed: false,
        x: 0,
        y: 0,
        w: 1,
        h: 1,
      },
    ],
  },
  workspaces: [
    {
      id: "ws-1",
      name: "Main",
      isActive: true,
      hidden: false,
      collapsed: false,
      paneCount: 1,
      terminalPaneCount: 1,
      liveTerminalCount: 1,
      unreadCount: 0,
      panes: undefined,
    },
  ],
  docks: [],
  terminals: [
    {
      id: "terminal-1",
      title: "Shell",
      profile: "PowerShell",
      cwd: "C:\\work",
      workspaceId: "ws-1",
      paneNumber: 1,
      appearance: {},
    },
  ],
  workspaceSelector: { display: {}, pathEllipsis: "start" },
  notifications: [],
  unreadNotificationCount: 0,
};

const plainUrl = "https://links.example/plain";
const oscUrl = "https://links.example/osc";
const repoBase = "https://github.com/owner/repo";

const snapshotText = [
  `Plain: ${plainUrl}`,
  "",
  `OSC: \x1b]8;;${oscUrl}\x07open\x1b]8;;\x07`,
  "Unsafe: \x1b]8;;javascript:alert(document.domain)\x07blocked\x1b]8;;\x07",
  "Issue: #123",
  "Ignored: abc#12 #fff v1.2#3",
  "Wide: 가 #45",
  "Words: alpha bravo omega",
  "",
].join("\r\n");

function snapshotFrames(text: string): { header: string; payload: Buffer } {
  const payload = Buffer.from(text, "utf8");
  return {
    header: JSON.stringify({
      type: "terminal.output",
      version: 1,
      phase: "snapshot",
      seqStart: 0,
      seqEnd: payload.byteLength,
      byteLength: payload.byteLength,
      state: {
        version: 1,
        generation: 1,
        snapshotStartSeq: 0,
        snapshotSeq: payload.byteLength,
        sourceStartSeq: 0,
        sourceSeq: payload.byteLength,
        snapshotKind: "raw",
        protocolRevision: 0,
        modes: { bracketedPaste: false },
        geometry: { revision: 0, cols: 80, rows: 24 },
      },
    }),
    payload,
  };
}

async function installRemoteMocks(context: BrowserContext) {
  await context.route("https://links.example/**", (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: "<!doctype html>" }),
  );
  await context.route("https://github.com/owner/repo/issues/**", (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: "<!doctype html>" }),
  );
  await context.route("http://remote.test/remote/**", async (route) => {
    const url = new URL(route.request().url());
    if (await fulfillRemoteClientAsset(route, url.pathname)) return;
    if (url.pathname === "/remote/v1/session/claim") {
      return route.fulfill({
        json: {
          active: true,
          leaseId: "lease-links",
          resumeToken: "resume-links",
          heartbeatTimeoutSeconds: 45,
        },
      });
    }
    if (url.pathname === "/remote/v1/session/heartbeat") {
      return route.fulfill({ json: { active: true, leaseId: "lease-links" } });
    }
    if (url.pathname === "/remote/v1/navigation") {
      return route.fulfill({ json: navigation });
    }
    if (url.pathname === "/remote/v1/terminals/terminal-1/focus") {
      return route.fulfill({ json: { focused: "terminal-1" } });
    }
    if (url.pathname === "/remote/v1/terminals/terminal-1/resize") {
      return route.fulfill({ json: { resized: true } });
    }
    if (url.pathname === "/remote/v1/terminals/terminal-1/github-repo") {
      return route.fulfill({ json: { cwd: "C:\\work", repoBase } });
    }
    return route.fulfill({ json: {} });
  });
}

type RemoteTerminalWindow = typeof window & {
  Terminal: { prototype: { reset: () => void } };
  __remoteTerm?: {
    buffer: {
      active: {
        getLine: (line: number) => { translateToString: () => string } | undefined;
        viewportY?: number;
      };
    };
    cols: number;
    rows: number;
    getSelection: () => string;
    textarea?: HTMLTextAreaElement;
  };
  __copiedSelections?: string[];
  __openedExternalUrls?: string[];
  __focusSteals?: { helperFocus: number; composerBlur: number };
};

/**
 * Android wrapper mode: the secure WebView has no multiple-window support and no
 * off-origin navigation, so `page.html` must route link activation to the native
 * bridge instead of `window.open` (ADR-0162). The stub below stands in for the
 * Kotlin side — HTTP over `requestRemoteHttp`, output over the binary transport —
 * so the real xterm link path runs in wrapper mode.
 */
async function installAndroidWrapperBridge(
  page: import("@playwright/test").Page,
  options: { navigation: unknown; repoBase: string; snapshotText: string },
) {
  const { header } = snapshotFrames(options.snapshotText);
  await page.addInitScript(
    (args: { navigation: unknown; repoBase: string; header: string; payload: string }) => {
      const target = window as RemoteTerminalWindow & {
        LaymuxNative?: unknown;
        LaymuxOutputTransport?: { onmessage?: (event: { data: ArrayBuffer }) => void };
        laymuxAndroidE2e?: { onHttpResponse: (requestId: string, responseJson: string) => void };
      };
      target.__openedExternalUrls = [];
      const encoder = new TextEncoder();

      const responseBodyFor = (path: string): unknown => {
        if (path.startsWith("/remote/v1/session/claim")) {
          return {
            active: true,
            leaseId: "lease-links",
            resumeToken: "resume-links",
            heartbeatTimeoutSeconds: 45,
          };
        }
        if (path.startsWith("/remote/v1/session/heartbeat")) {
          return { active: true, leaseId: "lease-links" };
        }
        if (path.startsWith("/remote/v1/navigation")) return args.navigation;
        if (path.includes("/github-repo")) return { cwd: "C:\\work", repoBase: args.repoBase };
        if (path.includes("/focus")) return { focused: "terminal-1" };
        if (path.includes("/resize")) return { resized: true };
        return {};
      };

      target.LaymuxNative = {
        requestRemoteHttp(requestId: string, _method: string, path: string) {
          setTimeout(
            () =>
              target.laymuxAndroidE2e?.onHttpResponse(
                requestId,
                JSON.stringify({ status: 200, body: responseBodyFor(path) }),
              ),
            0,
          );
        },
        cancelRemoteHttp() {},
        setRemoteLease() {},
        disconnectRemote() {},
        openExternalUrl(url: string) {
          target.__openedExternalUrls?.push(url);
        },
      };

      const bridgeFrame = (kind: number, streamId: string, payload: Uint8Array): ArrayBuffer => {
        const id = encoder.encode(streamId);
        const frame = new Uint8Array(3 + id.byteLength + payload.byteLength);
        frame[0] = kind;
        frame[1] = (id.byteLength >> 8) & 0xff;
        frame[2] = id.byteLength & 0xff;
        frame.set(id, 3);
        frame.set(payload, 3 + id.byteLength);
        return frame.buffer;
      };
      const record = (recordKind: number, body: Uint8Array): Uint8Array => {
        const payload = new Uint8Array(1 + body.byteLength);
        payload[0] = recordKind;
        payload.set(body, 1);
        return payload;
      };

      target.LaymuxOutputTransport = {
        postMessage(json: string) {
          const message = JSON.parse(json) as { type: string; streamId: string };
          if (message.type !== "open") return;
          const deliver = (kind: number, payload: Uint8Array) =>
            target.LaymuxOutputTransport?.onmessage?.({
              data: bridgeFrame(kind, message.streamId, payload),
            });
          setTimeout(() => {
            deliver(1, new Uint8Array(0));
            deliver(2, record(2, encoder.encode(args.header)));
            deliver(2, record(3, encoder.encode(args.payload)));
          }, 0);
        },
      };
    },
    {
      navigation: options.navigation,
      repoBase: options.repoBase,
      header,
      payload: options.snapshotText,
    },
  );
}

test("Remote xterm opens URL and GitHub issue/PR links in safe new tabs", async ({
  context,
  page,
}) => {
  await installRemoteMocks(context);
  await page.routeWebSocket(/\/remote\/v1\/terminals\/terminal-1\/output/, (socket) => {
    const { header, payload } = snapshotFrames(snapshotText);
    socket.send(header);
    socket.send(payload);
  });

  await page.goto("http://remote.test/remote/#token=remote-secret");
  await page.evaluate(() => {
    const target = window as RemoteTerminalWindow;
    const originalReset = target.Terminal.prototype.reset;
    target.Terminal.prototype.reset = function resetCapturingInstance() {
      target.__remoteTerm = this as never;
      return originalReset.call(this);
    };
  });

  await page.locator("#connect").click();
  await expect(page.locator("#status")).toHaveText("Main · Pane 1");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const buffer = (window as RemoteTerminalWindow).__remoteTerm?.buffer.active;
        return Array.from(
          { length: 10 },
          (_, row) => buffer?.getLine(row)?.translateToString() || "",
        ).join("\n");
      }),
    )
    .toContain("Unsafe: blocked");

  // Attach schedules a follow-up fit. Let cell geometry settle before exercising
  // xterm's real hover + click linkifier path.
  await page.waitForTimeout(250);
  const screen = page.locator(".xterm-screen");
  const screenBox = await screen.boundingBox();
  expect(screenBox).not.toBeNull();
  const geometry = await page.evaluate(() => {
    const term = (window as RemoteTerminalWindow).__remoteTerm;
    return { cols: term?.cols || 1, rows: term?.rows || 1 };
  });
  const cellWidth = screenBox!.width / geometry.cols;
  const cellHeight = screenBox!.height / geometry.rows;

  const clickCell = async (column: number, row: number) => {
    const x = screenBox!.x + (column + 0.5) * cellWidth;
    const y = screenBox!.y + (row + 0.5) * cellHeight;
    await page.mouse.move(x, y);
    await page.waitForTimeout(150);
    await page.mouse.click(x, y);
  };
  const openCellInSafeTab = async (column: number, row: number, expectedUrl: string) => {
    const popupPromise = context.waitForEvent("page");
    await clickCell(column, row);
    const popup = await popupPromise;
    await expect.poll(() => popup.url()).toBe(expectedUrl);
    expect(await popup.evaluate(() => window.opener === null)).toBe(true);
    await popup.close();
  };

  await openCellInSafeTab("Plain: https://".length, 0, plainUrl);
  await openCellInSafeTab("OSC: ".length, 2, oscUrl);
  await openCellInSafeTab("Issue: ".length, 4, `${repoBase}/issues/123`);
  // `가` occupies two xterm cells, so `#45` starts three cells after the
  // ASCII prefix (wide lead + trailing cell + separating space).
  await openCellInSafeTab("Wide: ".length + 3, 6, `${repoBase}/issues/45`);

  // OSC 8 text is controlled by terminal output. Non-web schemes must not gain
  // script execution or local-file navigation through the Remote browser.
  const pageCount = context.pages().length;
  await clickCell("Unsafe: ".length, 3);
  await clickCell("Ignored: abc".length, 5);
  await clickCell("Ignored: abc#12 ".length, 5);
  await clickCell("Ignored: abc#12 #fff v1.2".length, 5);
  await page.waitForTimeout(100);
  expect(context.pages()).toHaveLength(pageCount);
});

test.describe("Android wrapper URL activation", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("Remote hands links to the native bridge instead of opening a tab", async ({
    context,
    page,
  }) => {
    await installRemoteMocks(context);
    await installAndroidWrapperBridge(page, { navigation, repoBase, snapshotText });

    await page.goto("http://remote.test/remote/?androidE2e=1");
    await page.evaluate(() => {
      const target = window as RemoteTerminalWindow;
      const originalReset = target.Terminal.prototype.reset;
      target.Terminal.prototype.reset = function resetCapturingInstance() {
        target.__remoteTerm = this as never;
        return originalReset.call(this);
      };
    });

    await page.locator("#connect").click();
    await expect(page.locator("#status")).toHaveText("Main · Pane 1");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const buffer = (window as RemoteTerminalWindow).__remoteTerm?.buffer.active;
          return Array.from(
            { length: 10 },
            (_, row) => buffer?.getLine(row)?.translateToString() || "",
          ).join("\n");
        }),
      )
      .toContain("Unsafe: blocked");

    await page.waitForTimeout(250);
    const screenBox = await page.locator(".xterm-screen").boundingBox();
    expect(screenBox).not.toBeNull();
    const geometry = await page.evaluate(() => {
      const term = (window as RemoteTerminalWindow).__remoteTerm;
      return { cols: term?.cols || 1, rows: term?.rows || 1 };
    });
    const cellWidth = screenBox!.width / geometry.cols;
    const cellHeight = screenBox!.height / geometry.rows;
    const tapCell = (column: number, row: number) =>
      page.touchscreen.tap(
        screenBox!.x + (column + 0.5) * cellWidth,
        screenBox!.y + (row + 0.5) * cellHeight,
      );
    const openedUrls = () =>
      page.evaluate(() => (window as RemoteTerminalWindow).__openedExternalUrls || []);

    const pageCount = context.pages().length;

    await tapCell("Plain: https://".length, 0);
    await expect.poll(openedUrls).toEqual([plainUrl]);
    await tapCell("OSC: ".length, 2);
    await expect.poll(openedUrls).toEqual([plainUrl, oscUrl]);
    await tapCell("Issue: ".length, 4);
    await expect.poll(openedUrls).toEqual([plainUrl, oscUrl, `${repoBase}/issues/123`]);

    // The wrapper must keep the same scheme gate, and must never fall back to a
    // new tab or a navigation of the Remote document itself.
    await tapCell("Unsafe: ".length, 3);
    await tapCell("Ignored: abc".length, 5);
    await page.waitForTimeout(200);
    expect(await openedUrls()).toEqual([plainUrl, oscUrl, `${repoBase}/issues/123`]);
    expect(context.pages()).toHaveLength(pageCount);
    expect(new URL(page.url()).pathname).toBe("/remote/");
  });
});

test.describe("touch URL activation", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("Remote xterm opens URL and GitHub issue/PR links from a touch tap", async ({
    context,
    page,
  }) => {
    await installRemoteMocks(context);
    await page.routeWebSocket(/\/remote\/v1\/terminals\/terminal-1\/output/, (socket) => {
      const { header, payload } = snapshotFrames(snapshotText);
      socket.send(header);
      socket.send(payload);
    });

    await page.goto("http://remote.test/remote/#token=remote-secret");
    await page.evaluate(() => {
      const target = window as RemoteTerminalWindow;
      const originalReset = target.Terminal.prototype.reset;
      target.Terminal.prototype.reset = function resetCapturingInstance() {
        target.__remoteTerm = this as never;
        return originalReset.call(this);
      };
    });

    await page.locator("#connect").click();
    await expect(page.locator("#status")).toHaveText("Main · Pane 1");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const buffer = (window as RemoteTerminalWindow).__remoteTerm?.buffer.active;
          return Array.from(
            { length: 10 },
            (_, row) => buffer?.getLine(row)?.translateToString() || "",
          ).join("\n");
        }),
      )
      .toContain("Unsafe: blocked");

    await page.waitForTimeout(250);
    const screenBox = await page.locator(".xterm-screen").boundingBox();
    expect(screenBox).not.toBeNull();
    const geometry = await page.evaluate(() => {
      const term = (window as RemoteTerminalWindow).__remoteTerm;
      return { cols: term?.cols || 1, rows: term?.rows || 1 };
    });
    const cellWidth = screenBox!.width / geometry.cols;
    const cellHeight = screenBox!.height / geometry.rows;

    const tapCell = async (column: number, row: number) => {
      const x = screenBox!.x + (column + 0.5) * cellWidth;
      const y = screenBox!.y + (row + 0.5) * cellHeight;
      await page.touchscreen.tap(x, y);
    };
    const openCellFromTouchTap = async (column: number, row: number, expectedUrl: string) => {
      const popupPromise = context.waitForEvent("page");
      await tapCell(column, row);
      const popup = await popupPromise;
      await expect.poll(() => popup.url()).toBe(expectedUrl);
      expect(await popup.evaluate(() => window.opener === null)).toBe(true);
      await popup.close();
    };

    await openCellFromTouchTap("Plain: https://".length, 0, plainUrl);
    await openCellFromTouchTap("OSC: ".length, 2, oscUrl);
    await openCellFromTouchTap("Issue: ".length, 4, `${repoBase}/issues/123`);

    const pageCount = context.pages().length;
    await tapCell("Unsafe: ".length, 3);
    await tapCell("Ignored: abc".length, 5);
    await page.waitForTimeout(200);
    expect(context.pages()).toHaveLength(pageCount);
  });

  test("long press selects a word and drag extends it by cell", async ({ context, page }) => {
    await installRemoteMocks(context);
    await page.addInitScript(() => {
      const target = window as RemoteTerminalWindow;
      target.__copiedSelections = [];
      document.execCommand = (command) => {
        if (command !== "copy") return false;
        const source = document.activeElement;
        target.__copiedSelections?.push(source instanceof HTMLTextAreaElement ? source.value : "");
        return true;
      };
    });
    await page.routeWebSocket(/\/remote\/v1\/terminals\/terminal-1\/output/, (socket) => {
      const { header, payload } = snapshotFrames(snapshotText);
      socket.send(header);
      socket.send(payload);
    });

    await page.goto("http://remote.test/remote/#token=remote-secret");
    await page.evaluate(() => {
      const target = window as RemoteTerminalWindow;
      const originalReset = target.Terminal.prototype.reset;
      target.Terminal.prototype.reset = function resetCapturingInstance() {
        target.__remoteTerm = this as never;
        return originalReset.call(this);
      };
    });
    await page.locator("#connect").click();
    await expect(page.locator("#status")).toHaveText("Main · Pane 1");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as RemoteTerminalWindow).__remoteTerm?.buffer.active
              .getLine(7)
              ?.translateToString() || "",
        ),
      )
      .toContain("Words: alpha bravo omega");

    await page.waitForTimeout(250);
    const screenBox = await page.locator(".xterm-screen").boundingBox();
    expect(screenBox).not.toBeNull();
    const geometry = await page.evaluate(() => {
      const term = (window as RemoteTerminalWindow).__remoteTerm;
      return { cols: term?.cols || 1, rows: term?.rows || 1 };
    });
    const cellWidth = screenBox!.width / geometry.cols;
    const cellHeight = screenBox!.height / geometry.rows;
    const x = screenBox!.x + ("Words: alpha ".length + 2.5) * cellWidth;
    const y = screenBox!.y + 7.5 * cellHeight;
    const cdp = await context.newCDPSession(page);

    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y }],
    });
    await page.waitForTimeout(550);

    await expect
      .poll(() =>
        page.evaluate(() => (window as RemoteTerminalWindow).__remoteTerm?.getSelection() || ""),
      )
      .toBe("bravo");
    expect(await page.evaluate(() => (window as RemoteTerminalWindow).__copiedSelections)).toEqual(
      [],
    );

    const dragX = screenBox!.x + 21.1 * cellWidth;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: dragX, y }],
    });

    await expect
      .poll(() =>
        page.evaluate(() => (window as RemoteTerminalWindow).__remoteTerm?.getSelection() || ""),
      )
      .toBe("bravo om");

    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect
      .poll(() => page.evaluate(() => (window as RemoteTerminalWindow).__copiedSelections))
      .toEqual(["bravo om"]);
  });

  async function connectRemoteWithWords(
    context: BrowserContext,
    page: import("@playwright/test").Page,
    inputMode: "composer" | "direct",
  ) {
    await installRemoteMocks(context);
    await page.addInitScript((mode) => {
      localStorage.setItem("laymux.remote.inputMode", mode);
    }, inputMode);
    await page.routeWebSocket(/\/remote\/v1\/terminals\/terminal-1\/output/, (socket) => {
      const { header, payload } = snapshotFrames(snapshotText);
      socket.send(header);
      socket.send(payload);
    });
    await page.goto("http://remote.test/remote/#token=remote-secret");
    await page.evaluate(() => {
      const target = window as RemoteTerminalWindow;
      const originalReset = target.Terminal.prototype.reset;
      target.Terminal.prototype.reset = function resetCapturingInstance() {
        target.__remoteTerm = this as never;
        return originalReset.call(this);
      };
    });
    await page.locator("#connect").click();
    await expect(page.locator("#status")).toHaveText("Main · Pane 1");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as RemoteTerminalWindow).__remoteTerm?.buffer.active
              .getLine(7)
              ?.translateToString() || "",
        ),
      )
      .toContain("Words: alpha bravo omega");
  }

  async function installFocusStealCounters(page: import("@playwright/test").Page) {
    await page.evaluate(() => {
      const target = window as RemoteTerminalWindow;
      const textarea = target.__remoteTerm?.textarea;
      const composer = document.getElementById("composerInput");
      const counts = { helperFocus: 0, composerBlur: 0 };
      target.__focusSteals = counts;
      if (textarea) {
        const original = textarea.focus.bind(textarea);
        textarea.focus = function focus(options?: FocusOptions) {
          counts.helperFocus += 1;
          return original(options);
        };
      }
      composer?.addEventListener("blur", () => {
        counts.composerBlur += 1;
      });
    });
  }

  async function longPressBravoCell(
    context: BrowserContext,
    page: import("@playwright/test").Page,
  ) {
    await page.waitForTimeout(250);
    const screenBox = await page.locator(".xterm-screen").boundingBox();
    expect(screenBox).not.toBeNull();
    const geometry = await page.evaluate(() => {
      const term = (window as RemoteTerminalWindow).__remoteTerm;
      return { cols: term?.cols || 1, rows: term?.rows || 1 };
    });
    const cellWidth = screenBox!.width / geometry.cols;
    const cellHeight = screenBox!.height / geometry.rows;
    const x = screenBox!.x + ("Words: alpha ".length + 2.5) * cellWidth;
    const y = screenBox!.y + 7.5 * cellHeight;
    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y }],
    });
    await page.waitForTimeout(550);
    return { cdp, screenBox: screenBox!, cellWidth, x, y };
  }

  test("long press selection keeps composer focus and does not scroll", async ({
    context,
    page,
  }) => {
    await connectRemoteWithWords(context, page, "composer");

    const composer = page.locator("#composerInput");
    await expect(composer).toBeVisible();
    await composer.focus();
    await expect(composer).toBeFocused();
    await installFocusStealCounters(page);

    const beforeBox = await page.locator(".xterm-screen").boundingBox();
    const { cdp, screenBox, cellWidth, y } = await longPressBravoCell(context, page);

    await expect
      .poll(() =>
        page.evaluate(() => (window as RemoteTerminalWindow).__remoteTerm?.getSelection() || ""),
      )
      .toBe("bravo");
    await expect(composer).toBeFocused();
    expect(await page.evaluate(() => (window as RemoteTerminalWindow).__focusSteals)).toEqual({
      helperFocus: 0,
      composerBlur: 0,
    });
    const afterSeedBox = await page.locator(".xterm-screen").boundingBox();
    expect(afterSeedBox).toEqual(beforeBox);

    const dragX = screenBox.x + 21.1 * cellWidth;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: dragX, y }],
    });

    await expect
      .poll(() =>
        page.evaluate(() => (window as RemoteTerminalWindow).__remoteTerm?.getSelection() || ""),
      )
      .toBe("bravo om");
    await expect(composer).toBeFocused();
    expect(await page.evaluate(() => (window as RemoteTerminalWindow).__focusSteals)).toEqual({
      helperFocus: 0,
      composerBlur: 0,
    });

    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  });

  test("long press selection does not raise composer or helper focus", async ({
    context,
    page,
  }) => {
    await connectRemoteWithWords(context, page, "composer");
    await expect(page.locator("#composerInput")).not.toBeFocused();
    await installFocusStealCounters(page);

    const { cdp } = await longPressBravoCell(context, page);
    await expect
      .poll(() =>
        page.evaluate(() => (window as RemoteTerminalWindow).__remoteTerm?.getSelection() || ""),
      )
      .toBe("bravo");
    await expect(page.locator("#composerInput")).not.toBeFocused();
    expect(await page.evaluate(() => (window as RemoteTerminalWindow).__focusSteals)).toEqual({
      helperFocus: 0,
      composerBlur: 0,
    });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  });

  test("long press selection keeps direct helper textarea focus", async ({ context, page }) => {
    await connectRemoteWithWords(context, page, "direct");
    const helper = page.locator(".xterm-helper-textarea");
    await helper.focus();
    await expect(helper).toBeFocused();
    await installFocusStealCounters(page);

    const { cdp } = await longPressBravoCell(context, page);
    await expect
      .poll(() =>
        page.evaluate(() => (window as RemoteTerminalWindow).__remoteTerm?.getSelection() || ""),
      )
      .toBe("bravo");
    await expect(helper).toBeFocused();
    expect(
      await page.evaluate(() => (window as RemoteTerminalWindow).__focusSteals?.helperFocus),
    ).toBe(0);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  });
});
