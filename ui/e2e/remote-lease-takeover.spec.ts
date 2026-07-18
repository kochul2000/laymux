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

type LeaseMockOptions = {
  /** When false the mocked release endpoint keeps the lease installed, which
   * models a release beacon the server never received. */
  releaseClearsLease?: boolean;
  heartbeatStatus?: number;
};

type CapturedRequest = { url: string; body: Record<string, unknown> };

async function installLeaseMocks(page: Page, options: LeaseMockOptions = {}) {
  const state = {
    activeLeaseId: null as string | null,
    leaseCounter: 0,
    claimRequests: [] as CapturedRequest[],
    releaseRequests: [] as CapturedRequest[],
    heartbeatStatus: options.heartbeatStatus ?? 200,
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
    const request = route.request();
    const url = new URL(request.url());
    const body = (request.postData() ? JSON.parse(request.postData() as string) : {}) as Record<
      string,
      unknown
    >;
    if (url.pathname === "/remote/v1/session/claim") {
      state.claimRequests.push({ url: request.url(), body });
      // Mirrors the server contract: an installed lease rejects claims with
      // 409 unless previousLeaseId proves the claimant owns that lease.
      if (state.activeLeaseId && body.previousLeaseId !== state.activeLeaseId) {
        await route.fulfill({
          status: 409,
          json: { active: true, leaseId: state.activeLeaseId, heartbeatTimeoutSeconds: 45 },
        });
        return;
      }
      state.leaseCounter += 1;
      state.activeLeaseId = `lease-${state.leaseCounter}`;
      await route.fulfill({
        json: { active: true, leaseId: state.activeLeaseId, heartbeatTimeoutSeconds: 45 },
      });
      return;
    }
    if (url.pathname === "/remote/v1/session/release") {
      state.releaseRequests.push({ url: request.url(), body });
      if ((options.releaseClearsLease ?? true) && body.leaseId === state.activeLeaseId) {
        state.activeLeaseId = null;
      }
      await route.fulfill({ json: { active: false, leaseId: null } });
      return;
    }
    if (url.pathname === "/remote/v1/session/heartbeat") {
      if (state.heartbeatStatus !== 200) {
        await route.fulfill({
          status: state.heartbeatStatus,
          json: { error: "remote controller lease is not active" },
        });
        return;
      }
      await route.fulfill({ json: { active: true, leaseId: state.activeLeaseId } });
      return;
    }
    if (url.pathname === "/remote/v1/navigation") {
      await route.fulfill({ json: navigation });
      return;
    }
    await route.fulfill({ json: {} });
  });

  await page.routeWebSocket(/\/remote\/v1\/terminals\/terminal-1\/output/, (socket) => {
    socket.send(Buffer.from("output\r\n"));
  });

  return state;
}

async function connectRemote(page: Page) {
  await page.locator("#connect").click();
  await expect(page.locator("#status")).toHaveText("Connected to terminal-1");
}

async function storedLeaseId(page: Page) {
  return page.evaluate(() => sessionStorage.getItem("laymux.remote.leaseId"));
}

test("pagehide sends a release beacon with the lease id and query token", async ({ page }) => {
  const remote = await installLeaseMocks(page);
  await page.goto("http://remote.test/remote/#token=test-token");
  await connectRemote(page);
  expect(await storedLeaseId(page)).toBe("lease-1");

  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));

  await expect.poll(() => remote.releaseRequests.length).toBe(1);
  const release = remote.releaseRequests[0];
  expect(release.body.leaseId).toBe("lease-1");
  expect(new URL(release.url).searchParams.get("token")).toBe("test-token");
});

test("a reload takes over its own zombie lease via previousLeaseId", async ({ page }) => {
  // The release beacon is "lost": the zombie lease stays installed and only a
  // takeover claim can replace it before the heartbeat timeout.
  const remote = await installLeaseMocks(page, { releaseClearsLease: false });
  await page.goto("http://remote.test/remote/#token=test-token");
  await connectRemote(page);
  expect(remote.claimRequests[0].body.previousLeaseId).toBeUndefined();

  await page.reload();
  await connectRemote(page);

  expect(remote.claimRequests[1].body.previousLeaseId).toBe("lease-1");
  expect(await storedLeaseId(page)).toBe("lease-2");
});

test("a server-confirmed lease loss clears the stored lease id", async ({ page }) => {
  const remote = await installLeaseMocks(page);
  await page.goto("http://remote.test/remote/#token=test-token");
  await connectRemote(page);
  expect(await storedLeaseId(page)).toBe("lease-1");

  remote.heartbeatStatus = 409;

  await expect(page.locator(".connection-hint")).toContainText("Host has control", {
    timeout: 10_000,
  });
  expect(await storedLeaseId(page)).toBeNull();
});
