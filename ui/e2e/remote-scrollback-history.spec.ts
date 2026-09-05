import { expect, test, type Page } from "@playwright/test";
import { installRemoteClientRoutes } from "./remote-client-assets";

function pane(index: number, terminalId: string, title: string) {
  return {
    id: `pane-${index + 1}`,
    location: "workspace",
    workspaceId: "ws-1",
    paneIndex: index,
    paneNumber: index + 1,
    viewType: "terminal",
    terminalId,
    terminalLive: true,
    title,
    profile: "PowerShell",
    cwd: "C:\\work",
    branch: "main",
    activity: { type: "shell" },
    outputActive: false,
    commandRunning: false,
    isFocused: index === 0,
    unreadCount: 0,
    hidden: false,
    collapsed: false,
    x: index === 0 ? 0 : 0.5,
    y: 0,
    w: 0.5,
    h: 1,
  };
}

const navigation = {
  activeWorkspace: {
    id: "ws-1",
    name: "Main",
    panes: [pane(0, "terminal-1", "Shell"), pane(1, "terminal-2", "Second")],
  },
  workspaces: [
    {
      id: "ws-1",
      name: "Main",
      isActive: true,
      hidden: false,
      collapsed: false,
      paneCount: 2,
      terminalPaneCount: 2,
      liveTerminalCount: 2,
      unreadCount: 0,
      panes: [pane(0, "terminal-1", "Shell"), pane(1, "terminal-2", "Second")],
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
    {
      id: "terminal-2",
      title: "Second",
      profile: "PowerShell",
      cwd: "C:\\work",
      workspaceId: "ws-1",
      paneNumber: 2,
      appearance: {},
    },
  ],
  workspaceSelector: { display: {}, pathEllipsis: "start" },
  notifications: [],
  unreadNotificationCount: 0,
};

const LINE_BYTES = 100;

interface Geometry {
  cols: number;
  rows: number;
}

/**
 * One screen checkpoint worth `kib` KiB of scrollback. Lines are padded to a
 * fixed width so a test can reason in budget units instead of row counts.
 */
function snapshotFrames(
  kib: number,
  geometry: Geometry,
  prologue = "",
): { header: string; payload: Buffer } {
  const lineCount = Math.max(1, Math.floor((kib * 1024) / LINE_BYTES));
  const text =
    prologue +
    Array.from({ length: lineCount }, (_, index) =>
      `line-${String(index + 1).padStart(6, "0")}`.padEnd(LINE_BYTES - 2, "."),
    ).join("\r\n");
  const payload = Buffer.from(`${text}\r\n`, "utf8");
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
      snapshotKind: "screen",
      protocolRevision: 0,
      modes: { bracketedPaste: false },
      geometry: { revision: 0, cols: geometry.cols, rows: geometry.rows },
    },
  });
  return { header, payload };
}

interface Attach {
  terminalId: string;
  historyKib: number;
  close: () => void;
}

interface DesktopOptions {
  /** Server-side fallback floor; the device normally sends its own budget. */
  ownerKib: number;
  /** How much scrollback the terminal actually holds. */
  scrollbackKib: number;
  /** Written before the scrollback, e.g. to enter the alternate buffer. */
  prologue?: string;
}

/**
 * Desktop model: the served checkpoint is `min(max(ownerKib, historyKib),
 * scrollbackKib)` — the server fallback can only raise a too-small device
 * request, bounded by what the terminal really holds (ADR-0209).
 */
async function installRemoteMocks(page: Page, options: DesktopOptions, attaches: Attach[]) {
  let ptyGeometry: Geometry = { cols: 80, rows: 24 };
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
    if (url.pathname.endsWith("/resize")) {
      // The desktop owns PTY geometry: the checkpoint is serialized at the
      // size the client just established, exactly like the real attach order.
      const body = route.request().postDataJSON() as Geometry;
      if (body?.cols > 0 && body?.rows > 0) ptyGeometry = { cols: body.cols, rows: body.rows };
    }
    await route.fulfill({ json: {} });
  });

  await page.routeWebSocket(/\/remote\/v1\/terminals\/[^/]+\/output/, (socket) => {
    const url = new URL(socket.url());
    const historyKib = Number(url.searchParams.get("historyKib") ?? 0);
    const terminalId = decodeURIComponent(
      url.pathname.replace("/remote/v1/terminals/", "").replace("/output", ""),
    );
    attaches.push({ terminalId, historyKib, close: () => socket.close() });
    const served = Math.min(Math.max(options.ownerKib, historyKib), options.scrollbackKib);
    const { header, payload } = snapshotFrames(served, ptyGeometry, options.prologue);
    socket.send(header);
    socket.send(payload);
  });
}

type TermWindow = typeof window & {
  Terminal: { prototype: { reset: () => void } };
  __remoteTerm?: {
    buffer: { active: { viewportY: number; baseY: number; type: string } };
    scrollLines: (amount: number) => void;
    write: (data: string, callback?: () => void) => void;
  };
};

async function connectAndCaptureTerminal(page: Page) {
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

function baseY(page: Page) {
  return page.evaluate(() => (window as TermWindow).__remoteTerm?.buffer.active.baseY ?? 0);
}

/**
 * What a user does: a scroll gesture over the terminal that carries the
 * viewport to row 0. The page only treats row 0 as "reached the top" when a
 * gesture vouches for the movement, so the wheel event is part of the action.
 */
async function pullToTop(page: Page) {
  await wheelUpOverTerminal(page);
  await page.evaluate(() => (window as TermWindow).__remoteTerm?.scrollLines(-100000));
}

function wheelUpOverTerminal(page: Page) {
  return page.evaluate(() => {
    document
      .querySelector("#terminal")
      ?.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
  });
}

test("reaching the top of the scrollback attaches a deeper screen checkpoint", async ({ page }) => {
  const attaches: Attach[] = [];
  await installRemoteMocks(page, { ownerKib: 4, scrollbackKib: 256 }, attaches);
  await connectAndCaptureTerminal(page);

  await expect.poll(() => baseY(page)).toBeGreaterThan(0);
  await page.waitForTimeout(600);
  const initialBaseY = await baseY(page);

  await pullToTop(page);

  await expect.poll(() => baseY(page)).toBeGreaterThan(initialBaseY);
  expect(attaches.map((attach) => attach.historyKib)).toEqual([4, 64]);
  await expect(page.locator("#status")).toHaveText("Main · Pane 1");

  // The rows the user was reading stay on screen: the viewport keeps its
  // distance from the live tail instead of jumping to the bottom.
  const restored = await page.evaluate(() => {
    const term = (window as TermWindow).__remoteTerm;
    return term ? term.buffer.active.baseY - term.buffer.active.viewportY : 0;
  });
  expect(restored).toBe(initialBaseY);
});

test("a device budget above the first expansion step still expands", async ({ page }) => {
  // The expansion is derived from the screen the page holds, so a large
  // device-local initial budget does not collide with a fixed request ladder.
  const attaches: Attach[] = [];
  await installRemoteMocks(page, { ownerKib: 4, scrollbackKib: 256 }, attaches);
  await page.addInitScript(() => {
    localStorage.setItem("laymux.remote.displaySettings", JSON.stringify({ snapshotMaxKib: 64 }));
  });
  await connectAndCaptureTerminal(page);

  await expect.poll(() => baseY(page)).toBeGreaterThan(0);
  const initialBaseY = await baseY(page);
  expect(attaches[0].historyKib).toBe(64);

  await pullToTop(page);

  await expect.poll(() => baseY(page)).toBeGreaterThan(initialBaseY);
  expect(attaches).toHaveLength(2);
  expect(attaches[1].historyKib).toBeGreaterThan(64);
  await expect(page.locator("#status")).toHaveText("Main · Pane 1");
});

test("a checkpoint without older rows stops the client from asking again", async ({ page }) => {
  const attaches: Attach[] = [];
  await installRemoteMocks(page, { ownerKib: 4, scrollbackKib: 4 }, attaches);
  await connectAndCaptureTerminal(page);

  await expect.poll(() => baseY(page)).toBeGreaterThan(0);
  await pullToTop(page);

  await expect(page.locator("#status")).toHaveText("No earlier output is available.");
  expect(attaches).toHaveLength(2);
  await expect(page.locator("#status")).toHaveText("Main · Pane 1", { timeout: 3_000 });

  // A second pull at the top must not reopen the socket once the desktop has
  // shown it has nothing older at this budget.
  await pullToTop(page);
  await wheelUpOverTerminal(page);
  await page.waitForTimeout(300);
  expect(attaches).toHaveLength(2);
});

test("a newer status outlives the history limit notice", async ({ page }) => {
  const attaches: Attach[] = [];
  await installRemoteMocks(page, { ownerKib: 4, scrollbackKib: 4 }, attaches);
  await connectAndCaptureTerminal(page);

  await expect.poll(() => baseY(page)).toBeGreaterThan(0);
  await pullToTop(page);
  await expect(page.locator("#status")).toHaveText("No earlier output is available.");

  await page.evaluate(() => {
    Object.defineProperty(document, "execCommand", { value: () => true });
  });
  await page.locator("#copyPaneId").click();
  await expect(page.locator("#status")).toHaveText("Copied lx:pane:Main:1");
  await page.waitForTimeout(2_500);
  await expect(page.locator("#status")).toHaveText("Copied lx:pane:Main:1");
});

test("a wheel pull while already parked at the top asks on its own", async ({ page }) => {
  // At row 0 xterm scrolls nothing, so `onScroll` never fires: the wheel
  // handler is the only thing that can carry this gesture.
  const attaches: Attach[] = [];
  await installRemoteMocks(page, { ownerKib: 4, scrollbackKib: 256 }, attaches);
  await connectAndCaptureTerminal(page);

  await expect.poll(() => baseY(page)).toBeGreaterThan(0);
  await page.evaluate(() => (window as TermWindow).__remoteTerm?.scrollLines(-100000));
  await page.waitForTimeout(200);
  expect(attaches).toHaveLength(1);

  await wheelUpOverTerminal(page);

  await expect.poll(() => attaches.length).toBe(2);
  expect(attaches[1].historyKib).toBe(64);
});

test("a viewport carried to the top without a gesture asks for nothing", async ({ page }) => {
  // Output can push a parked viewport to row 0 on its own: xterm drops `ydisp`
  // as the scrollback trims. Only a scroll gesture means the user wants more.
  const attaches: Attach[] = [];
  await installRemoteMocks(page, { ownerKib: 4, scrollbackKib: 256 }, attaches);
  await connectAndCaptureTerminal(page);

  await expect.poll(() => baseY(page)).toBeGreaterThan(0);
  await page.evaluate(() => (window as TermWindow).__remoteTerm?.scrollLines(-100000));
  await page.waitForTimeout(400);

  expect(attaches).toHaveLength(1);
});

test("an alternate-buffer screen never asks for scrollback it cannot have", async ({ page }) => {
  const attaches: Attach[] = [];
  await installRemoteMocks(
    page,
    {
      ownerKib: 4,
      scrollbackKib: 256,
      // Leave real normal-buffer history underneath the alternate screen so
      // returning to it can emit a genuine row-0 scroll event.
      prologue: `${"normal-history\r\n".repeat(100)}\x1b[?1049h`,
    },
    attaches,
  );
  await connectAndCaptureTerminal(page);

  await expect
    .poll(() => page.evaluate(() => (window as TermWindow).__remoteTerm?.buffer.active.type ?? ""))
    .toBe("alternate");

  await pullToTop(page);
  await wheelUpOverTerminal(page);

  // The alternate-screen wheel cancels pending viewport automation, but must
  // not vouch for a later normal-buffer row-0 transition as shell-history
  // intent. Otherwise the old 1.5s gesture stamp reattaches a checkpoint here.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const term = (window as TermWindow).__remoteTerm;
        if (!term) return resolve();
        term.write("\x1b[?1049l", resolve);
      }),
  );
  await expect
    .poll(() => page.evaluate(() => (window as TermWindow).__remoteTerm?.buffer.active.type ?? ""))
    .toBe("normal");
  await page.evaluate(() => (window as TermWindow).__remoteTerm?.scrollLines(-100000));
  await page.waitForTimeout(300);

  expect(attaches).toHaveLength(1);
});

test("transport recovery keeps the history the user already paged in", async ({ page }) => {
  const attaches: Attach[] = [];
  await installRemoteMocks(page, { ownerKib: 4, scrollbackKib: 256 }, attaches);
  await connectAndCaptureTerminal(page);

  await expect.poll(() => baseY(page)).toBeGreaterThan(0);
  await pullToTop(page);
  await expect.poll(() => attaches.length).toBe(2);
  expect(attaches[1].historyKib).toBe(64);

  attaches[1].close();

  await expect.poll(() => attaches.length).toBe(3);
  expect(attaches[2].historyKib).toBe(64);

  // Restoring the scrolled-up offset lands the viewport back on row 0. That is
  // the page moving the viewport, not the user reaching the top, so it must not
  // start another expansion.
  await page.waitForTimeout(400);
  expect(attaches).toHaveLength(3);
});

test("a request that never gets its snapshot is retried, not read as exhaustion", async ({
  page,
}) => {
  const attaches: Attach[] = [];
  let ptyGeometry: Geometry = { cols: 80, rows: 24 };
  await installRemoteClientRoutes(page);
  let answerAttach = true;
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
    if (url.pathname.endsWith("/resize")) {
      const body = route.request().postDataJSON() as Geometry;
      if (body?.cols > 0 && body?.rows > 0) ptyGeometry = { cols: body.cols, rows: body.rows };
    }
    await route.fulfill({ json: {} });
  });
  await page.routeWebSocket(/\/remote\/v1\/terminals\/[^/]+\/output/, (socket) => {
    const historyKib = Number(new URL(socket.url()).searchParams.get("historyKib") ?? 0);
    attaches.push({ terminalId: "terminal-1", historyKib, close: () => socket.close() });
    // The expansion attach dies before delivering anything: the request is
    // released, and the budget it raised must roll back with it.
    if (historyKib > 4 && !answerAttach) {
      socket.close();
      return;
    }
    const served = Math.min(Math.max(4, historyKib), 256);
    const { header, payload } = snapshotFrames(served, ptyGeometry);
    socket.send(header);
    socket.send(payload);
  });

  await connectAndCaptureTerminal(page);
  await expect.poll(() => baseY(page)).toBeGreaterThan(0);

  answerAttach = false;
  await pullToTop(page);
  await expect.poll(() => attaches.length).toBeGreaterThanOrEqual(2);
  expect(attaches[1].historyKib).toBe(64);

  // A dropped attach is transport evidence, not "the desktop has nothing
  // older": the pane must stay expandable.
  await expect(page.locator("#status")).not.toHaveText("No earlier output is available.");
  // The budget rolls back with the cancelled request, so transport recovery
  // reattaches at the device's own budget. Leaving it raised would make the
  // next pull recompute the same request and call the pane exhausted.
  await expect.poll(() => attaches.length).toBeGreaterThanOrEqual(3);
  expect(attaches[2].historyKib).toBe(4);

  answerAttach = true;
  await expect.poll(() => baseY(page)).toBeGreaterThan(0);
  const attachesBeforeRetry = attaches.length;
  await pullToTop(page);
  await expect
    .poll(() => attaches.slice(attachesBeforeRetry).some((attach) => attach.historyKib === 64))
    .toBe(true);
  await expect(page.locator("#status")).not.toHaveText("No earlier output is available.");
});

test("re-selecting the same pane starts over at the device budget", async ({ page }) => {
  // A user-directed attach lands at the live tail anyway, so carrying the
  // raised budget into it would only re-drive a big desktop serialization.
  const attaches: Attach[] = [];
  await installRemoteMocks(page, { ownerKib: 4, scrollbackKib: 256 }, attaches);
  await connectAndCaptureTerminal(page);

  await expect.poll(() => baseY(page)).toBeGreaterThan(0);
  await pullToTop(page);
  await expect.poll(() => attaches.length).toBe(2);
  expect(attaches[1].historyKib).toBe(64);

  await page.locator("#navToggle").click();
  await page.locator(".workspace-item.active .workspace-pane-row").nth(0).click();

  await expect.poll(() => attaches.length).toBe(3);
  expect(attaches[2].historyKib).toBe(4);
});

test("switching panes starts the next terminal at the device budget", async ({ page }) => {
  const attaches: Attach[] = [];
  await installRemoteMocks(page, { ownerKib: 4, scrollbackKib: 256 }, attaches);
  await connectAndCaptureTerminal(page);

  await expect.poll(() => baseY(page)).toBeGreaterThan(0);
  await pullToTop(page);
  await expect.poll(() => attaches.length).toBe(2);
  expect(attaches[1].historyKib).toBe(64);

  await page.locator("#navToggle").click();
  await page.locator(".workspace-item.active .workspace-pane-row").nth(1).click();

  await expect.poll(() => attaches.at(-1)?.terminalId).toBe("terminal-2");
  expect(attaches.at(-1)?.historyKib).toBe(4);
});
