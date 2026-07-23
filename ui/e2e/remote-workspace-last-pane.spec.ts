import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

// Issue #508: re-entering a Remote workspace should resume the pane the user
// last stayed on in that workspace, not always snap back to the first pane.
// The Remote page owns this as a surface-local, per-workspace hint (ADR-0015,
// api-contracts §13.3). The host still exposes only a single global focused
// pane number, so this test models that global-index behavior to prove the
// per-workspace resume overrides it.

const remoteRoot = fileURLToPath(new URL("../../src-tauri/src/remote_server/", import.meta.url));

const TERMINALS = [
  { id: "term-a1", title: "A1", workspaceId: "ws-a", paneNumber: 1, appearance: {} },
  { id: "term-a2", title: "A2", workspaceId: "ws-a", paneNumber: 2, appearance: {} },
  { id: "term-b1", title: "B1", workspaceId: "ws-b", paneNumber: 1, appearance: {} },
  { id: "term-b2", title: "B2", workspaceId: "ws-b", paneNumber: 2, appearance: {} },
];

const PANES: Record<string, Array<Record<string, unknown>>> = {
  "ws-a": [
    {
      id: "pane-a1",
      paneIndex: 0,
      paneNumber: 1,
      terminalId: "term-a1",
      terminalLive: true,
      viewType: "TerminalView",
    },
    {
      id: "pane-a2",
      paneIndex: 1,
      paneNumber: 2,
      terminalId: "term-a2",
      terminalLive: true,
      viewType: "TerminalView",
    },
  ],
  "ws-b": [
    {
      id: "pane-b1",
      paneIndex: 0,
      paneNumber: 1,
      terminalId: "term-b1",
      terminalLive: true,
      viewType: "TerminalView",
    },
    {
      id: "pane-b2",
      paneIndex: 1,
      paneNumber: 2,
      terminalId: "term-b2",
      terminalLive: true,
      viewType: "TerminalView",
    },
  ],
};

const WS_NAME: Record<string, string> = { "ws-a": "Alpha", "ws-b": "Bravo" };

test.describe("remote workspace last-pane resume", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("resumes the last-stayed pane instead of the first when re-entering", async ({ page }) => {
    // Host state the mock exposes: which workspace is active and the single
    // global focused pane number (mirrors the desktop global focusedPaneIndex).
    let activeWs = "ws-a";
    let hostFocusedPaneNumber = 1;

    const openedOutputs: string[] = [];

    for (const asset of [
      [
        "http://remote.test/remote/vendor/xterm.js",
        "assets/xterm.js",
        "application/javascript; charset=utf-8",
      ],
      [
        "http://remote.test/remote/vendor/addon-fit.js",
        "assets/addon-fit.js",
        "application/javascript; charset=utf-8",
      ],
      ["http://remote.test/remote/vendor/xterm.css", "assets/xterm.css", "text/css; charset=utf-8"],
    ] as const) {
      await page.route(asset[0], (route) =>
        route.fulfill({ path: `${remoteRoot}${asset[1]}`, contentType: asset[2] }),
      );
    }
    await page.route("http://remote.test/remote/", (route) =>
      route.fulfill({ path: `${remoteRoot}page.html`, contentType: "text/html; charset=utf-8" }),
    );

    await page.route("http://remote.test/remote/v1/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/remote/v1/session/claim") {
        await route.fulfill({ json: { leaseId: "lease-1", heartbeatTimeoutSeconds: 45 } });
        return;
      }
      if (url.pathname === "/remote/v1/navigation") {
        await route.fulfill({
          json: {
            activeWorkspaceId: activeWs,
            terminals: TERMINALS,
            activeWorkspace: {
              id: activeWs,
              name: WS_NAME[activeWs],
              focusedPaneNumber: hostFocusedPaneNumber,
              panes: PANES[activeWs],
            },
            workspaces: [
              {
                id: "ws-a",
                name: "Alpha",
                isActive: activeWs === "ws-a",
                panes: activeWs === "ws-a" ? PANES["ws-a"] : [],
              },
              {
                id: "ws-b",
                name: "Bravo",
                isActive: activeWs === "ws-b",
                panes: activeWs === "ws-b" ? PANES["ws-b"] : [],
              },
            ],
            docks: [],
            notifications: [],
          },
        });
        return;
      }
      if (url.pathname === "/remote/v1/workspaces/active") {
        activeWs = (request.postDataJSON() as { id: string }).id;
        await route.fulfill({ json: { switched: activeWs } });
        return;
      }
      const focusMatch = url.pathname.match(/^\/remote\/v1\/terminals\/([^/]+)\/focus$/);
      if (focusMatch) {
        const focused = TERMINALS.find((t) => t.id === decodeURIComponent(focusMatch[1]));
        if (focused) hostFocusedPaneNumber = focused.paneNumber;
        await route.fulfill({ json: { focused: focusMatch[1] } });
        return;
      }
      await route.fulfill({ json: {} });
    });

    await page.routeWebSocket(/\/remote\/v1\/terminals\/[^/]+\/output/, (ws) => {
      const match = ws.url().match(/terminals\/([^/]+)\/output/);
      if (match) openedOutputs.push(decodeURIComponent(match[1]));
    });

    await page.goto("http://remote.test/remote/#token=test-token");
    await page.locator("#connect").click();

    // Fresh connect honors the host's focused pane (pane 1) → term-a1.
    await expect.poll(() => openedOutputs.at(-1)).toBe("term-a1");

    // Stay on pane 2 of Alpha (the "last stayed" pane we expect to resume).
    await page.locator("#navToggle").click();
    await page.locator(".workspace-item.active .workspace-pane-row").nth(1).click();
    await expect.poll(() => openedOutputs.at(-1)).toBe("term-a2");
    await expect(page.locator("#terminalMeta")).toHaveText("A2");

    // Enter Bravo (never visited → falls back to host focused pane).
    await page.locator("#navToggle").click();
    await page.locator(".workspace-item", { hasText: "Bravo" }).click();
    await expect.poll(() => activeWs).toBe("ws-b");

    // Move around inside Bravo so the host's global focused pane becomes 1.
    // Without per-workspace memory, returning to Alpha would now pick pane 1.
    await page.locator("#navToggle").click();
    await page.locator(".workspace-item.active .workspace-pane-row").nth(0).click();
    await expect.poll(() => openedOutputs.at(-1)).toBe("term-b1");

    // Re-enter Alpha: must resume the last-stayed pane (term-a2), not the
    // first pane (term-a1) that the global host focus would otherwise select.
    await page.locator("#navToggle").click();
    await page.locator(".workspace-item", { hasText: "Alpha" }).click();
    await expect.poll(() => openedOutputs.at(-1)).toBe("term-a2");
    await expect(page.locator("#terminalMeta")).toHaveText("A2");
  });

  test("falls back to the first pane for a workspace never visited on Remote", async ({ page }) => {
    let activeWs = "ws-a";
    const hostFocusedPaneNumber = 1;
    const openedOutputs: string[] = [];

    for (const asset of [
      [
        "http://remote.test/remote/vendor/xterm.js",
        "assets/xterm.js",
        "application/javascript; charset=utf-8",
      ],
      [
        "http://remote.test/remote/vendor/addon-fit.js",
        "assets/addon-fit.js",
        "application/javascript; charset=utf-8",
      ],
      ["http://remote.test/remote/vendor/xterm.css", "assets/xterm.css", "text/css; charset=utf-8"],
    ] as const) {
      await page.route(asset[0], (route) =>
        route.fulfill({ path: `${remoteRoot}${asset[1]}`, contentType: asset[2] }),
      );
    }
    await page.route("http://remote.test/remote/", (route) =>
      route.fulfill({ path: `${remoteRoot}page.html`, contentType: "text/html; charset=utf-8" }),
    );
    await page.route("http://remote.test/remote/v1/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/remote/v1/session/claim") {
        await route.fulfill({ json: { leaseId: "lease-1", heartbeatTimeoutSeconds: 45 } });
        return;
      }
      if (url.pathname === "/remote/v1/navigation") {
        await route.fulfill({
          json: {
            activeWorkspaceId: activeWs,
            terminals: TERMINALS,
            activeWorkspace: {
              id: activeWs,
              name: WS_NAME[activeWs],
              focusedPaneNumber: hostFocusedPaneNumber,
              panes: PANES[activeWs],
            },
            workspaces: [
              {
                id: "ws-a",
                name: "Alpha",
                isActive: activeWs === "ws-a",
                panes: activeWs === "ws-a" ? PANES["ws-a"] : [],
              },
              {
                id: "ws-b",
                name: "Bravo",
                isActive: activeWs === "ws-b",
                panes: activeWs === "ws-b" ? PANES["ws-b"] : [],
              },
            ],
            docks: [],
            notifications: [],
          },
        });
        return;
      }
      if (url.pathname === "/remote/v1/workspaces/active") {
        activeWs = (request.postDataJSON() as { id: string }).id;
        await route.fulfill({ json: { switched: activeWs } });
        return;
      }
      await route.fulfill({ json: {} });
    });
    await page.routeWebSocket(/\/remote\/v1\/terminals\/[^/]+\/output/, (ws) => {
      const match = ws.url().match(/terminals\/([^/]+)\/output/);
      if (match) openedOutputs.push(decodeURIComponent(match[1]));
    });

    await page.goto("http://remote.test/remote/#token=test-token");
    await page.locator("#connect").click();
    await expect.poll(() => openedOutputs.at(-1)).toBe("term-a1");

    // First-ever entry into Bravo: no per-workspace hint → host focused pane 1.
    await page.locator("#navToggle").click();
    await page.locator(".workspace-item", { hasText: "Bravo" }).click();
    await expect.poll(() => openedOutputs.at(-1)).toBe("term-b1");
    await expect(page.locator("#terminalMeta")).toHaveText("B1");
  });
});
