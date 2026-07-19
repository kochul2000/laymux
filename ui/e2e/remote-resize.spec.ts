import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

const remoteRoot = fileURLToPath(new URL("../../src-tauri/src/remote_server/", import.meta.url));

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

interface ResizeCall {
  cols: number;
  rows: number;
}

function outputFrames(text: string, seqStart: number, phase: "snapshot" | "delta") {
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
            snapshotStartSeq: seqStart,
            snapshotSeq: seqEnd,
            protocolRevision: 0,
            modes: { bracketedPaste: false },
          },
        }
      : {}),
  });
  return { header, payload, seqEnd };
}

interface RemoteHarness {
  resizeCalls: ResizeCall[];
  lineCount?: number;
  sendDelta?: (text: string) => void;
}

async function installRemoteMocks(page: Page, options: RemoteHarness) {
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
    if (url.pathname === "/remote/v1/terminals/terminal-1/resize") {
      const body = route.request().postDataJSON() as { cols: number; rows: number };
      options.resizeCalls.push({ cols: body.cols, rows: body.rows });
      await route.fulfill({ json: {} });
      return;
    }
    await route.fulfill({ json: {} });
  });

  await page.routeWebSocket(/\/remote\/v1\/terminals\/terminal-1\/output/, (socket) => {
    const lines = Array.from(
      { length: options.lineCount ?? 30 },
      (_, index) => `line-${String(index + 1).padStart(4, "0")}\r\n`,
    ).join("");
    const snapshot = outputFrames(lines, 0, "snapshot");
    socket.send(snapshot.header);
    socket.send(snapshot.payload);
    let seq = snapshot.seqEnd;
    options.sendDelta = (text) => {
      const delta = outputFrames(text, seq, "delta");
      seq = delta.seqEnd;
      socket.send(delta.header);
      socket.send(delta.payload);
    };
  });
}

type TermWindow = typeof window & {
  Terminal: { prototype: { reset: () => void } };
  __remoteTerm?: {
    cols: number;
    rows: number;
    buffer: { active: { type: string } };
  };
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

async function terminalGeometry(page: Page) {
  return page.evaluate(() => {
    const term = (window as TermWindow).__remoteTerm;
    if (!term) return null;
    return { cols: term.cols, rows: term.rows, bufferType: term.buffer.active.type };
  });
}

// fitTerminal schedules via rAF + a 160ms retry and queueResize debounces
// 120ms, so a quiet period longer than both proves no resize was sent.
const RESIZE_SETTLE_MS = 800;

test("a height-only shrink keeps PTY geometry and crops the surface", async ({ page }) => {
  const resizeCalls: ResizeCall[] = [];
  await installRemoteMocks(page, { resizeCalls });
  await page.setViewportSize({ width: 800, height: 900 });
  await connectRemote(page);

  await expect.poll(() => resizeCalls.length).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(RESIZE_SETTLE_MS);
  const baselineCalls = resizeCalls.length;
  const baseline = await terminalGeometry(page);
  expect(baseline).not.toBeNull();

  // Soft keyboard / composer growth: the visual viewport loses height only.
  await page.setViewportSize({ width: 800, height: 500 });
  await page.waitForTimeout(RESIZE_SETTLE_MS);

  expect(resizeCalls.length).toBe(baselineCalls);
  const cropped = await terminalGeometry(page);
  expect(cropped).toEqual(baseline);

  // The sizer must keep its fitted height and overflow the shrunken host.
  const heights = await page.evaluate(() => ({
    host: document.getElementById("terminal")?.clientHeight ?? 0,
    sizer: document.getElementById("terminalSizer")?.clientHeight ?? 0,
  }));
  expect(heights.sizer).toBeGreaterThan(heights.host);

  // A width change is a real geometry change and must refit + resize.
  await page.setViewportSize({ width: 500, height: 500 });
  await expect.poll(() => resizeCalls.length).toBe(baselineCalls + 1);
  const refitted = resizeCalls[resizeCalls.length - 1];
  expect(refitted.cols).toBeLessThan(baseline!.cols);
  expect(refitted.rows).toBeLessThan(baseline!.rows);
});

test("entering the alternate buffer during a crop refits immediately", async ({ page }) => {
  const harness: RemoteHarness = { resizeCalls: [] };
  await installRemoteMocks(page, harness);
  await page.setViewportSize({ width: 800, height: 900 });
  await connectRemote(page);

  await expect.poll(() => harness.resizeCalls.length).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(RESIZE_SETTLE_MS);
  const baselineCalls = harness.resizeCalls.length;
  const baseline = await terminalGeometry(page);

  // Crop first: the height-only shrink must not resize the normal buffer.
  await page.setViewportSize({ width: 800, height: 500 });
  await page.waitForTimeout(RESIZE_SETTLE_MS);
  expect(harness.resizeCalls.length).toBe(baselineCalls);

  // A full-screen app enters the alternate buffer: the crop must yield and
  // the real (shrunken) surface geometry must reach the PTY right away.
  harness.sendDelta!("\x1b[?1049h");
  await expect.poll(async () => (await terminalGeometry(page))?.bufferType).toBe("alternate");
  await expect.poll(() => harness.resizeCalls.length).toBe(baselineCalls + 1);
  const refitted = harness.resizeCalls[harness.resizeCalls.length - 1];
  expect(refitted.cols).toBe(baseline!.cols);
  expect(refitted.rows).toBeLessThan(baseline!.rows);

  // Leaving the alternate buffer at the same host size needs no further
  // resize: the adopted geometry already matches.
  harness.sendDelta!("\x1b[?1049l");
  await expect.poll(async () => (await terminalGeometry(page))?.bufferType).toBe("normal");
  await page.waitForTimeout(RESIZE_SETTLE_MS);
  expect(harness.resizeCalls.length).toBe(baselineCalls + 1);
});

test("a crop shifts the sizer down to keep a top-row cursor visible", async ({ page }) => {
  const harness: RemoteHarness = { resizeCalls: [], lineCount: 3 };
  await installRemoteMocks(page, harness);
  await page.setViewportSize({ width: 800, height: 900 });
  await connectRemote(page);

  await expect.poll(() => harness.resizeCalls.length).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(RESIZE_SETTLE_MS);

  // With only 3 lines the cursor sits near the top row; a bottom-anchored
  // crop alone would hide it together with the IME helper textarea.
  await page.setViewportSize({ width: 800, height: 400 });
  await page.waitForTimeout(RESIZE_SETTLE_MS);

  const transform = await page.evaluate(
    () => document.getElementById("terminalSizer")?.style.transform ?? "",
  );
  expect(transform).toMatch(/translateY\(\d+px\)/);

  // Growing back to the fitted height clears both the crop and the shift.
  await page.setViewportSize({ width: 800, height: 900 });
  await page.waitForTimeout(RESIZE_SETTLE_MS);
  const cleared = await page.evaluate(
    () => document.getElementById("terminalSizer")?.style.transform ?? "",
  );
  expect(cleared).toBe("");
});
