import { expect, test, type Page, type BrowserContext, type Route } from "@playwright/test";
import { fulfillRemoteClientAsset } from "./remote-client-assets";

/**
 * ADR-0188: Remote discovers paths without a drag — a tap/click on plain text
 * (`point`) and a scan of the visible screen once output stops (`screen`).
 * These exercise the shipped page JS, not the shared parser (unit-tested in
 * `remote-file-viewer.test.ts`).
 */

const TOKEN = "src/main.rs";
const HOST_PATH = "C:\\work\\src\\main.rs";
const OUTPUT_LINE = `cat ${TOKEN}`;

const pane = {
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
};

const navigation = {
  activeWorkspace: { id: "ws-1", name: "Main", focusedPaneNumber: 1, panes: [pane] },
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
      panes: [pane],
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

type PathLinkRequest = {
  mode: unknown;
  lines: string[];
  caret?: { lineIndex: number; index: number };
};

type CapturedTerminalWindow = typeof window & {
  Terminal: { prototype: { reset: () => void } };
  __remoteTerm?: { cols: number; rows: number };
};

type RemoteHarness = {
  requests: PathLinkRequest[];
  renderRequests: Array<Record<string, unknown>>;
  answeredModes: Set<string>;
  /** Push a delta frame so the page takes its real write path. */
  sendDelta: (text: string) => void;
};

/**
 * Answers `path-link` the way the desktop bridge does for this fixture: look for
 * the token in exactly the lines the page sent, so a wrong caret, a wrong line
 * or a stale screen produces no match instead of a lucky one.
 */
function matchesFor(body: PathLinkRequest): Array<Record<string, unknown>> {
  const matches: Array<Record<string, unknown>> = [];
  body.lines.forEach((line, lineIndex) => {
    const startIndex = line.indexOf(TOKEN);
    if (startIndex < 0) return;
    if (body.mode === "point") {
      const caret = body.caret;
      if (!caret || caret.lineIndex !== lineIndex) return;
      if (caret.index < startIndex || caret.index >= startIndex + TOKEN.length) return;
    }
    matches.push({
      token: TOKEN,
      path: HOST_PATH,
      lineIndex,
      startIndex,
      endIndex: startIndex + TOKEN.length,
    });
  });
  return matches;
}

async function connectRemote(
  context: BrowserContext,
  page: Page,
  answerModes: string[],
): Promise<RemoteHarness> {
  let liveSocket: { send: (data: string | Buffer) => void } | null = null;
  let deltaSeq = Buffer.byteLength(
    `${OUTPUT_LINE}
`,
    "utf8",
  );
  const harness: RemoteHarness = {
    requests: [],
    renderRequests: [],
    answeredModes: new Set(),
    sendDelta: (text: string) => {
      const payload = Buffer.from(text, "utf8");
      const header = JSON.stringify({
        type: "terminal.output",
        version: 1,
        phase: "delta",
        seqStart: deltaSeq,
        seqEnd: deltaSeq + payload.byteLength,
        byteLength: payload.byteLength,
      });
      deltaSeq += payload.byteLength;
      liveSocket?.send(header);
      liveSocket?.send(payload);
    },
  };

  await context.route("http://remote.test/remote/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (await fulfillRemoteClientAsset(route, url.pathname)) return;
    if (url.pathname === "/remote/v1/session/claim") {
      return route.fulfill({
        json: {
          active: true,
          leaseId: "lease-triggers",
          resumeToken: "resume-triggers",
          fileViewerToken: "viewer-triggers",
          heartbeatTimeoutSeconds: 45,
        },
      });
    }
    if (url.pathname === "/remote/v1/session/heartbeat") {
      return route.fulfill({ json: { active: true, leaseId: "lease-triggers" } });
    }
    if (url.pathname === "/remote/v1/session/release") {
      return route.fulfill({ json: { ok: true } });
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
    if (url.pathname === "/remote/v1/file-viewer/status") {
      return route.fulfill({ json: { open: false, path: null } });
    }
    if (url.pathname === "/remote/v1/file-viewer/path-link") {
      const body = JSON.parse(request.postData() || "{}") as PathLinkRequest;
      harness.requests.push(body);
      if (!answerModes.includes(String(body.mode))) {
        return route.fulfill({ json: { valid: false } });
      }
      harness.answeredModes.add(String(body.mode));
      const matches = matchesFor(body);
      return route.fulfill({
        json: matches.length > 0 ? { valid: true, matches } : { valid: false },
      });
    }
    if (url.pathname === "/remote/v1/file-viewer/render") {
      harness.renderRequests.push(
        JSON.parse(request.postData() || "{}") as Record<string, unknown>,
      );
      return route.fulfill({
        json: { path: HOST_PATH, kind: "text", content: "fn main() {}", truncated: false },
      });
    }
    return route.fulfill({ status: 404, json: { error: "not mocked" } });
  });

  await page.routeWebSocket(/\/remote\/v1\/terminals\/terminal-1\/output/, (socket) => {
    liveSocket = socket;
    const { header, payload } = snapshotFrames(`${OUTPUT_LINE}\r\n`);
    socket.send(header);
    socket.send(payload);
  });

  await page.goto("http://remote.test/remote/#token=remote-secret");
  // Capture the live xterm so cell geometry comes from the real terminal, not
  // from an assumed 80x24 (the page fits itself to the surface).
  await page.evaluate(() => {
    const target = window as CapturedTerminalWindow;
    const originalReset = target.Terminal.prototype.reset;
    target.Terminal.prototype.reset = function resetCapturingInstance() {
      (window as CapturedTerminalWindow).__remoteTerm = this as never;
      return originalReset.call(this);
    };
  });
  await page.locator("#connect").click();
  await expect(page.locator("#status")).toHaveText("Main · Pane 1");
  return harness;
}

/** Viewport-relative centre of a character cell, from the live xterm geometry. */
async function cellPoint(page: Page, column: number): Promise<{ x: number; y: number }> {
  const screen = page.locator(".xterm-screen");
  const box = await screen.boundingBox();
  expect(box).not.toBeNull();
  const geometry = await page.evaluate(() => {
    const term = (window as CapturedTerminalWindow).__remoteTerm;
    if (!term) throw new Error("xterm instance was not captured");
    return { cols: term.cols, rows: term.rows };
  });
  const cellWidth = box!.width / geometry.cols;
  const cellHeight = box!.height / geometry.rows;
  return { x: box!.x + cellWidth * (column + 0.5), y: box!.y + cellHeight * 0.5 };
}

test("underlines every path on the visible screen once output stops", async ({ context, page }) => {
  test.setTimeout(60_000);
  const harness = await connectRemote(context, page, ["screen"]);

  // No selection, no tap: the idle scan alone must produce the underline.
  const decoration = page.locator(".remote-path-link-decoration");
  await expect(decoration).toHaveCount(1, { timeout: 10_000 });
  await expect(page.locator("#terminal")).toHaveClass(/remote-path-link-clickable/);

  const screenRequests = harness.requests.filter((entry) => entry.mode === "screen");
  expect(screenRequests.length).toBeGreaterThan(0);
  const first = screenRequests[0];
  expect(first.lines[0]).toBe(OUTPUT_LINE);
  expect(first.lines.length).toBeLessThanOrEqual(64);
  expect(first.caret).toBeUndefined();

  // An unchanged screen must not re-run the batch, however long we wait.
  const settled = harness.requests.filter((entry) => entry.mode === "screen").length;
  await page.waitForTimeout(1_500);
  expect(harness.requests.filter((entry) => entry.mode === "screen").length).toBe(settled);

  // The underline opens the in-page viewer (ADR-0184).
  const box = await decoration.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await expect(page.locator("#fileViewerOverlay")).toBeVisible();
  await expect(page.locator("#fileViewerTitle")).toHaveText(HOST_PATH);
});

test.describe("mobile path-link focus ownership", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("opens an underlined file without focusing Composer behind the viewer", async ({
    context,
    page,
  }) => {
    test.setTimeout(60_000);
    await connectRemote(context, page, ["screen"]);

    const editor = page.locator("#composerInput");
    const decoration = page.locator(".remote-path-link-decoration");
    await expect(decoration).toBeVisible({ timeout: 10_000 });
    await expect(editor).not.toBeFocused();

    const box = await decoration.boundingBox();
    expect(box).not.toBeNull();
    await page.touchscreen.tap(box!.x + box!.width / 2, box!.y + box!.height / 2);

    await expect(page.locator("#fileViewerOverlay")).toBeVisible();
    await expect(page.locator("#fileViewerTitle")).toHaveText(HOST_PATH);
    await expect(editor).not.toBeFocused();
  });
});

test("a click on plain text validates that token only and does not open it", async ({
  context,
  page,
}) => {
  test.setTimeout(60_000);
  // Only `point` is answered, so any underline here came from the click.
  const harness = await connectRemote(context, page, ["point"]);

  // Attach schedules a second fit; wait past it so the cell geometry is stable.
  await page.waitForTimeout(300);
  const insideToken = await cellPoint(page, OUTPUT_LINE.indexOf(TOKEN) + 3);
  await page.mouse.click(insideToken.x, insideToken.y);

  const decoration = page.locator(".remote-path-link-decoration");
  await expect(decoration).toHaveCount(1, { timeout: 10_000 });
  // Discovery is not activation: the first click only underlines.
  await expect(page.locator("#fileViewerOverlay")).toBeHidden();
  expect(harness.renderRequests).toEqual([]);

  const pointRequests = harness.requests.filter((entry) => entry.mode === "point");
  expect(pointRequests).toHaveLength(1);
  expect(pointRequests[0].lines).toEqual([OUTPUT_LINE]);
  const caret = pointRequests[0].caret;
  expect(caret?.lineIndex).toBe(0);
  expect(caret?.index).toBeGreaterThanOrEqual(OUTPUT_LINE.indexOf(TOKEN));
  expect(caret?.index).toBeLessThan(OUTPUT_LINE.length);

  // The second click on the underline is the one that opens the file.
  const box = await decoration.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await expect(page.locator("#fileViewerOverlay")).toBeVisible();
  await expect(page.locator("#fileViewerTitle")).toHaveText(HOST_PATH);
  await expect.poll(() => harness.renderRequests).toEqual([{ source: "path", path: HOST_PATH }]);
});

test("a click on whitespace validates nothing", async ({ context, page }) => {
  test.setTimeout(60_000);
  const harness = await connectRemote(context, page, ["point"]);

  await page.waitForTimeout(300);
  // Column past the end of the only printed line.
  const emptyCell = await cellPoint(page, OUTPUT_LINE.length + 10);
  await page.mouse.click(emptyCell.x, emptyCell.y);
  await page.waitForTimeout(500);

  expect(harness.requests.filter((entry) => entry.mode === "point")).toEqual([]);
  await expect(page.locator(".remote-path-link-decoration")).toHaveCount(0);
});

test("redraws the screen underlines after a write that leaves the text unchanged", async ({
  context,
  page,
}) => {
  test.setTimeout(60_000);
  const harness = await connectRemote(context, page, ["screen"]);

  const decoration = page.locator(".remote-path-link-decoration");
  await expect(decoration).toHaveCount(1, { timeout: 10_000 });
  const firstScans = harness.requests.filter((entry) => entry.mode === "screen").length;

  // A cursor-home sequence: real output arrives (so the idle scheduler retires
  // the underlines and rearms) while the visible text stays identical. The scan
  // must still redraw — skipping on an equal signature with nothing drawn would
  // lose the display until the screen happened to change.
  harness.sendDelta("\u001b[H");
  // Wait for the rescan itself, not for a count that is still the old scan's.
  await expect
    .poll(() => harness.requests.filter((entry) => entry.mode === "screen").length, {
      timeout: 10_000,
    })
    .toBe(firstScans + 1);
  await expect(decoration).toHaveCount(1, { timeout: 10_000 });
});
