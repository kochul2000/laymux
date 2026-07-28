import { expect, test, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const remoteRoot = fileURLToPath(new URL("../../src-tauri/src/remote_server/", import.meta.url));

/**
 * ADR-0077: the desktop serves its own terminal font and the remote page must
 * only trust the family alias once the faces really loaded. A real font file is
 * required — a stub body would never satisfy `document.fonts.check`.
 */
// Single-face files only: `.ttc` collections are what the desktop refuses to
// serve and what the browser cannot load, so one here would test a shape
// production never emits.
const FONT_CANDIDATES = [
  "C:\\Windows\\Fonts\\consola.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
  "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
];
const fontPath = FONT_CANDIDATES.find((candidate) => existsSync(candidate));

const FONT_TOKEN = "0123456789abcdef";
const FONT_FAMILY = "LxRemoteFont-0123456789ab";
const FONT_URL = `/remote/font/${FONT_TOKEN}.ttf`;
const SERVER_FONT_STACK = "'Consolas', 'Cascadia Mono', 'Consolas', monospace";

function navigationWith(appearance: Record<string, unknown>) {
  return {
    activeWorkspace: {
      id: "ws-1",
      name: "Main",
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
        panes: [],
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
        appearance,
      },
    ],
    workspaceSelector: { display: {}, pathEllipsis: "start" },
    notifications: [],
    unreadNotificationCount: 0,
  };
}

interface FontHarness {
  appearance: Record<string, unknown>;
  /** Delay before the font body is returned, to exercise the late-arrival path. */
  fontDelayMs?: number;
  /** Number of leading font requests answered with 404, as a restarted desktop would. */
  failFirstFontRequests?: number;
  fontRequests: string[];
}

async function installRemoteMocks(page: Page, harness: FontHarness) {
  await page.route("http://remote.test/remote/", (route) =>
    route.fulfill({ path: `${remoteRoot}page.html`, contentType: "text/html; charset=utf-8" }),
  );
  for (const [asset, contentType] of [
    ["xterm.js", "application/javascript; charset=utf-8"],
    ["addon-fit.js", "application/javascript; charset=utf-8"],
    ["xterm.css", "text/css; charset=utf-8"],
  ] as const) {
    await page.route(`http://remote.test/remote/vendor/${asset}`, (route) =>
      route.fulfill({ path: `${remoteRoot}assets/${asset}`, contentType }),
    );
  }

  await page.route("http://remote.test/remote/font/**", async (route) => {
    harness.fontRequests.push(new URL(route.request().url()).pathname);
    if (harness.fontRequests.length <= (harness.failFirstFontRequests ?? 0)) {
      await route.fulfill({ status: 404, body: "" });
      return;
    }
    if (harness.fontDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, harness.fontDelayMs));
    }
    await route.fulfill({
      body: readFileSync(fontPath as string),
      contentType: "font/ttf",
      headers: { "cache-control": "public, max-age=31536000, immutable" },
    });
  });

  await page.route("http://remote.test/remote/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/remote/v1/session/claim") {
      await route.fulfill({
        json: { active: true, leaseId: "lease-1", heartbeatTimeoutSeconds: 45 },
      });
      return;
    }
    if (url.pathname === "/remote/v1/session/heartbeat") {
      await route.fulfill({ json: { active: true, leaseId: "lease-1" } });
      return;
    }
    if (url.pathname === "/remote/v1/navigation") {
      await route.fulfill({ json: navigationWith(harness.appearance) });
      return;
    }
    await route.fulfill({ json: {} });
  });

  await page.routeWebSocket(/\/remote\/v1\/terminals\/terminal-1\/output/, (socket) => {
    // A snapshot is what drives the page through terminal reset, which is also
    // how this spec gets hold of the xterm instance.
    const snapshot = snapshotFrames("ready\r\n");
    socket.send(snapshot.header);
    socket.send(snapshot.payload);
  });
}

function snapshotFrames(text: string) {
  const payload = Buffer.from(text, "utf8");
  const header = JSON.stringify({
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
  });
  return { header, payload };
}

type TermWindow = typeof window & {
  Terminal: { prototype: { reset: () => void } };
  __remoteTerm?: { options: { fontFamily: string } };
};

async function connectRemote(page: Page) {
  await page.goto("http://remote.test/remote/#token=test-token");
  await page.evaluate(() => {
    const target = window as TermWindow;
    const originalReset = target.Terminal.prototype.reset;
    target.Terminal.prototype.reset = function resetCapturingInstance() {
      (window as TermWindow).__remoteTerm = this as never;
      return originalReset.call(this);
    };
  });
  await page.locator("#connect").click();
  await expect(page.locator("#status")).toHaveText("Main · Pane 1");
}

function terminalFontFamily(page: Page) {
  return page.evaluate(() => (window as TermWindow).__remoteTerm?.options.fontFamily ?? "");
}

const baseAppearance = {
  fontFamily: SERVER_FONT_STACK,
  fontSize: 14,
  cursorStyle: "bar",
  cursorWidth: 1,
  theme: {},
};

test.describe("remote terminal font", () => {
  test.skip(!fontPath, "no system font file available to serve");

  test("adopts the served desktop font only after the faces load", async ({ page }) => {
    const harness: FontHarness = {
      appearance: {
        ...baseAppearance,
        fontAssets: {
          family: FONT_FAMILY,
          faces: [{ url: FONT_URL, weight: 400, style: "normal" }],
        },
      },
      // Land the font after the terminal already exists, so the assertion also
      // covers the re-apply path rather than only the primed one.
      fontDelayMs: 400,
      fontRequests: [],
    };
    await installRemoteMocks(page, harness);
    await connectRemote(page);

    await expect
      .poll(() => terminalFontFamily(page), { timeout: 10000 })
      .toBe(`'${FONT_FAMILY}', ${SERVER_FONT_STACK}`);
    expect(harness.fontRequests).toContain(FONT_URL);

    // The alias is prepended, never a replacement: the desktop's own stack has
    // to stay behind it as the fallback chain.
    const fontFamily = await terminalFontFamily(page);
    expect(fontFamily.endsWith(SERVER_FONT_STACK)).toBe(true);
  });

  test("retries after a failed download instead of pinning the fallback font", async ({ page }) => {
    const harness: FontHarness = {
      appearance: {
        ...baseAppearance,
        fontAssets: {
          family: FONT_FAMILY,
          faces: [{ url: FONT_URL, weight: 400, style: "normal" }],
        },
      },
      // A desktop restarted between advertising the URL and being asked for the
      // bytes answers 404. One miss must not cost the whole session.
      failFirstFontRequests: 1,
      fontRequests: [],
    };
    await installRemoteMocks(page, harness);
    await connectRemote(page);

    await expect.poll(() => harness.fontRequests.length).toBeGreaterThanOrEqual(1);

    // Attach and navigation refresh both re-arm the attempt.
    await page.locator("#navToggle").click();
    await page.locator("#refresh").click();
    await expect
      .poll(() => terminalFontFamily(page), { timeout: 10000 })
      .toBe(`'${FONT_FAMILY}', ${SERVER_FONT_STACK}`);
    // The 404 was retried rather than being treated as final.
    expect(harness.fontRequests.length).toBeGreaterThanOrEqual(2);
  });

  test("gives up after the attempt cap instead of refetching forever", async ({ page }) => {
    const harness: FontHarness = {
      appearance: {
        ...baseAppearance,
        fontAssets: {
          family: FONT_FAMILY,
          faces: [{ url: FONT_URL, weight: 400, style: "normal" }],
        },
      },
      failFirstFontRequests: Number.MAX_SAFE_INTEGER,
      fontRequests: [],
    };
    await installRemoteMocks(page, harness);
    await connectRemote(page);

    await page.locator("#navToggle").click();
    for (let refresh = 0; refresh < 4; refresh += 1) {
      await page.locator("#refresh").click();
      await page.waitForTimeout(150);
    }

    expect(await terminalFontFamily(page)).toBe(SERVER_FONT_STACK);
    expect(harness.fontRequests.length).toBeLessThanOrEqual(3);
  });

  test("ignores faces whose weight or style is outside the contract", async ({ page }) => {
    const harness: FontHarness = {
      appearance: {
        ...baseAppearance,
        fontAssets: {
          family: FONT_FAMILY,
          faces: [
            { url: FONT_URL, weight: 500, style: "normal" },
            { url: FONT_URL, weight: 400, style: "oblique" },
          ],
        },
      },
      fontRequests: [],
    };
    await installRemoteMocks(page, harness);
    await connectRemote(page);

    expect(await terminalFontFamily(page)).toBe(SERVER_FONT_STACK);
    expect(harness.fontRequests).toHaveLength(0);
  });

  test("keeps the name-only stack when no font is advertised", async ({ page }) => {
    const harness: FontHarness = { appearance: baseAppearance, fontRequests: [] };
    await installRemoteMocks(page, harness);
    await connectRemote(page);

    expect(await terminalFontFamily(page)).toBe(SERVER_FONT_STACK);
    expect(harness.fontRequests).toHaveLength(0);
  });

  test("ignores font assets that do not match the advertised contract", async ({ page }) => {
    const harness: FontHarness = {
      appearance: {
        ...baseAppearance,
        fontAssets: {
          // Not the `LxRemoteFont-<12 hex>` alias, and the url escapes the route.
          family: 'Evil"; } body { display: none } @font-face { font-family: "x',
          faces: [{ url: "https://evil.example/font.ttf", weight: 400, style: "normal" }],
        },
      },
      fontRequests: [],
    };
    await installRemoteMocks(page, harness);
    await connectRemote(page);

    expect(await terminalFontFamily(page)).toBe(SERVER_FONT_STACK);
    expect(harness.fontRequests).toHaveLength(0);
  });
});
