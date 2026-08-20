import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import { installRemoteClientRoutes } from "./remote-client-assets";

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

type RemoteMockOptions = {
  claimDelayMs?: number;
  heartbeatTimeoutSeconds?: number;
  heartbeatFailures?: number;
  heartbeatFailureStatus?: number;
  claimTransitionConflicts?: number;
  reconnectPayloadDelayMs?: number;
  snapshotLineCount?: number;
};

type RemoteTerminal = {
  buffer: { active: { viewportY: number; baseY: number } };
  scrollLines: (amount: number) => void;
};

type InstrumentedRemoteWindow = typeof window & {
  Terminal: { prototype: { reset: () => void } };
  __remoteResetCount: number;
  __remoteStatusHistory: string[];
  __remoteTerm?: RemoteTerminal;
};

async function installRemoteMocks(page: Page, options: RemoteMockOptions = {}) {
  const state = {
    claimRequests: 0,
    claimTransitionConflictsRemaining: options.claimTransitionConflicts ?? 0,
    heartbeatRequests: 0,
    heartbeatFailuresRemaining: options.heartbeatFailures ?? 0,
    sockets: [] as WebSocketRoute[],
  };

  await installRemoteClientRoutes(page);
  await page.route("http://remote.test/remote/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/remote/v1/session/claim") {
      state.claimRequests += 1;
      if (options.claimDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.claimDelayMs));
      }
      if (state.claimRequests > 1 && state.claimTransitionConflictsRemaining > 0) {
        state.claimTransitionConflictsRemaining -= 1;
        await route.fulfill({
          status: 409,
          json: {
            active: true,
            leaseId: "lease-1",
            heartbeatTimeoutSeconds: options.heartbeatTimeoutSeconds ?? 45,
            transitioning: true,
          },
        });
        return;
      }
      await route.fulfill({
        json: {
          active: true,
          leaseId: "lease-1",
          heartbeatTimeoutSeconds: options.heartbeatTimeoutSeconds ?? 45,
        },
      });
      return;
    }
    if (url.pathname === "/remote/v1/session/heartbeat") {
      state.heartbeatRequests += 1;
      if (state.heartbeatFailuresRemaining > 0) {
        state.heartbeatFailuresRemaining -= 1;
        if (options.heartbeatFailureStatus) {
          await route.fulfill({
            status: options.heartbeatFailureStatus,
            json: { message: "lease expired" },
          });
          return;
        }
        await route.abort("connectionfailed");
        return;
      }
      await route.fulfill({
        json: { active: true, leaseId: "lease-1" },
      });
      return;
    }
    if (url.pathname === "/remote/v1/navigation") {
      await route.fulfill({ json: navigation });
      return;
    }
    await route.fulfill({ json: {} });
  });

  await page.routeWebSocket(/\/remote\/v1\/terminals\/terminal-1\/output/, (socket) => {
    state.sockets.push(socket);
    const connectionNumber = state.sockets.length;
    const delay = connectionNumber > 1 ? (options.reconnectPayloadDelayMs ?? 0) : 0;
    setTimeout(() => {
      const prefix = connectionNumber === 1 ? "initial" : "restored";
      const output = Array.from(
        { length: options.snapshotLineCount ?? 1 },
        (_, index) => `${prefix}-${String(index + 1).padStart(4, "0")}\r\n`,
      ).join("");
      const payload = Buffer.from(output);
      socket.send(
        JSON.stringify({
          type: "terminal.output",
          version: 1,
          phase: "snapshot",
          seqStart: 0,
          seqEnd: payload.byteLength,
          byteLength: payload.byteLength,
          state: {
            version: 1,
            generation: connectionNumber,
            snapshotStartSeq: 0,
            snapshotSeq: payload.byteLength,
            sourceStartSeq: 0,
            sourceSeq: payload.byteLength,
            snapshotKind: "screen",
            protocolRevision: 0,
            modes: { bracketedPaste: false },
            geometry: { revision: 0, cols: 80, rows: 24 },
          },
        }),
      );
      socket.send(payload);
    }, delay);
  });

  return state;
}

async function instrumentRemotePage(page: Page) {
  await page.goto("http://remote.test/remote/#token=test-token");
  await page.evaluate(() => {
    const target = window as InstrumentedRemoteWindow;
    target.__remoteResetCount = 0;
    target.__remoteStatusHistory = [];
    const originalReset = target.Terminal.prototype.reset;
    target.Terminal.prototype.reset = function resetWithCount(this: RemoteTerminal) {
      target.__remoteResetCount += 1;
      target.__remoteTerm = this;
      return originalReset.call(this);
    };
    const statusText = document.getElementById("statusText");
    if (statusText) {
      target.__remoteStatusHistory.push(statusText.textContent || "");
      new MutationObserver(() => {
        target.__remoteStatusHistory.push(statusText.textContent || "");
      }).observe(statusText, { childList: true, subtree: true, characterData: true });
    }
  });
}

async function resetCount(page: Page) {
  return page.evaluate(
    () => (window as typeof window & { __remoteResetCount: number }).__remoteResetCount,
  );
}

async function statusHistory(page: Page) {
  return page.evaluate(
    () => (window as typeof window & { __remoteStatusHistory: string[] }).__remoteStatusHistory,
  );
}

async function viewportDistanceFromBottom(page: Page) {
  return page.evaluate(() => {
    const term = (window as InstrumentedRemoteWindow).__remoteTerm;
    if (!term) return null;
    const { baseY, viewportY } = term.buffer.active;
    return { baseY, distance: baseY - viewportY };
  });
}

async function scrollRemoteViewportUp(page: Page, lines: number) {
  return page.evaluate((amount) => {
    const term = (window as InstrumentedRemoteWindow).__remoteTerm;
    if (!term) throw new Error("remote terminal is not ready");
    term.scrollLines(-amount);
    return term.buffer.active.baseY - term.buffer.active.viewportY;
  }, lines);
}

function spinnerAnimationName(spinner: Locator) {
  return spinner.evaluate((el) => getComputedStyle(el).animationName);
}

test("a pending top-bar action shows and then clears its spinner", async ({ page }) => {
  await installRemoteMocks(page, { claimDelayMs: 600 });
  await instrumentRemotePage(page);

  await page.locator("#connect").click();

  const status = page.locator("#status");
  const spinner = page.locator("#statusSpinner");
  await expect(page.locator("#statusText")).toHaveText("Claiming remote control…");
  await expect(status).toHaveAttribute("aria-busy", "true");
  await expect(spinner).toBeVisible();
  // The marker is a drawn ring, not a glyph: it carries no text at any frame.
  await expect(spinner).toHaveText("");
  expect(await spinnerAnimationName(spinner)).toBe("status-spinner-spin");

  await expect(page.locator("#statusText")).toHaveText("Main · Pane 1");
  await expect(status).toHaveAttribute("aria-busy", "false");
  await expect(spinner).toBeHidden();
});

test("reduced motion keeps the pending marker static", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installRemoteMocks(page, { claimDelayMs: 600 });
  await instrumentRemotePage(page);

  await page.locator("#connect").click();

  const spinner = page.locator("#statusSpinner");
  await expect(page.locator("#statusText")).toHaveText("Claiming remote control…");
  await expect(spinner).toBeVisible();
  expect(await spinnerAnimationName(spinner)).toBe("none");
  // Static marker, but still a marker: the ring closes instead of spinning.
  const borders = await spinner.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      top: style.borderTopColor,
      right: style.borderRightColor,
      rightStyle: style.borderRightStyle,
      width: style.width,
      height: style.height,
    };
  });
  expect(borders.top).toBe(borders.right);
  expect(borders.rightStyle).toBe("solid");
  expect(borders.width).toBe("10px");
  expect(borders.height).toBe("10px");
});

test("a disconnected paste reports a static warning instead of endless reconnect activity", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("laymux.remote.inputMode", "direct");
  });
  await installRemoteMocks(page);
  await instrumentRemotePage(page);

  await page.locator("#connect").click();
  await expect(page.locator("#statusText")).toHaveText("Main · Pane 1");
  await page.locator("#exit").evaluate((element: HTMLButtonElement) => element.click());
  await expect(page.locator("#statusText")).toHaveText("Exited remote control.");

  await page.locator("#terminal").evaluate((element) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", "ignored");
    element.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }),
    );
  });

  const status = page.locator("#status");
  await expect(page.locator("#statusText")).toHaveText("Terminal input is not ready.");
  await expect(status).toHaveClass(/warning/);
  await expect(status).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("#statusSpinner")).toBeHidden();
});

test("a short output drop reconnects without status noise or an early terminal reset", async ({
  page,
}) => {
  const remote = await installRemoteMocks(page, { reconnectPayloadDelayMs: 600 });
  await instrumentRemotePage(page);

  await page.locator("#connect").click();
  await expect(page.locator("#status")).toHaveText("Main · Pane 1");
  await expect.poll(() => resetCount(page)).toBe(1);

  await remote.sockets[0].close();
  await expect.poll(() => remote.sockets.length).toBe(2);
  await page.waitForTimeout(150);

  expect(await resetCount(page)).toBe(1);
  await expect(page.locator("#status")).toHaveText("Main · Pane 1");
  await expect.poll(() => resetCount(page)).toBe(2);
  expect(await statusHistory(page)).not.toContain("Connection interrupted. Reconnecting…");
});

test("an output reconnect preserves a scrolled-up viewport", async ({ page }) => {
  const remote = await installRemoteMocks(page, {
    snapshotLineCount: 300,
    reconnectPayloadDelayMs: 600,
  });
  await instrumentRemotePage(page);

  await page.locator("#connect").click();
  await expect.poll(() => resetCount(page)).toBe(1);
  await expect
    .poll(async () => (await viewportDistanceFromBottom(page))?.baseY ?? 0)
    .toBeGreaterThan(0);

  await remote.sockets[0].close();
  await expect.poll(() => remote.sockets.length).toBe(2);
  // The old surface remains visible while the replacement checkpoint is in
  // flight. A scroll made in this window is the state recovery must preserve,
  // not the viewport captured when reconnect scheduling began.
  expect(await resetCount(page)).toBe(1);
  const distanceBeforeReconnect = await scrollRemoteViewportUp(page, 12);
  expect(distanceBeforeReconnect).toBeGreaterThan(0);
  await expect.poll(() => resetCount(page)).toBe(2);

  await expect
    .poll(async () => (await viewportDistanceFromBottom(page))?.distance ?? 0)
    .toBe(distanceBeforeReconnect);
});

for (const inputMode of ["direct", "composer"] as const) {
  test(`an output reconnect does not reopen dismissed ${inputMode} input`, async ({ page }) => {
    await page.addInitScript((mode) => {
      localStorage.setItem("laymux.remote.inputMode", mode);
    }, inputMode);
    const remote = await installRemoteMocks(page);
    await instrumentRemotePage(page);

    await page.locator("#connect").click();
    await expect.poll(() => resetCount(page)).toBe(1);

    const inputSurface =
      inputMode === "direct"
        ? page.locator(".xterm-helper-textarea")
        : page.locator("#composerInput");
    await expect(inputSurface).toBeFocused();
    await inputSurface.evaluate((element: HTMLElement) => element.blur());
    await expect(inputSurface).not.toBeFocused();

    await remote.sockets[0].close();
    await expect.poll(() => remote.sockets.length).toBe(2);
    await expect.poll(() => resetCount(page)).toBe(2);

    await expect(inputSurface).not.toBeFocused();
  });
}

test("an automatic lease reclaim preserves dismissed composer input and scroll viewport", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("laymux.remote.inputMode", "composer");
  });
  const remote = await installRemoteMocks(page, {
    heartbeatTimeoutSeconds: 5,
    heartbeatFailures: 1,
    heartbeatFailureStatus: 409,
    claimTransitionConflicts: 1,
    snapshotLineCount: 300,
  });
  await instrumentRemotePage(page);

  await page.locator("#connect").click();
  await expect.poll(() => resetCount(page)).toBe(1);
  await expect
    .poll(async () => (await viewportDistanceFromBottom(page))?.baseY ?? 0)
    .toBeGreaterThan(0);

  const distanceBeforeReclaim = await scrollRemoteViewportUp(page, 12);
  expect(distanceBeforeReclaim).toBeGreaterThan(0);

  const composerInput = page.locator("#composerInput");
  await expect(composerInput).toBeFocused();
  await composerInput.evaluate((element: HTMLElement) => element.blur());
  await expect(composerInput).not.toBeFocused();

  await expect.poll(() => remote.claimRequests, { timeout: 5000 }).toBe(3);
  await expect.poll(() => resetCount(page)).toBe(2);
  await expect(composerInput).not.toBeFocused();
  await expect
    .poll(async () => (await viewportDistanceFromBottom(page))?.distance ?? 0)
    .toBe(distanceBeforeReclaim);
});

test("one failed heartbeat is retried before the delayed interruption notice", async ({ page }) => {
  const remote = await installRemoteMocks(page, {
    heartbeatTimeoutSeconds: 5,
    heartbeatFailures: 1,
  });
  await instrumentRemotePage(page);

  await page.locator("#connect").click();
  await expect(page.locator("#status")).toHaveText("Main · Pane 1");
  await expect.poll(() => remote.heartbeatRequests, { timeout: 5000 }).toBeGreaterThanOrEqual(2);

  await expect(page.locator("#status")).toHaveText("Main · Pane 1");
  expect(await statusHistory(page)).not.toContain("Connection interrupted. Reconnecting…");
});
