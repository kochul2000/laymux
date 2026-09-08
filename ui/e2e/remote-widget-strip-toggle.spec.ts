import { expect, test, type Page } from "@playwright/test";
import { installRemoteClientRoutes } from "./remote-client-assets";

/**
 * ADR-0132: the strip has two gates. The host owns `settings.remote.widgets`
 * for every client at once; this browser owns whether it spends a chrome row
 * on the mirror. Turning the device gate off must take the row back (the
 * ADR-0129 rebase path, same as the desktop emptying the strip), stop the poll
 * entirely, and be remembered on the next visit — a preference that resets on
 * reload is not a preference.
 */

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
      appearance: {},
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
  items: [
    {
      kind: "usage",
      align: "left",
      label: "Claude",
      display: "both",
      barWidth: 26,
      barHeight: 4,
      rows: [{ text: "5h 42%", percent: 42, elapsed: 60 }],
    },
    { kind: "text", align: "right", text: "C:\\work", copyText: "C:\\work" },
  ],
};

function outputFrames(text: string, seqStart: number, geometry: { cols: number; rows: number }) {
  const payload = Buffer.from(text, "utf8");
  const seqEnd = seqStart + payload.byteLength;
  const header = JSON.stringify({
    type: "terminal.output",
    version: 1,
    phase: "snapshot",
    seqStart,
    seqEnd,
    byteLength: payload.byteLength,
    state: {
      version: 1,
      generation: 1,
      snapshotStartSeq: seqStart,
      snapshotSeq: seqEnd,
      sourceStartSeq: seqStart,
      sourceSeq: seqEnd,
      snapshotKind: "raw",
      protocolRevision: 0,
      modes: { bracketedPaste: false },
      geometry: { revision: 0, ...geometry },
    },
  });
  return { header, payload };
}

interface Harness {
  resizeCalls: { cols: number; rows: number }[];
  /** Every `/remote/v1/widgets` hit, so a stopped poll is provable. */
  widgetRequests: number;
}

async function installRemoteMocks(page: Page, harness: Harness) {
  await installRemoteClientRoutes(page);
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
      harness.widgetRequests += 1;
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
    const lines = Array.from(
      { length: 30 },
      (_, index) => `line-${String(index + 1).padStart(4, "0")}\r\n`,
    ).join("");
    const last = harness.resizeCalls[harness.resizeCalls.length - 1];
    const snapshot = outputFrames(lines, 0, { cols: last?.cols ?? 80, rows: last?.rows ?? 24 });
    socket.send(snapshot.header);
    socket.send(snapshot.payload);
  });
}

type TermWindow = typeof window & {
  Terminal: { prototype: { reset: () => void } };
  __remoteTerm?: { cols: number; rows: number };
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
  // A revisit with a remembered token reconnects on its own and hides the
  // connect button, so only a first visit has anything to click.
  if (await page.locator("#connect").isVisible()) await page.locator("#connect").click();
  await expect(page.locator("#status")).toHaveText("Main · Pane 1");
}

async function surfaceState(page: Page) {
  return page.evaluate(() => {
    const term = (window as TermWindow).__remoteTerm;
    const host = document.getElementById("terminal");
    const sizer = document.getElementById("terminalSizer");
    return {
      cols: term?.cols ?? 0,
      rows: term?.rows ?? 0,
      hostHeight: Math.round(host?.getBoundingClientRect().height ?? 0),
      sizerHeight: Math.round(sizer?.getBoundingClientRect().height ?? 0),
    };
  });
}

// fitTerminal schedules via rAF + a 160ms retry and queueResize debounces 120ms.
const RESIZE_SETTLE_MS = 800;
// Longer than WIDGET_POLL_MS (5s), so "no request arrived" means the chain is
// really down rather than between ticks.
const POLL_QUIET_MS = 7000;

/**
 * Reach the drawer's Display section, from whatever state the previous step
 * left: the drawer opens on the workspace view and the settings entry only
 * exists there, but a drawer already parked on Settings must be left alone —
 * its entry button is hidden, so clicking through again would close it.
 */
async function openDrawerSettings(page: Page) {
  if (await page.locator("#widgetStripToggle").isVisible()) return;
  const navigationToggle = page.locator("#navToggle");
  const settings = page.locator("#drawerSettingsButton");
  // A closed drawer remains in the DOM, so its settings button can satisfy
  // `isVisible()` even while CSS has translated it outside the viewport.
  if ((await navigationToggle.getAttribute("aria-expanded")) !== "true") {
    await navigationToggle.click();
  }
  await settings.click();
  // Settings is paginated; the widget bar toggle lives on the Display tab.
  await page.locator('#settingsTabs [data-settings-panel="display"]').click();
}

test("the drawer toggle takes the widget bar down and gives the rows back", async ({ page }) => {
  const harness: Harness = { resizeCalls: [], widgetRequests: 0 };
  await installRemoteMocks(page, harness);
  await page.setViewportSize({ width: 420, height: 860 });
  await connectRemote(page);

  await expect(page.locator("#widgetStrip")).toBeVisible();
  await page.waitForTimeout(RESIZE_SETTLE_MS);
  const withStrip = await surfaceState(page);

  await openDrawerSettings(page);
  const toggle = page.locator("#widgetStripToggle");
  await expect(toggle).toBeChecked();
  await toggle.uncheck();

  await expect(page.locator("#widgetStrip")).toBeHidden();
  await page.waitForTimeout(RESIZE_SETTLE_MS);
  const withoutStrip = await surfaceState(page);

  // Same rebase the desktop emptying the strip takes (ADR-0129): the surface
  // owns the taller host again, so the rows come back.
  expect(withoutStrip.sizerHeight).toBe(withoutStrip.hostHeight);
  expect(withoutStrip.rows).toBeGreaterThan(withStrip.rows);
  expect(withoutStrip.cols).toBe(withStrip.cols);

  // Nothing is drawing the values, so nothing should be asking for them.
  const requestsWhenOff = harness.widgetRequests;
  await page.waitForTimeout(POLL_QUIET_MS);
  expect(harness.widgetRequests).toBe(requestsWhenOff);

  // Turning it back on restores the mirror without a reconnect.
  await page.locator("#widgetStripToggle").check();
  await expect(page.locator("#widgetStrip")).toBeVisible();
  expect(harness.widgetRequests).toBeGreaterThan(requestsWhenOff);
});

test("a browser that turned the widget bar off stays off across reloads", async ({ page }) => {
  const harness: Harness = { resizeCalls: [], widgetRequests: 0 };
  await installRemoteMocks(page, harness);
  await page.setViewportSize({ width: 420, height: 860 });
  await connectRemote(page);

  await expect(page.locator("#widgetStrip")).toBeVisible();
  await openDrawerSettings(page);
  await page.locator("#widgetStripToggle").uncheck();
  await expect(page.locator("#widgetStrip")).toBeHidden();

  harness.resizeCalls.length = 0;
  await connectRemote(page);

  // The device gate is remembered, so the strip never appears — not even for
  // the first poll — and the reconnected session asks for nothing.
  const requestsAfterReload = harness.widgetRequests;
  await openDrawerSettings(page);
  await expect(page.locator("#widgetStripToggle")).not.toBeChecked();
  await expect(page.locator("#widgetStrip")).toBeHidden();
  await page.waitForTimeout(POLL_QUIET_MS);
  expect(harness.widgetRequests).toBe(requestsAfterReload);
});
