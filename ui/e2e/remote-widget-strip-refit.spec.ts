import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

const remoteRoot = fileURLToPath(new URL("../../src-tauri/src/remote_server/", import.meta.url));

/**
 * ADR-0129: the widget strip is chrome, not an input surface. It appears once,
 * asynchronously, after the attach fit has already recorded the taller host, so
 * the height-shrink crop (ADR-0038) must not claim it — otherwise the fitted
 * baseline stays stale for the rest of the session and every later refit (font
 * load, buffer switch) is suppressed, leaving the surface at the geometry that
 * was measured before the strip existed.
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

const emptyWidgets = { enabled: true, fontSize: 9, fontFamily: "", items: [] };

function outputFrames(
  text: string,
  seqStart: number,
  phase: "snapshot" | "delta",
  geometry: { cols: number; rows: number },
) {
  const payload = Buffer.from(text, "utf8");
  const seqEnd = seqStart + payload.byteLength;
  const header = JSON.stringify({
    type: "terminal.output",
    version: 1,
    phase,
    seqStart,
    seqEnd,
    byteLength: payload.byteLength,
    ...(phase === "snapshot"
      ? {
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
        }
      : {}),
  });
  return { header, payload, seqEnd };
}

interface ResizeCall {
  cols: number;
  rows: number;
}

interface Harness {
  resizeCalls: ResizeCall[];
  /** Flipped by the test to take the strip back down on a later poll. */
  stripEnabled: boolean;
}

async function installRemoteMocks(page: Page, harness: Harness) {
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
      // The regression only shows when the strip lands *after* the attach fit
      // recorded the strip-less host height, which is the production ordering:
      // the poll starts at connect and the bridge answers over the network.
      while (harness.stripEnabled && harness.resizeCalls.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await route.fulfill({ json: harness.stripEnabled ? widgets : emptyWidgets });
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
    // The host reports the geometry the client established before attaching.
    const last = harness.resizeCalls[harness.resizeCalls.length - 1];
    const snapshot = outputFrames(lines, 0, "snapshot", {
      cols: last?.cols ?? 80,
      rows: last?.rows ?? 24,
    });
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
  await page.locator("#connect").click();
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

test("the widget strip appearing refits instead of cropping the surface", async ({ page }) => {
  const harness: Harness = { resizeCalls: [], stripEnabled: true };
  await installRemoteMocks(page, harness);
  await page.setViewportSize({ width: 420, height: 860 });
  await connectRemote(page);

  await expect(page.locator("#widgetStrip")).toBeVisible();
  await page.waitForTimeout(RESIZE_SETTLE_MS);

  const attached = harness.resizeCalls[0];
  const state = await surfaceState(page);

  // The strip took height for good, so the surface must own the shorter host:
  // a stale fitted baseline would pin the sizer above it and freeze the rows.
  expect(state.sizerHeight).toBe(state.hostHeight);
  expect(state.rows).toBeLessThan(attached.rows);
  // Width never changed, so the column count must not move either.
  expect(state.cols).toBe(attached.cols);

  const refitted = harness.resizeCalls[harness.resizeCalls.length - 1];
  expect(refitted.cols).toBe(attached.cols);
  expect(refitted.rows).toBe(state.rows);
});

test("the widget strip going away gives the rows back", async ({ page }) => {
  const harness: Harness = { resizeCalls: [], stripEnabled: true };
  await installRemoteMocks(page, harness);
  await page.setViewportSize({ width: 420, height: 860 });
  await connectRemote(page);

  await expect(page.locator("#widgetStrip")).toBeVisible();
  await page.waitForTimeout(RESIZE_SETTLE_MS);
  const withStrip = await surfaceState(page);

  // Turning the desktop's widgets off empties the strip on the next poll.
  harness.stripEnabled = false;
  await expect(page.locator("#widgetStrip")).toBeHidden({ timeout: 15000 });
  await page.waitForTimeout(RESIZE_SETTLE_MS);

  const withoutStrip = await surfaceState(page);
  expect(withoutStrip.sizerHeight).toBe(withoutStrip.hostHeight);
  expect(withoutStrip.rows).toBeGreaterThan(withStrip.rows);
  expect(withoutStrip.cols).toBe(withStrip.cols);
});
