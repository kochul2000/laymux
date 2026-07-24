import { expect, test, type BrowserContext } from "@playwright/test";
import { fileURLToPath } from "node:url";

const remoteRoot = fileURLToPath(new URL("../../src-tauri/src/remote_server/", import.meta.url));

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
        snapshotStartSeq: 0,
        snapshotSeq: payload.byteLength,
        protocolRevision: 0,
        modes: { bracketedPaste: false },
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
    if (url.pathname === "/remote/") {
      return route.fulfill({
        path: `${remoteRoot}page.html`,
        contentType: "text/html; charset=utf-8",
      });
    }
    if (url.pathname === "/remote/vendor/xterm.js") {
      return route.fulfill({
        path: `${remoteRoot}assets/xterm.js`,
        contentType: "application/javascript; charset=utf-8",
      });
    }
    if (url.pathname === "/remote/vendor/addon-fit.js") {
      return route.fulfill({
        path: `${remoteRoot}assets/addon-fit.js`,
        contentType: "application/javascript; charset=utf-8",
      });
    }
    if (url.pathname === "/remote/vendor/addon-web-links.js") {
      return route.fulfill({
        path: `${remoteRoot}assets/addon-web-links.js`,
        contentType: "application/javascript; charset=utf-8",
      });
    }
    if (url.pathname === "/remote/vendor/xterm.css") {
      return route.fulfill({
        path: `${remoteRoot}assets/xterm.css`,
        contentType: "text/css; charset=utf-8",
      });
    }
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
      active: { getLine: (line: number) => { translateToString: () => string } | undefined };
    };
    cols: number;
    rows: number;
  };
};

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
});
