import { expect, test, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { installRemoteClientRoutes } from "./remote-client-assets";

/**
 * ADR-0133: one PTY geometry per attach. The two surfaces that move the grid
 * after attach — the served desktop font (cell width → cols, ADR-0077) and the
 * widget strip (a chrome row → rows, ADR-0124/0129) — both arrive over the
 * network, so an attach that fits immediately used to send two or three
 * SIGWINCH-worth of geometry within a second. A frame-repainting TUI erases only
 * the rows it counted at the previous width, so each extra width change strands
 * the wrapped remainder of its old frame on screen.
 */

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

const appearance = {
  fontFamily: SERVER_FONT_STACK,
  fontSize: 14,
  cursorStyle: "bar",
  cursorWidth: 1,
  theme: {},
  fontAssets: {
    family: FONT_FAMILY,
    faces: [{ url: FONT_URL, weight: 400, style: "normal" }],
  },
};

const navigation = {
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

const widgets = {
  enabled: true,
  fontSize: 9,
  fontFamily: "",
  items: [{ kind: "text", align: "right", text: "C:\\work" }],
};

interface ResizeCall {
  cols: number;
  rows: number;
}

interface Harness {
  resizeCalls: ResizeCall[];
  /** Relay latency for the font body: it must land after a naive attach fit. */
  fontDelayMs: number;
  /** Relay latency for the widget strip, same reason. */
  widgetDelayMs: number;
  /** Never answer the font request, to prove the wait is bounded. */
  hangFont?: boolean;
}

function snapshotFrames(text: string, geometry: { cols: number; rows: number }) {
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
      geometry: { revision: 0, ...geometry },
    },
  });
  return { header, payload };
}

async function installRemoteMocks(page: Page, harness: Harness) {
  await installRemoteClientRoutes(page);

  await page.route("http://remote.test/remote/font/**", async (route) => {
    if (harness.hangFont) {
      await new Promise((resolve) => setTimeout(resolve, 30000));
      await route.abort();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, harness.fontDelayMs));
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
      await route.fulfill({ json: navigation });
      return;
    }
    if (url.pathname === "/remote/v1/widgets") {
      await new Promise((resolve) => setTimeout(resolve, harness.widgetDelayMs));
      await route.fulfill({ json: widgets });
      return;
    }
    if (url.pathname === "/remote/v1/terminals/terminal-1/resize") {
      const body = route.request().postDataJSON() as { cols: number; rows: number };
      harness.resizeCalls.push({ cols: body.cols, rows: body.rows });
      await route.fulfill({ json: {} });
      return;
    }
    await route.fulfill({ json: {} });
  });

  await page.routeWebSocket(/\/remote\/v1\/terminals\/terminal-1\/output/, (socket) => {
    const last = harness.resizeCalls[harness.resizeCalls.length - 1];
    const snapshot = snapshotFrames("ready\r\n", {
      cols: last?.cols ?? 80,
      rows: last?.rows ?? 24,
    });
    socket.send(snapshot.header);
    socket.send(snapshot.payload);
  });
}

type TermWindow = typeof window & {
  Terminal: { prototype: { reset: () => void } };
  __remoteTerm?: { cols: number; rows: number; options: { fontFamily: string } };
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
  await expect(page.locator("#status")).toHaveText("Main · Pane 1", { timeout: 15000 });
}

function terminalState(page: Page) {
  return page.evaluate(() => {
    const term = (window as TermWindow).__remoteTerm;
    return {
      cols: term?.cols ?? 0,
      rows: term?.rows ?? 0,
      fontFamily: term?.options.fontFamily ?? "",
    };
  });
}

// fitTerminal schedules via rAF + a 160ms retry and queueResize debounces 120ms,
// so a quiet period longer than both proves nothing else was queued behind it.
const RESIZE_SETTLE_MS = 800;

test.describe("remote attach geometry", () => {
  test.skip(!fontPath, "no system font file available to serve");

  test("sends one geometry for an attach the font and the strip both land late", async ({
    page,
  }) => {
    const harness: Harness = { resizeCalls: [], fontDelayMs: 300, widgetDelayMs: 200 };
    await installRemoteMocks(page, harness);
    await page.setViewportSize({ width: 420, height: 860 });
    await connectRemote(page);

    // Both late surfaces are up before the attach measured, so neither can move
    // the grid afterwards.
    await expect(page.locator("#widgetStrip")).toBeVisible();
    const state = await terminalState(page);
    expect(state.fontFamily).toBe(`'${FONT_FAMILY}', ${SERVER_FONT_STACK}`);

    await page.waitForTimeout(RESIZE_SETTLE_MS);

    expect(harness.resizeCalls).toEqual([{ cols: state.cols, rows: state.rows }]);
    expect(await terminalState(page)).toMatchObject({ cols: state.cols, rows: state.rows });
  });

  test("attaches anyway when the font never arrives", async ({ page }) => {
    const harness: Harness = {
      resizeCalls: [],
      fontDelayMs: 0,
      widgetDelayMs: 0,
      hangFont: true,
    };
    await installRemoteMocks(page, harness);
    await page.setViewportSize({ width: 420, height: 860 });
    // A hung font must cost the bounded wait, not the session: connectRemote
    // only resolves once the output socket is attached.
    await connectRemote(page);

    await page.waitForTimeout(RESIZE_SETTLE_MS);
    const state = await terminalState(page);
    expect(state.fontFamily).toBe(SERVER_FONT_STACK);
    expect(harness.resizeCalls).toEqual([{ cols: state.cols, rows: state.rows }]);
  });
});
