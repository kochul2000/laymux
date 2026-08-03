import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
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
  heartbeatTimeoutSeconds?: number;
  heartbeatFailures?: number;
  heartbeatFailureStatus?: number;
  reconnectPayloadDelayMs?: number;
};

async function installRemoteMocks(page: Page, options: RemoteMockOptions = {}) {
  const state = {
    claimRequests: 0,
    heartbeatRequests: 0,
    heartbeatFailuresRemaining: options.heartbeatFailures ?? 0,
    sockets: [] as WebSocketRoute[],
  };

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
      state.claimRequests += 1;
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
      const payload = Buffer.from(
        connectionNumber === 1 ? "initial output\r\n" : "restored output\r\n",
      );
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
    const target = window as typeof window & {
      Terminal: { prototype: { reset: () => void } };
      __remoteResetCount: number;
      __remoteStatusHistory: string[];
    };
    target.__remoteResetCount = 0;
    target.__remoteStatusHistory = [];
    const originalReset = target.Terminal.prototype.reset;
    target.Terminal.prototype.reset = function resetWithCount() {
      target.__remoteResetCount += 1;
      return originalReset.call(this);
    };
    const status = document.getElementById("status");
    if (status) {
      target.__remoteStatusHistory.push(status.textContent || "");
      new MutationObserver(() => {
        target.__remoteStatusHistory.push(status.textContent || "");
      }).observe(status, { childList: true, subtree: true, characterData: true });
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
  expect(await statusHistory(page)).not.toContain("Connection interrupted. Reconnecting...");
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

test("an automatic lease reclaim does not reopen dismissed composer input", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("laymux.remote.inputMode", "composer");
  });
  const remote = await installRemoteMocks(page, {
    heartbeatTimeoutSeconds: 5,
    heartbeatFailures: 1,
    heartbeatFailureStatus: 409,
  });
  await instrumentRemotePage(page);

  await page.locator("#connect").click();
  await expect.poll(() => resetCount(page)).toBe(1);

  const composerInput = page.locator("#composerInput");
  await expect(composerInput).toBeFocused();
  await composerInput.evaluate((element: HTMLElement) => element.blur());
  await expect(composerInput).not.toBeFocused();

  await expect.poll(() => remote.claimRequests, { timeout: 5000 }).toBe(2);
  await expect.poll(() => resetCount(page)).toBe(2);
  await expect(composerInput).not.toBeFocused();
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
  expect(await statusHistory(page)).not.toContain("Connection interrupted. Reconnecting...");
});
