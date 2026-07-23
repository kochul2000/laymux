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

const secondPane = {
  ...navigation.activeWorkspace.panes[0],
  id: "pane-2",
  paneIndex: 1,
  paneNumber: 2,
  terminalId: "terminal-2",
  title: "Shell 2",
  cwd: "C:\\two",
  isFocused: false,
  y: 0.5,
  h: 0.5,
};

const dockPane = {
  ...navigation.activeWorkspace.panes[0],
  id: "dock-pane-1",
  location: "dock",
  workspaceId: null,
  paneIndex: 0,
  paneNumber: 1,
  viewType: "TerminalView",
  terminalId: "dock-terminal-1",
  title: "Dock Shell",
  cwd: "C:\\dock",
  isFocused: false,
};

const multiTerminalNavigation = {
  ...navigation,
  activeWorkspace: {
    ...navigation.activeWorkspace,
    focusedPaneNumber: 1,
    panes: [navigation.activeWorkspace.panes[0], secondPane],
  },
  workspaces: [
    {
      ...navigation.workspaces[0],
      paneCount: 2,
      terminalPaneCount: 2,
      liveTerminalCount: 2,
      panes: [navigation.activeWorkspace.panes[0], secondPane],
    },
  ],
  docks: [
    {
      id: "dock-bottom",
      position: "bottom",
      visible: true,
      panes: [dockPane],
    },
  ],
  terminals: [
    navigation.terminals[0],
    {
      ...navigation.terminals[0],
      id: "terminal-2",
      title: "Shell 2",
      cwd: "C:\\two",
      paneNumber: 2,
    },
    {
      ...navigation.terminals[0],
      id: "dock-terminal-1",
      title: "Dock Shell",
      cwd: "C:\\dock",
      workspaceId: null,
      paneNumber: 1,
    },
  ],
};

type NavigationResponse = {
  terminals: Array<{ id: string }>;
  [key: string]: unknown;
};

type LeaseMockOptions = {
  /** When false the mocked release endpoint keeps the lease installed, which
   * models a release beacon the server never received. */
  releaseClearsLease?: boolean;
};

type CapturedRequest = { url: string; body: Record<string, unknown> };

function createLeaseMockState(options: LeaseMockOptions = {}) {
  return {
    activeLeaseId: null as string | null,
    activeResumeToken: null as string | null,
    leaseCounter: 0,
    claimRequests: [] as CapturedRequest[],
    releaseRequests: [] as CapturedRequest[],
    heartbeatStatus: 200,
    releaseClearsLease: options.releaseClearsLease ?? true,
    outputTerminalIds: [] as string[],
  };
}

type LeaseMockState = ReturnType<typeof createLeaseMockState>;

async function installLeaseMocks(
  page: Page,
  state: LeaseMockState,
  navigationResponse: NavigationResponse = navigation,
) {
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
      // Mirrors the server contract: an installed lease rejects claims with a
      // 409 status body unless the secret resumeToken issued with that lease
      // is presented. The public leaseId proves nothing.
      if (state.activeLeaseId && body.resumeToken !== state.activeResumeToken) {
        await route.fulfill({
          status: 409,
          json: { active: true, leaseId: state.activeLeaseId, heartbeatTimeoutSeconds: 45 },
        });
        return;
      }
      state.leaseCounter += 1;
      state.activeLeaseId = `lease-${state.leaseCounter}`;
      state.activeResumeToken = `resume-${state.leaseCounter}`;
      await route.fulfill({
        json: {
          active: true,
          leaseId: state.activeLeaseId,
          resumeToken: state.activeResumeToken,
          heartbeatTimeoutSeconds: 45,
        },
      });
      return;
    }
    if (url.pathname === "/remote/v1/session/release") {
      state.releaseRequests.push({ url: request.url(), body });
      if (state.releaseClearsLease && body.leaseId === state.activeLeaseId) {
        state.activeLeaseId = null;
        state.activeResumeToken = null;
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
      await route.fulfill({ json: navigationResponse });
      return;
    }
    await route.fulfill({ json: {} });
  });

  for (const terminal of navigationResponse.terminals) {
    await page.routeWebSocket(
      new RegExp(`/remote/v1/terminals/${terminal.id}/output`),
      (socket) => {
        state.outputTerminalIds.push(terminal.id);
        socket.send(Buffer.from("output\r\n"));
      },
    );
  }
}

async function connectRemote(page: Page, expectedStatus = "Main · Pane 1") {
  await page.locator("#connect").click();
  await expect(page.locator("#status")).toHaveText(expectedStatus);
}

async function stashedResumeToken(page: Page) {
  return page.evaluate(() => sessionStorage.getItem("laymux.remote.resumeToken"));
}

test("pagehide stashes the resume capability and sends a release beacon", async ({ page }) => {
  const remote = createLeaseMockState();
  await installLeaseMocks(page, remote);
  await page.goto("http://remote.test/remote/#token=test-token");
  await connectRemote(page);
  // The capability lives in memory only while the document is alive.
  expect(await stashedResumeToken(page)).toBeNull();

  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));

  await expect.poll(() => remote.releaseRequests.length).toBe(1);
  const release = remote.releaseRequests[0];
  expect(release.body.leaseId).toBe("lease-1");
  expect(new URL(release.url).searchParams.get("token")).toBe("test-token");
  // Stashed for the successor document only across the unload boundary.
  expect(await stashedResumeToken(page)).toBe("resume-1");
});

test("a reload takes over its own zombie lease via the resume capability", async ({ page }) => {
  // The release beacon is "lost": the zombie lease stays installed and only
  // the resume capability can replace it before the heartbeat timeout.
  const remote = createLeaseMockState({ releaseClearsLease: false });
  await installLeaseMocks(page, remote);
  await page.goto("http://remote.test/remote/#token=test-token");
  await connectRemote(page);
  expect(remote.claimRequests[0].body.resumeToken).toBeUndefined();

  await page.reload();
  // The successor document consumed the stash back into memory.
  expect(await stashedResumeToken(page)).toBeNull();
  await connectRemote(page);

  expect(remote.claimRequests[1].body.resumeToken).toBe("resume-1");
  expect(remote.activeLeaseId).toBe("lease-2");
});

test("a duplicated tab cannot present the capability and the original keeps control", async ({
  page,
}) => {
  const remote = createLeaseMockState();
  await installLeaseMocks(page, remote);
  await page.goto("http://remote.test/remote/#token=test-token");
  await connectRemote(page);

  // Duplicate Tab / window.open clone the sessionStorage of the LIVE
  // original — which never holds the capability.
  const clonedStorage = await page.evaluate(() => JSON.stringify({ ...sessionStorage }));
  const duplicate = await page.context().newPage();
  await installLeaseMocks(duplicate, remote);
  await duplicate.addInitScript((snapshot: string) => {
    const entries = JSON.parse(snapshot) as Record<string, string>;
    for (const [key, value] of Object.entries(entries)) sessionStorage.setItem(key, value);
  }, clonedStorage);
  await duplicate.goto("http://remote.test/remote/#token=test-token");

  await duplicate.locator("#connect").click();
  await expect(duplicate.locator("#status")).toContainText("409");

  expect(remote.claimRequests).toHaveLength(2);
  expect(remote.claimRequests[1].body.resumeToken).toBeUndefined();
  expect(remote.activeLeaseId).toBe("lease-1");
  await expect(page.locator("#status")).toHaveText("Main · Pane 1");
  await duplicate.close();
});

test("a server-confirmed lease loss clears the capability before the next claim", async ({
  page,
}) => {
  const remote = createLeaseMockState();
  await installLeaseMocks(page, remote);
  await page.goto("http://remote.test/remote/#token=test-token");
  await connectRemote(page);

  remote.heartbeatStatus = 409;
  await expect(page.locator(".connection-hint")).toContainText("Host has control", {
    timeout: 10_000,
  });
  expect(await stashedResumeToken(page)).toBeNull();

  // Host handed control back; the reconnect must be a plain claim.
  remote.heartbeatStatus = 200;
  remote.activeLeaseId = null;
  remote.activeResumeToken = null;
  await connectRemote(page);
  const reconnectClaim = remote.claimRequests[remote.claimRequests.length - 1];
  expect(reconnectClaim.body.resumeToken).toBeUndefined();
});

test("an explicit release reconnects to the last selected workspace pane", async ({ page }) => {
  const remote = createLeaseMockState();
  await installLeaseMocks(page, remote, multiTerminalNavigation);
  await page.goto("http://remote.test/remote/#token=test-token");
  await connectRemote(page);

  await page.locator("#navToggle").click();
  await page.locator(".workspace-pane-row", { hasText: "C:\\two" }).click();
  await expect.poll(() => remote.outputTerminalIds.at(-1)).toBe("terminal-2");

  await page.locator("#navToggle").click();
  await page.locator("#release").click();
  await expect(page.locator("#connect")).toBeEnabled();
  await connectRemote(page, "Main · Pane 2");

  await expect.poll(() => remote.outputTerminalIds.at(-1)).toBe("terminal-2");
});

test("a lease-loss reconnect restores the last selected visible dock pane", async ({ page }) => {
  const remote = createLeaseMockState();
  await installLeaseMocks(page, remote, multiTerminalNavigation);
  await page.goto("http://remote.test/remote/#token=test-token");
  await connectRemote(page);

  await page.locator("#navToggle").click();
  await page.locator("#dockToggle").click();
  await page.locator(".dock-terminal-row", { hasText: "C:\\dock" }).click();
  await expect.poll(() => remote.outputTerminalIds.at(-1)).toBe("dock-terminal-1");

  remote.heartbeatStatus = 409;
  await expect(page.locator(".connection-hint")).toContainText("Host has control", {
    timeout: 10_000,
  });
  remote.heartbeatStatus = 200;
  remote.activeLeaseId = null;
  remote.activeResumeToken = null;
  await connectRemote(page, "Dock Shell");

  await expect.poll(() => remote.outputTerminalIds.at(-1)).toBe("dock-terminal-1");
});

test("a reconnect falls back when the last selected terminal is no longer live", async ({
  page,
}) => {
  const remote = createLeaseMockState();
  const changingNavigation = structuredClone(multiTerminalNavigation);
  await installLeaseMocks(page, remote, changingNavigation);
  await page.goto("http://remote.test/remote/#token=test-token");
  await connectRemote(page);

  await page.locator("#navToggle").click();
  await page.locator(".workspace-pane-row", { hasText: "C:\\two" }).click();
  await expect.poll(() => remote.outputTerminalIds.at(-1)).toBe("terminal-2");

  await page.locator("#navToggle").click();
  await page.locator("#release").click();
  changingNavigation.activeWorkspace.panes[1].terminalLive = false;
  changingNavigation.workspaces[0].panes[1].terminalLive = false;
  await connectRemote(page);

  await expect.poll(() => remote.outputTerminalIds.at(-1)).toBe("terminal-1");
});
