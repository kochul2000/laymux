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
      appearance: {},
    },
  ],
  workspaceSelector: { display: {}, pathEllipsis: "start" },
  notifications: [],
  unreadNotificationCount: 0,
};

function snapshotFrames(lineCount: number): { header: string; payload: Buffer } {
  const text = Array.from(
    { length: lineCount },
    (_, index) => `line-${String(index + 1).padStart(4, "0")}\r\n`,
  ).join("");
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
      snapshotStartSeq: 0,
      snapshotSeq: payload.byteLength,
      protocolRevision: 0,
      modes: { bracketedPaste: false },
    },
  });
  return { header, payload };
}

async function installRemoteMocks(page: Page, lineCount: number) {
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
    await route.fulfill({ json: {} });
  });

  await page.routeWebSocket(/\/remote\/v1\/terminals\/terminal-1\/output/, (socket) => {
    const { header, payload } = snapshotFrames(lineCount);
    socket.send(header);
    socket.send(payload);
  });
}

type TermWindow = typeof window & {
  Terminal: { prototype: { reset: () => void } };
  __remoteTerm?: {
    buffer: { active: { viewportY: number; baseY: number } };
  };
};

test("a v1 snapshot replay lands the viewport at the live tail", async ({ page }) => {
  await installRemoteMocks(page, 300);
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
  await expect(page.locator("#status")).toHaveText("Connected to terminal-1");

  // 300 lines must overflow the viewport into scrollback, and the viewport
  // must end pinned to the live tail, not mid-history.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const term = (window as TermWindow).__remoteTerm;
        if (!term) return "terminal not created yet";
        const { viewportY, baseY } = term.buffer.active;
        if (baseY <= 0) return "no scrollback yet";
        return viewportY === baseY ? "at-bottom" : `viewport ${viewportY} of base ${baseY}`;
      }),
    )
    .toBe("at-bottom");
});
