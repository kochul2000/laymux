import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import { installRemoteClientRoutes, remoteClientMarkupWithoutXterm } from "./remote-client-assets";

/**
 * Seed a v2 key-bar layout placing `softKeyIds` in the Keys row. Placement is
 * the only activation signal, so a test that drives a specific key has to put
 * it on the bar first.
 */
async function seedKeyBar(page: Page, softKeyIds: string[], expanded = true) {
  await page.addInitScript(
    ({ keys, open }) => {
      localStorage.setItem(
        "laymux.remote.keybar",
        JSON.stringify({
          expanded: open,
          userKeys: [],
          zones: {
            main: { left: [], center: [], right: ["keyboard", "keys", "composer"] },
            expanded: {
              left: keys.map((id: string) => `soft:${id}`),
              center: [],
              right: [],
            },
          },
        }),
      );
    },
    { keys: softKeyIds, open: expanded },
  );
}

/**
 * Serve the real remote page against a fixed navigation snapshot: active
 * workspace `ws-a` with two terminal panes (p-a1, p-a2) plus an inactive
 * `ws-b` whose pane/status summary remains visible. Spatial step requests are
 * recorded into `spatialBodies`.
 */
async function routeRemoteWithWorkspaces(
  page: Page,
  spatialBodies: Array<{ excludedPaneIds: string[]; excludedWorkspaceIds: string[] }>,
  options: {
    includeGamma?: boolean;
    initialHiddenWorkspaceIds?: string[];
  } = {},
): Promise<{
  setWorkspaceDisplay: (
    display: Partial<{
      minimap: boolean;
      environment: boolean;
      activity: boolean;
      path: boolean;
      result: boolean;
    }>,
  ) => void;
  setLastInputMode: (mode: "perPane" | "workspaceLatest") => void;
  visibilityRequests: Array<{ path: string; body: { hidden: boolean; leaseId: string } }>;
  focusRequests: Array<{ terminalId: string; body: { leaseId: string } }>;
  outputAttachments: string[];
  setVisibilityFallbackWorkspaceId: (workspaceId: string | null) => void;
  setNotifications: (notifications: Array<Record<string, unknown>>, unreadCount: number) => void;
}> {
  let workspaceDisplay = {
    minimap: false,
    environment: true,
    activity: true,
    path: true,
    result: true,
  };
  let lastInputMode: "perPane" | "workspaceLatest" = "perPane";
  const visibilityRequests: Array<{
    path: string;
    body: { hidden: boolean; leaseId: string };
  }> = [];
  const focusRequests: Array<{ terminalId: string; body: { leaseId: string } }> = [];
  const hiddenWorkspaceIds = new Set(options.initialHiddenWorkspaceIds ?? []);
  const hiddenPaneIds = new Set<string>();
  const outputAttachments: string[] = [];
  let activeWorkspaceId = "ws-a";
  let notifications: Array<Record<string, unknown>> = [];
  let unreadNotificationCount = 0;
  let visibilityFallbackWorkspaceId: string | null = null;
  const paneA1 = {
    id: "p-a1",
    paneIndex: 1,
    paneNumber: 1,
    terminalId: "term-a1",
    terminalLive: true,
    viewType: "TerminalView",
    x: 0,
    y: 0,
    w: 0.5,
    h: 1,
    selectorDisplay: { environment: "A1", lastInput: "older pane input", lastInputAt: 10 },
  };
  const paneA2 = {
    id: "p-a2",
    paneIndex: 0,
    paneNumber: 2,
    terminalId: "term-a2",
    terminalLive: true,
    viewType: "TerminalView",
    x: 0.5,
    y: 0,
    w: 0.5,
    h: 1,
    selectorDisplay: { environment: "A2", lastInput: "newest pane input", lastInputAt: 20 },
  };
  const paneB1 = {
    id: "p-b1",
    paneIndex: 0,
    paneNumber: 1,
    terminalId: "term-b1",
    terminalLive: true,
    viewType: "TerminalView",
    profile: "PowerShell",
    cwd: "C:\\Users\\kochul\\work\\beta",
    branch: "feature/beta",
    activity: { type: "running" },
    selectorStatus: { icon: "⏳", color: "var(--yellow)", text: "Building" },
    selectorDisplay: {
      environment: "PS",
      activity: { label: "running", color: "var(--yellow)" },
      cwd: "~/work/beta",
      lastInput: "npm test",
      lastInputAt: 15,
    },
  };

  await installRemoteClientRoutes(page);
  await page.route("http://remote.test/remote/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/remote/v1/session/claim") {
      await route.fulfill({ json: { leaseId: "lease-1", heartbeatTimeoutSeconds: 45 } });
      return;
    }
    if (url.pathname === "/remote/v1/navigation") {
      const paneWithVisibility = <T extends { id: string }>(pane: T) => ({
        ...pane,
        hidden: hiddenPaneIds.has(pane.id),
        collapsed: hiddenPaneIds.has(pane.id),
      });
      await route.fulfill({
        json: {
          terminals: [
            { id: "term-a1", title: "A1", workspaceId: "ws-a", paneNumber: 1, appearance: {} },
            { id: "term-a2", title: "A2", workspaceId: "ws-a", paneNumber: 2, appearance: {} },
            { id: "term-b1", title: "B1", workspaceId: "ws-b", paneNumber: 1, appearance: {} },
          ],
          activeWorkspace: {
            id: activeWorkspaceId,
            name: activeWorkspaceId === "ws-a" ? "Alpha" : "Beta",
            panes:
              activeWorkspaceId === "ws-a"
                ? [paneWithVisibility(paneA1), paneWithVisibility(paneA2)]
                : [paneWithVisibility(paneB1)],
          },
          workspaces: [
            {
              id: "ws-a",
              name: "Alpha",
              isActive: activeWorkspaceId === "ws-a",
              terminalPaneCount: 2,
              selectorSummary: { terminalCount: 2, lastCommand: null, latestNotification: null },
              hidden: hiddenWorkspaceIds.has("ws-a"),
              collapsed: hiddenWorkspaceIds.has("ws-a"),
              panes: [paneWithVisibility(paneA1), paneWithVisibility(paneA2)],
            },
            {
              id: "ws-b",
              name: "Beta",
              isActive: activeWorkspaceId === "ws-b",
              terminalPaneCount: 1,
              selectorSummary: {
                terminalCount: 1,
                lastCommand: {
                  command: "npm test",
                  timestamp: Date.now(),
                  status: { icon: "✓", color: "var(--green)" },
                },
                latestNotification: null,
              },
              hidden: hiddenWorkspaceIds.has("ws-b"),
              collapsed: hiddenWorkspaceIds.has("ws-b"),
              panes: [paneWithVisibility(paneB1)],
            },
            ...(options.includeGamma
              ? [
                  {
                    id: "ws-c",
                    name: "Gamma",
                    isActive: false,
                    terminalPaneCount: 0,
                    selectorSummary: {
                      terminalCount: 0,
                      lastCommand: null,
                      latestNotification: null,
                    },
                    hidden: hiddenWorkspaceIds.has("ws-c"),
                    collapsed: hiddenWorkspaceIds.has("ws-c"),
                    panes: [],
                  },
                ]
              : []),
          ],
          docks: [],
          notifications,
          unreadNotificationCount,
          workspaceSelector: {
            display: workspaceDisplay,
            pathEllipsis: "start",
            lastInputMode,
          },
        },
      });
      return;
    }
    const workspaceVisibilityMatch = url.pathname.match(
      /^\/remote\/v1\/workspaces\/([^/]+)\/visibility$/,
    );
    const paneVisibilityMatch = url.pathname.match(/^\/remote\/v1\/panes\/([^/]+)\/visibility$/);
    if (workspaceVisibilityMatch || paneVisibilityMatch) {
      const body = route.request().postDataJSON() as { hidden: boolean; leaseId: string };
      visibilityRequests.push({ path: url.pathname, body });
      const target = workspaceVisibilityMatch ? hiddenWorkspaceIds : hiddenPaneIds;
      const id = decodeURIComponent((workspaceVisibilityMatch || paneVisibilityMatch)![1]);
      if (body.hidden) target.add(id);
      else target.delete(id);
      await route.fulfill({
        json: {
          success: true,
          data: { hidden: body.hidden, fallbackWorkspaceId: visibilityFallbackWorkspaceId },
        },
      });
      return;
    }
    const focusMatch = url.pathname.match(/^\/remote\/v1\/terminals\/([^/]+)\/focus$/);
    if (focusMatch) {
      const terminalId = decodeURIComponent(focusMatch[1]);
      focusRequests.push({
        terminalId,
        body: route.request().postDataJSON() as { leaseId: string },
      });
      activeWorkspaceId = terminalId === "term-b1" ? "ws-b" : "ws-a";
      await route.fulfill({ json: { focused: terminalId } });
      return;
    }
    if (url.pathname === "/remote/v1/navigation/spatial") {
      spatialBodies.push(route.request().postDataJSON());
      await route.fulfill({ json: { moved: false, reason: "no_other_target" } });
      return;
    }
    await route.fulfill({ json: {} });
  });
  await page.routeWebSocket(/\/remote\/v1\/terminals\/term-[ab][12]\/output/, (socket) => {
    const match = socket.url().match(/terminals\/([^/]+)\/output/);
    if (match) outputAttachments.push(decodeURIComponent(match[1]));
  });
  return {
    outputAttachments,
    focusRequests,
    visibilityRequests,
    setVisibilityFallbackWorkspaceId(workspaceId) {
      visibilityFallbackWorkspaceId = workspaceId;
    },
    setNotifications(nextNotifications, unreadCount) {
      notifications = nextNotifications;
      unreadNotificationCount = unreadCount;
    },
    setWorkspaceDisplay(display) {
      workspaceDisplay = { ...workspaceDisplay, ...display };
    },
    setLastInputMode(mode) {
      lastInputMode = mode;
    },
  };
}

test.describe("remote mobile layout", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.setContent(remoteClientMarkupWithoutXterm({ script: false }));
  });

  test("keeps the hidden-key footer compact", async ({ page }) => {
    const footer = page.locator("footer");
    const terminalMeta = page.locator("#terminalMeta");

    await expect(page.locator("#keyBar")).toBeHidden();
    await expect(terminalMeta).toHaveClass("sr-only");
    await expect(footer.locator(":scope > #terminalMeta")).toHaveCount(0);
    expect((await footer.boundingBox())?.height).toBeLessThan(50);
    const footerButtons = await footer.locator("button:not([hidden])").evaluateAll((buttons) =>
      buttons.map((button) => ({
        width: button.getBoundingClientRect().width,
        minWidth: getComputedStyle(button).minWidth,
      })),
    );
    // Without the client script only the statically-marked-up right segment
    // shows: Keyboard and Keys.
    expect(footerButtons).toHaveLength(2);
    const widths = footerButtons.map(({ width }) => width);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(0.1);
    expect(footerButtons.every(({ minWidth }) => minWidth === "54px")).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);

    await page.setViewportSize({ width: 180, height: 844 });
    const narrowFooter = await footer.locator("#mainActionRow").evaluate((element) => ({
      clientWidth: element.clientWidth,
      buttonWidths: Array.from(
        element.querySelectorAll("button:not([hidden])"),
        (button) => button.getBoundingClientRect().width,
      ),
    }));
    expect(
      Math.max(...narrowFooter.buttonWidths) - Math.min(...narrowFooter.buttonWidths),
    ).toBeLessThan(0.1);
    // Whatever the row does internally, the document never scrolls sideways.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(180);
  });

  test("keeps terminal metadata out of the footer in wide landscape", async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 390 });

    await expect(page.locator("#mainActionRow")).toBeVisible();
    await expect(page.locator("footer > #terminalMeta")).toHaveCount(0);
    const terminalMeta = page.locator("#terminalMeta");
    await expect(terminalMeta).not.toHaveAttribute("role", "status");
    await expect(terminalMeta).not.toHaveAttribute("aria-live", /.+/);
    const terminalMetaStyle = await terminalMeta.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        position: style.position,
        width: style.width,
        height: style.height,
        clip: style.clip,
      };
    });
    expect(terminalMetaStyle).toEqual({
      position: "absolute",
      width: "1px",
      height: "1px",
      clip: "rect(0px, 0px, 0px, 0px)",
    });
  });

  test("confines horizontal scrolling to the soft-key row", async ({ page }) => {
    await page.locator('#keyRow > [data-segment="left"]').evaluate((row) => {
      for (const label of [
        "Esc",
        "Tab",
        "Shift+Tab",
        "Up",
        "Down",
        "Left",
        "Right",
        "Home",
        "End",
      ]) {
        const button = document.createElement("button");
        button.className = "key-btn";
        button.textContent = label;
        row.append(button);
      }
    });
    await page.locator("#keyBar").evaluate((bar) => {
      bar.hidden = false;
    });

    const keyRow = page.locator("#keyRow");
    const overflow = await keyRow.evaluate((row) => ({
      clientWidth: row.clientWidth,
      scrollWidth: row.scrollWidth,
      overflowX: getComputedStyle(row).overflowX,
      scrollbarWidth: getComputedStyle(row).scrollbarWidth,
      webkitScrollbarDisplay: getComputedStyle(row, "::-webkit-scrollbar").display,
      settingsInsideRow: row.querySelector("#keyBarSettings") !== null,
      buttonRows: new Set(
        Array.from(row.querySelectorAll(".key-btn"), (child) => (child as HTMLElement).offsetTop),
      ).size,
    }));

    expect(overflow.scrollWidth).toBeGreaterThan(overflow.clientWidth);
    expect(overflow.overflowX).toBe("auto");
    expect(overflow.scrollbarWidth).toBe("none");
    expect(overflow.webkitScrollbarDisplay).toBe("none");
    expect(overflow.settingsInsideRow).toBe(false);
    expect(overflow.buttonRows).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);

    await expect(page.locator("#drawerSettingsButton")).toHaveCount(1);
  });

  test("keeps the key-bar height stable across empty and populated states", async ({ page }) => {
    const keyBar = page.locator("#keyBar");
    const keyRow = page.locator('#keyRow > [data-segment="left"]');
    await keyBar.evaluate((bar) => {
      bar.hidden = false;
    });

    const settingsOnlyHeight = (await keyBar.boundingBox())?.height;

    await keyRow.evaluate((row) => {
      const empty = document.createElement("div");
      empty.className = "key-row-empty";
      empty.textContent = "No keys selected";
      row.append(empty);
    });
    const emptyMessageHeight = (await keyBar.boundingBox())?.height;

    await keyRow.evaluate((row) => {
      row.querySelector(".key-row-empty")?.remove();
      const button = document.createElement("button");
      button.className = "key-btn";
      button.textContent = "Esc";
      row.append(button);
    });
    const populatedHeight = (await keyBar.boundingBox())?.height;

    expect(settingsOnlyHeight).toBe(emptyMessageHeight);
    expect(emptyMessageHeight).toBe(populatedHeight);
  });

  test("step navigation keys render inside the soft-key toolbar", async ({ page }) => {
    await page.route("http://remote.test/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>remote test</title>",
      }),
    );
    await seedKeyBar(page, ["navPad", "navPrev", "navNext", "notifRecent", "notifOldest"], false);
    await page.goto("http://remote.test/");
    await page.setContent(remoteClientMarkupWithoutXterm());
    await page.locator("#keyBarToggle").click();

    // No dedicated bar row — the keys live in the toggleable key bar.
    await expect(page.locator("#navStepBar")).toHaveCount(0);

    // The flick pad ships placed by default; the individual step keys are
    // placed here because placement is what activates a key.
    const navPad = page.locator('[data-key="navPad"]');
    await expect(navPad).toHaveCount(1);
    await expect(navPad).toHaveAttribute(
      "aria-label",
      "Flick to navigate: up/down previous/next pane, left/right recent/oldest alert",
    );
    await expect(page.locator('[data-key="navPrev"]')).toHaveText("P↑");
    await expect(page.locator('[data-key="navNext"]')).toHaveText("P↓");
    await expect(page.locator('[data-key="notifRecent"]')).toHaveText("N←");
    await expect(page.locator('[data-key="notifOldest"]')).toHaveText("N→");

    // Disconnected: nav keys are disabled like the rest of the toolbar.
    await expect(page.locator('[data-key="navPrev"]')).toBeDisabled();

    // The toolbar stays a single compact row — the reason the dedicated bar
    // was dropped (it was too thick).
    const barHeight = (await page.locator("#keyBar").boundingBox())?.height;
    expect(barHeight).toBeLessThan(50);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  });

  test("highlights the pane identity in a minimap when display order differs", async ({ page }) => {
    const spatialBodies: Array<{ excludedPaneIds: string[]; excludedWorkspaceIds: string[] }> = [];
    const controls = await routeRemoteWithWorkspaces(page, spatialBodies);
    controls.setWorkspaceDisplay({ minimap: true });

    await page.goto("http://remote.test/remote/#token=test-token");
    await page.locator("#connect").click();
    await page.locator("#navToggle").click();

    const alpha = page.locator(".workspace-item", { hasText: "Alpha" });
    const a1Row = alpha.locator(".workspace-pane-row", { hasText: "A1" });
    await expect(a1Row.locator('.pane-minimap rect[fill="var(--accent)"]')).toHaveAttribute(
      "x",
      "0",
    );
  });

  test("opens workspace navigation by default and keeps secondary tools on separate drawer pages", async ({
    page,
  }) => {
    const spatialBodies: Array<{ excludedPaneIds: string[]; excludedWorkspaceIds: string[] }> = [];
    await routeRemoteWithWorkspaces(page, spatialBodies);

    await page.goto("http://remote.test/remote/#token=test-token");

    // Before a lease exists, the open drawer takes the user straight to the
    // only actionable page: Connection.
    await expect(page.locator(".app")).toHaveClass(/nav-open/);
    await expect(page.locator("#drawerConnectionView")).toBeVisible();
    await expect(page.locator("#drawerWorkspaceView")).toBeHidden();

    // Device-local settings remain reachable before a lease exists.
    await page.locator("#drawerBack").click();
    await page.locator("#drawerSettingsButton").click();
    await expect(page.locator("#drawerBack")).toBeFocused();
    await expect(page.locator("#widgetStripToggle")).toBeEnabled();
    await page.locator("#drawerBack").click();
    await expect(page.locator("#drawerSettingsButton")).toBeFocused();
    await page.locator("#drawerConnectionButton").click();
    await expect(page.locator("#drawerBack")).toBeFocused();

    await page.locator("#connect").click();
    await expect(page.locator(".app")).not.toHaveClass(/nav-open/);

    // A connected drawer always reopens on the unchanged workspace home.
    await page.locator("#navToggle").click();
    await expect(page.locator("#drawerWorkspaceView")).toBeVisible();
    await expect(page.locator("#workspaceSection")).toBeVisible();
    await expect(page.locator("#drawerHiddenView")).toBeHidden();
    await expect(page.locator("#workspaceSection .nav-section-title")).toHaveCount(0);
    await expect(page.locator("#notificationSection")).toBeHidden();
    await expect(page.locator("#drawerConnectionView")).toBeHidden();
    await expect(page.locator("#drawerSettingsView")).toBeHidden();
    await expect(page.locator("#navClose")).toHaveCount(0);
    await expect(page.locator(".drawer-header")).toHaveCSS("height", "32px");

    await page.locator("#drawerNotificationsButton").click();
    await expect(page.locator("#drawerBack")).toBeFocused();
    await expect(page.locator("#drawerNotificationsView")).toBeVisible();
    await expect(page.locator("#notificationSection")).toBeVisible();
    await expect(page.locator("#drawerTitle")).toHaveText("Notifications");
    await page.locator("#drawerBack").click();
    await expect(page.locator("#drawerNotificationsButton")).toBeFocused();

    await page.locator("#drawerSettingsButton").click();
    await expect(page.locator("#drawerBack")).toBeFocused();
    await expect(page.locator("#drawerSettingsView")).toBeVisible();
    await expect(page.locator("#displaySection")).toBeVisible();
    await expect(page.locator("#drawerWorkspaceView")).toBeHidden();

    await page.locator("#drawerBack").click();
    await expect(page.locator("#drawerSettingsButton")).toBeFocused();
    await expect(page.locator("#drawerWorkspaceView")).toBeVisible();

    await page.locator("#drawerConnectionButton").click();
    await expect(page.locator("#drawerBack")).toBeFocused();
    await expect(page.locator("#drawerConnectionView")).toBeVisible();
    await expect(page.locator(".connection-panel")).toBeVisible();

    await page.locator("#navToggle").click();
    await page.locator("#navToggle").click();
    await expect(page.locator("#drawerWorkspaceView")).toBeVisible();
  });

  test("excludes the current workspace pane from spatial navigation in the Remote header", async ({
    page,
  }) => {
    const spatialBodies: Array<{ leaseId: string; direction: string; excludedPaneIds: string[] }> =
      [];
    const pane = {
      id: "pane-a",
      paneIndex: 0,
      paneNumber: 1,
      terminalId: "term-a",
      terminalLive: true,
      viewType: "TerminalView",
    };
    let workspacePaneActive = true;

    await installRemoteClientRoutes(page);
    await page.route("http://remote.test/remote/v1/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/remote/v1/session/claim") {
        await route.fulfill({ json: { leaseId: "lease-1", heartbeatTimeoutSeconds: 45 } });
        return;
      }
      if (url.pathname === "/remote/v1/navigation") {
        await route.fulfill({
          json: {
            terminals: [
              {
                id: "term-a",
                title: "Shell",
                workspaceId: "ws-a",
                paneNumber: 1,
                appearance: {},
              },
            ],
            activeWorkspace: {
              id: "ws-a",
              name: "Alpha",
              panes: workspacePaneActive ? [pane] : [],
            },
            workspaces: [
              {
                id: "ws-a",
                name: "Alpha",
                isActive: true,
                panes: workspacePaneActive ? [pane] : [],
              },
            ],
            docks: workspacePaneActive
              ? []
              : [
                  {
                    position: "left",
                    visible: true,
                    panes: [{ ...pane, id: "dock-a", workspaceId: null, location: "dock" }],
                  },
                ],
            notifications: [],
          },
        });
        return;
      }
      if (url.pathname === "/remote/v1/navigation/spatial") {
        spatialBodies.push(route.request().postDataJSON());
        await route.fulfill({ json: { moved: false, reason: "no_other_target" } });
        return;
      }
      await route.fulfill({ json: {} });
    });
    await page.routeWebSocket(/\/remote\/v1\/terminals\/term-a\/output/, () => {});

    await seedKeyBar(page, ["navPrev", "navNext"], false);
    await page.goto("http://remote.test/remote/#token=test-token");
    await page.locator("#connect").click();

    const exclusion = page.locator("#spatialExclusion");
    await expect(exclusion).toBeVisible();
    await expect(exclusion.locator('svg[data-remote-icon-name="CircleMinus"]')).toHaveCount(1);
    await expect(exclusion).toHaveAttribute("aria-pressed", "false");
    await expect(exclusion).toHaveAttribute("aria-label", "Exclude this pane from pane navigation");

    await page.locator("#keyBarToggle").click();
    const [exclusionBox, composerToggleBox] = await Promise.all([
      exclusion.boundingBox(),
      page.locator("#inputModeToggle").boundingBox(),
    ]);
    expect(exclusionBox).not.toBeNull();
    expect(composerToggleBox).not.toBeNull();
    expect(exclusionBox!.height).toBe(26);
    expect(composerToggleBox!.height).toBe(26);

    await page.locator('[data-key="navNext"]').click();
    await expect.poll(() => spatialBodies.length).toBe(1);
    expect(spatialBodies[0].excludedPaneIds).toEqual([]);

    await exclusion.click();
    await expect(exclusion).toHaveAttribute("aria-pressed", "true");
    await expect(exclusion).toHaveAttribute("aria-label", "Include this pane in pane navigation");
    await expect
      .poll(() =>
        page.evaluate(() =>
          JSON.parse(localStorage.getItem("laymux.remote.spatialExcludedPaneIds") || "[]"),
        ),
      )
      .toEqual(["pane-a"]);

    await page.locator('[data-key="navNext"]').click();
    await expect.poll(() => spatialBodies.length).toBe(2);
    expect(spatialBodies[1].excludedPaneIds).toEqual(["pane-a"]);

    await exclusion.click();
    await expect(exclusion).toHaveAttribute("aria-pressed", "false");

    workspacePaneActive = false;
    await page.locator("#refresh").evaluate((button: HTMLButtonElement) => button.click());
    await expect(exclusion).toBeHidden();
  });

  test("skips a whole workspace from the drawer and carries it into spatial navigation", async ({
    page,
  }) => {
    const spatialBodies: Array<{ excludedPaneIds: string[]; excludedWorkspaceIds: string[] }> = [];
    await routeRemoteWithWorkspaces(page, spatialBodies);

    await seedKeyBar(page, ["navPrev", "navNext"], false);
    await page.goto("http://remote.test/remote/#token=test-token");
    await page.locator("#connect").click();
    await page.locator("#navToggle").click();

    // Every workspace with terminal panes shows the same circle-minus skip icon.
    const skipB = page.locator('[data-workspace-skip="ws-b"]');
    await expect(skipB).toBeVisible();
    await expect(skipB.locator('svg[data-remote-icon-name="CircleMinus"]')).toHaveCount(1);
    await expect(skipB).toHaveAttribute("aria-pressed", "false");

    await skipB.click();
    await expect(skipB).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(() =>
        page.evaluate(() =>
          JSON.parse(localStorage.getItem("laymux.remote.spatialExcludedWorkspaceIds") || "[]"),
        ),
      )
      .toEqual(["ws-b"]);
    await expect
      .poll(() =>
        page.evaluate(() =>
          JSON.parse(localStorage.getItem("laymux.remote.spatialExcludedPaneIds") || "[]"),
        ),
      )
      .toEqual(["p-b1"]);

    // The spatial step request now carries the workspace denylist.
    await page.locator("#navToggle").click();
    await page.locator("#keyBarToggle").click();
    await page.locator('[data-key="navNext"]').click();
    await expect.poll(() => spatialBodies.length).toBe(1);
    expect(spatialBodies[0].excludedWorkspaceIds).toEqual(["ws-b"]);

    // Every workspace now exposes pane ids. Skipping the active workspace adds
    // its panes alongside the already skipped inactive pane.
    await page.locator("#navToggle").click();
    const skipA = page.locator('[data-workspace-skip="ws-a"]');
    await skipA.click();
    await expect(skipA).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(() =>
        page.evaluate(() =>
          JSON.parse(localStorage.getItem("laymux.remote.spatialExcludedPaneIds") || "[]"),
        ),
      )
      .toEqual(["p-a1", "p-a2", "p-b1"]);
    await expect(page.locator("#spatialExclusion")).toHaveAttribute("aria-pressed", "true");

    await skipA.click();
    await expect(skipA).toHaveAttribute("aria-pressed", "false");
    await expect
      .poll(() =>
        page.evaluate(() =>
          JSON.parse(localStorage.getItem("laymux.remote.spatialExcludedPaneIds") || "[]"),
        ),
      )
      .toEqual(["p-b1"]);
    await expect(page.locator("#spatialExclusion")).toHaveAttribute("aria-pressed", "false");
  });

  test("shows inactive pane status and last input without a bottom aggregate row", async ({
    page,
  }) => {
    const spatialBodies: Array<{ excludedPaneIds: string[]; excludedWorkspaceIds: string[] }> = [];
    await routeRemoteWithWorkspaces(page, spatialBodies);

    await page.goto("http://remote.test/remote/#token=test-token");
    await page.locator("#connect").click();
    await page.locator("#navToggle").click();

    const beta = page.locator(".workspace-item", { hasText: "Beta" });
    await expect(beta.locator(".workspace-pane-row")).toHaveCount(1);
    await expect(beta.locator(".pane-env")).toHaveText("PS");
    await expect(beta.locator(".pane-activity")).toHaveText("running");
    await expect(beta.locator(".pane-path")).toHaveText("~/work/beta");
    const commandStatus = beta.getByRole("img", { name: "Building" });
    await expect(commandStatus).toHaveCount(1);
    await expect(commandStatus.locator('svg[data-remote-icon-name="Hourglass"]')).toHaveCount(1);
    await expect(beta.locator(".pane-last-input")).toHaveText("npm test");
    await expect(beta.locator(".workspace-status-line")).toHaveCount(0);
  });

  test("enters the exact pane tapped in an inactive workspace", async ({ page }) => {
    const spatialBodies: Array<{ excludedPaneIds: string[]; excludedWorkspaceIds: string[] }> = [];
    const controls = await routeRemoteWithWorkspaces(page, spatialBodies);
    controls.setWorkspaceDisplay({
      minimap: true,
      environment: false,
      activity: false,
      path: false,
      result: false,
    });
    controls.setLastInputMode("workspaceLatest");

    await page.goto("http://remote.test/remote/#token=test-token");
    await page.locator("#connect").click();
    await expect.poll(() => controls.outputAttachments.at(-1)).toBe("term-a1");
    await page.locator("#navToggle").click();

    const betaPane = page.locator('[data-workspace-item="ws-b"] [data-pane-row="p-b1"]');
    await expect(betaPane).toHaveJSProperty("tagName", "BUTTON");
    await expect(betaPane).toHaveAccessibleName("Open Beta, pane 1, PowerShell");
    await betaPane.click();

    await expect
      .poll(() => controls.focusRequests.at(-1))
      .toEqual({
        terminalId: "term-b1",
        body: { leaseId: "lease-1" },
      });
    await expect.poll(() => controls.outputAttachments.at(-1)).toBe("term-b1");
  });

  test("uses compact pane rows and one newest input line in workspaceLatest mode", async ({
    page,
  }) => {
    const spatialBodies: Array<{ excludedPaneIds: string[]; excludedWorkspaceIds: string[] }> = [];
    const controls = await routeRemoteWithWorkspaces(page, spatialBodies);
    controls.setLastInputMode("workspaceLatest");

    await page.goto("http://remote.test/remote/#token=test-token");
    await page.locator("#connect").click();
    await page.locator("#navToggle").click();

    const alpha = page.locator(".workspace-item", { hasText: "Alpha" });
    await expect(alpha.locator(".pane-last-input")).toHaveCount(0);
    await expect(alpha.locator(".workspace-pane-row.compact")).toHaveCount(2);
    await expect(alpha.locator(".workspace-last-input")).toHaveText("newest pane input");
    expect((await alpha.locator(".workspace-pane-row.compact").first().boundingBox())?.height).toBe(
      18,
    );

    await alpha.locator('[data-pane-visibility="p-a2"]').click();
    await expect(alpha.locator(".workspace-last-input")).toHaveText("older pane input");
  });

  test("opens hidden workspaces as a drawer page and mirrors pane eye controls", async ({
    page,
  }) => {
    const spatialBodies: Array<{ excludedPaneIds: string[]; excludedWorkspaceIds: string[] }> = [];
    const controls = await routeRemoteWithWorkspaces(page, spatialBodies);

    await page.goto("http://remote.test/remote/#token=test-token");
    await page.locator("#connect").click();
    await page.locator("#navToggle").click();

    await expect(page.locator("#workspaceSection > .workspace-section-heading")).toHaveCount(0);
    await expect(page.locator(".drawer-header-actions > #hiddenWorkspaceToggle")).toBeAttached();
    await expect(page.locator("#hiddenWorkspaceToggle")).toBeHidden();
    await page.locator('[data-workspace-visibility="ws-b"]').click();
    await expect(page.locator('[data-workspace-item="ws-b"]')).toHaveCount(0);
    await expect(page.locator("#hiddenWorkspaceToggle")).toBeVisible();
    await expect(page.locator("#hiddenWorkspaceToggle svg")).toHaveCount(1);
    await expect(page.locator("#hiddenWorkspaceBadge")).toHaveCount(0);
    await expect(page.locator("#hiddenWorkspaceToggle")).toHaveClass(/status-indicator/);
    await expect(page.locator("#hiddenWorkspaceToggle")).toHaveAttribute(
      "aria-label",
      "Open hidden workspaces (1)",
    );
    await expect(page.locator("#hiddenWorkspaceToggle")).toHaveAttribute(
      "title",
      "Open hidden workspaces (1)",
    );

    // Keep the worst-case header compact at the repo's narrowest mobile
    // viewport: local-app mode also exposes the PC button.
    await page.locator("#desktopModeDrawer").evaluate((button) => {
      button.hidden = false;
    });
    await page.setViewportSize({ width: 180, height: 844 });
    await expect(page.locator("#drawerTitle")).toBeHidden();
    const narrowHeader = await page.locator(".drawer-header").evaluate((header) => {
      const actions = header.querySelector<HTMLElement>(".drawer-header-actions");
      if (!actions) throw new Error("drawer header actions are missing");
      const headerRect = header.getBoundingClientRect();
      const actionRect = actions.getBoundingClientRect();
      return {
        actionLeft: actionRect.left,
        actionRight: actionRect.right,
        headerClientWidth: header.clientWidth,
        headerLeft: headerRect.left,
        headerRight: headerRect.right,
        headerScrollWidth: header.scrollWidth,
      };
    });
    expect(narrowHeader.headerScrollWidth).toBe(narrowHeader.headerClientWidth);
    expect(narrowHeader.actionLeft).toBeGreaterThanOrEqual(narrowHeader.headerLeft);
    expect(narrowHeader.actionRight).toBeLessThanOrEqual(narrowHeader.headerRight);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(180);
    expect(controls.visibilityRequests.at(-1)).toEqual({
      path: "/remote/v1/workspaces/ws-b/visibility",
      body: { hidden: true, leaseId: "lease-1" },
    });

    await page.locator("#hiddenWorkspaceToggle").click();
    await expect(page.locator("#drawerHiddenView")).toBeVisible();
    await expect(page.locator("#drawerWorkspaceView")).toBeHidden();
    await expect(page.locator("#drawerTitle")).toHaveText("Hidden workspaces");
    await expect(page.locator("#drawerBack")).toBeFocused();
    await expect(page.locator("#hiddenWorkspaceShelf")).toBeVisible();
    await expect(page.locator('[data-hidden-workspace="ws-b"]')).toContainText("Beta");

    await page.locator("#drawerBack").click();
    await expect(page.locator("#drawerWorkspaceView")).toBeVisible();
    await expect(page.locator("#hiddenWorkspaceToggle")).toBeFocused();
    await page.locator("#hiddenWorkspaceToggle").click();
    await page.locator('[data-hidden-workspace-restore="ws-b"]').click();
    await expect(page.locator('[data-workspace-item="ws-b"]')).toBeVisible();
    await expect(page.locator("#hiddenWorkspaceToggle")).toBeHidden();
    await expect(page.locator("#drawerWorkspaceView")).toBeVisible();

    const paneToggle = page.locator('[data-pane-visibility="p-a2"]');
    await paneToggle.click();
    await expect(page.locator('[data-pane-row="p-a2"]')).toHaveClass(/hidden-item/);
    await expect(paneToggle).toHaveAttribute("aria-pressed", "true");
    expect(controls.visibilityRequests.at(-1)).toEqual({
      path: "/remote/v1/panes/p-a2/visibility",
      body: { hidden: true, leaseId: "lease-1" },
    });

    await paneToggle.click();
    await expect(page.locator('[data-pane-row="p-a2"]')).not.toHaveClass(/hidden-item/);
    await expect(paneToggle).toHaveAttribute("aria-pressed", "false");
  });

  test("keeps keyboard focus after partial and final hidden workspace restores", async ({
    page,
  }) => {
    const spatialBodies: Array<{ excludedPaneIds: string[]; excludedWorkspaceIds: string[] }> = [];
    await routeRemoteWithWorkspaces(page, spatialBodies, {
      includeGamma: true,
      initialHiddenWorkspaceIds: ["ws-b", "ws-c"],
    });

    await page.goto("http://remote.test/remote/#token=test-token");
    await page.locator("#connect").click();
    await page.locator("#navToggle").click();
    await page.locator("#hiddenWorkspaceToggle").click();

    await page.locator('[data-hidden-workspace-restore="ws-b"]').click();
    await expect(page.locator('[data-hidden-workspace-restore="ws-c"]')).toBeFocused();

    await page.locator('[data-hidden-workspace-restore="ws-c"]').click();
    await expect(page.locator("#drawerWorkspaceView")).toBeVisible();
    await expect(page.locator('[data-workspace-visibility="ws-c"]')).toBeFocused();
  });

  test("uses settings-sized dots for hidden and notification status", async ({ page }) => {
    const spatialBodies: Array<{ excludedPaneIds: string[]; excludedWorkspaceIds: string[] }> = [];
    const controls = await routeRemoteWithWorkspaces(page, spatialBodies);
    controls.setNotifications(
      [
        {
          id: "notice-1",
          workspaceId: "ws-a",
          workspaceName: "Alpha",
          terminalId: "term-a1",
          message: "Ready",
          level: "success",
          isRead: false,
          createdAt: Date.now(),
        },
      ],
      1,
    );

    await page.goto("http://remote.test/remote/#token=test-token");
    await page.locator("#connect").click();
    await page.locator("#navToggle").click();
    await page.locator('[data-workspace-visibility="ws-b"]').click();

    await expect(page.locator("#hiddenWorkspaceToggle")).toBeVisible();
    await expect(page.locator("#hiddenWorkspaceToggle")).toHaveClass(/status-indicator/);
    await expect(page.locator("#notificationBadge")).toHaveCount(0);
    await expect(page.locator("#drawerNotificationsButton")).toHaveClass(/status-indicator/);
    await expect(page.locator("#drawerNotificationsButton")).toHaveAttribute(
      "aria-label",
      "Open notifications (1 unread)",
    );

    const dotStyles = await page.evaluate(() => {
      const settings = document.querySelector<HTMLElement>("#drawerSettingsButton");
      const hidden = document.querySelector<HTMLElement>("#hiddenWorkspaceToggle");
      const notifications = document.querySelector<HTMLElement>("#drawerNotificationsButton");
      if (!settings || !hidden || !notifications) throw new Error("drawer controls are missing");
      settings.classList.add("update-available");
      const readDot = (element: HTMLElement) => {
        const style = getComputedStyle(element, "::after");
        return {
          width: style.width,
          height: style.height,
          right: style.right,
          top: style.top,
          background: style.backgroundColor,
        };
      };
      return {
        settings: readDot(settings),
        hidden: readDot(hidden),
        notifications: readDot(notifications),
        hiddenColor: getComputedStyle(hidden).color,
        notificationColor: getComputedStyle(notifications).color,
      };
    });
    expect(dotStyles.hidden).toEqual(dotStyles.settings);
    expect(dotStyles.notifications).toEqual(dotStyles.settings);
    expect(dotStyles.hidden.width).toBe("5px");
    expect(dotStyles.hidden.height).toBe("5px");
    expect(dotStyles.hiddenColor).toBe(dotStyles.notificationColor);

    controls.setNotifications([], 0);
    await expect(page.locator("#drawerNotificationsButton")).not.toHaveClass(/status-indicator/);
    await expect(page.locator("#drawerNotificationsButton")).toHaveAttribute(
      "aria-label",
      "Open notifications",
    );
  });

  test("reattaches output when the host hides an active workspace beyond a stale snapshot", async ({
    page,
  }) => {
    const spatialBodies: Array<{ excludedPaneIds: string[]; excludedWorkspaceIds: string[] }> = [];
    const controls = await routeRemoteWithWorkspaces(page, spatialBodies);

    await page.goto("http://remote.test/remote/#token=test-token");
    await page.locator("#connect").click();
    await expect.poll(() => controls.outputAttachments).toEqual(["term-a1"]);
    await page.locator("#navToggle").click();

    // The rendered snapshot still says Beta is inactive, but the host changed
    // active workspace before processing the hide. The bridge response is the
    // authoritative proof that fallback moved the active output.
    controls.setVisibilityFallbackWorkspaceId("ws-a");
    await page.locator('[data-workspace-visibility="ws-b"]').click();

    await expect.poll(() => controls.outputAttachments).toEqual(["term-a1", "term-a1"]);
  });

  test("follows changing PC selector display settings while the drawer stays open", async ({
    page,
  }) => {
    const spatialBodies: Array<{ excludedPaneIds: string[]; excludedWorkspaceIds: string[] }> = [];
    const controls = await routeRemoteWithWorkspaces(page, spatialBodies);

    await page.goto("http://remote.test/remote/#token=test-token");
    await page.locator("#connect").click();
    await page.locator("#navToggle").click();

    const beta = page.locator(".workspace-item", { hasText: "Beta" });
    await expect(beta.locator(".pane-activity")).toHaveText("running");
    await expect(
      beta.locator('.pane-command-status svg[data-remote-icon-name="Hourglass"]'),
    ).toHaveCount(1);

    controls.setWorkspaceDisplay({ activity: false, result: false });
    await expect(beta.locator(".pane-activity")).toHaveCount(0, { timeout: 5000 });
    await expect(beta.locator(".pane-command-status")).toHaveCount(0);
  });

  test("promotes a workspace to skipped once its every pane is excluded", async ({ page }) => {
    const spatialBodies: Array<{ excludedPaneIds: string[]; excludedWorkspaceIds: string[] }> = [];
    await routeRemoteWithWorkspaces(page, spatialBodies);
    // Pre-exclude the second pane so excluding the active pane completes the set.
    await page.addInitScript(() => {
      localStorage.setItem("laymux.remote.spatialExcludedPaneIds", JSON.stringify(["p-a2"]));
    });

    await page.goto("http://remote.test/remote/#token=test-token");
    await page.locator("#connect").click();

    // ws-a is not yet fully excluded — its workspace toggle is unpressed.
    await page.locator("#navToggle").click();
    const skipA = page.locator('[data-workspace-skip="ws-a"]');
    await expect(skipA).toHaveAttribute("aria-pressed", "false");
    await page.locator("#navToggle").click();

    // Exclude the active pane (p-a1) via the header — now every pane of ws-a is
    // excluded, so the workspace auto-promotes to skipped.
    const exclusion = page.locator("#spatialExclusion");
    await exclusion.click();
    await expect(exclusion).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(() =>
        page.evaluate(() =>
          JSON.parse(localStorage.getItem("laymux.remote.spatialExcludedWorkspaceIds") || "[]"),
        ),
      )
      .toEqual(["ws-a"]);
    await page.locator("#navToggle").click();
    await expect(skipA).toHaveAttribute("aria-pressed", "true");

    // Re-including one pane demotes the workspace back out of the skip set.
    await page.locator("#navToggle").click();
    await exclusion.click();
    await expect(exclusion).toHaveAttribute("aria-pressed", "false");
    await expect
      .poll(() =>
        page.evaluate(() =>
          JSON.parse(localStorage.getItem("laymux.remote.spatialExcludedWorkspaceIds") || "[]"),
        ),
      )
      .toEqual([]);
    await page.locator("#navToggle").click();
    await expect(skipA).toHaveAttribute("aria-pressed", "false");
  });

  test("offers a four-way flick direction key", async ({ page }) => {
    await page.route("http://remote.test/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>remote test</title>",
      }),
    );
    await page.goto("http://remote.test/");
    await page.setContent(remoteClientMarkupWithoutXterm());
    await page.locator("#keyBarToggle").click();

    const flickButton = page.locator('[data-key="dpad"]');
    const flickHint = page.locator("#keyFlickHint");
    await expect(flickButton).toHaveCount(1);
    await flickButton.evaluate((button: HTMLButtonElement) => {
      button.disabled = false;
    });
    await expect(flickButton).toHaveAttribute(
      "aria-label",
      "Flick for arrow key: up, right, down, or left",
    );

    const directions = [
      { name: "up", dx: 0, dy: -32 },
      { name: "right", dx: 32, dy: 0 },
      { name: "down", dx: 0, dy: 32 },
      { name: "left", dx: -32, dy: 0 },
    ] as const;
    for (const { name, dx, dy } of directions) {
      // The default "step" set renders ahead of dpad — keep it in the viewport.
      await flickButton.scrollIntoViewIfNeeded();
      const box = await flickButton.boundingBox();
      expect(box).not.toBeNull();
      const x = box!.x + box!.width / 2;
      const y = box!.y + box!.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await expect(flickHint).toBeVisible();
      await expect(flickHint.locator("[data-flick-direction]")).toHaveCount(4);

      await page.mouse.move(x + dx, y + dy);
      await expect(flickHint).toHaveAttribute("data-direction", name);
      await expect(flickHint.locator(`[data-flick-direction="${name}"]`)).toHaveClass(/active/);

      await page.mouse.up();
      await expect(flickHint).toBeHidden();
    }
  });

  test("routes the first real xterm touch to Composer before snapshot readiness", async ({
    page,
  }) => {
    let outputSocket: WebSocketRoute | null = null;
    await installRemoteClientRoutes(page);
    await page.route("http://remote.test/remote/v1/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/remote/v1/session/claim") {
        await route.fulfill({ json: { leaseId: "lease-1", heartbeatTimeoutSeconds: 45 } });
        return;
      }
      if (url.pathname === "/remote/v1/navigation") {
        await route.fulfill({
          json: {
            terminals: [{ id: "term-1", title: "Shell", appearance: {} }],
            activeWorkspace: {
              focusedPaneNumber: 1,
              panes: [
                {
                  paneNumber: 1,
                  terminalId: "term-1",
                  terminalLive: true,
                  viewType: "TerminalView",
                },
              ],
            },
            workspaces: [],
            docks: [],
            notifications: [],
          },
        });
        return;
      }
      await route.fulfill({ json: {} });
    });
    await page.routeWebSocket(/\/remote\/v1\/terminals\/term-1\/output/, (socket) => {
      outputSocket = socket;
    });

    await page.goto("http://remote.test/remote/#token=test-token");
    await page.locator("#connect").click();
    const editor = page.locator("#composerInput");
    await expect(page.locator("#terminal .xterm")).toBeVisible();
    await expect(editor).toBeEnabled();
    await expect(page.locator("#terminalComposer")).toHaveAttribute("data-can-send", "false");
    await expect.poll(() => outputSocket).not.toBeNull();

    await page.locator("#terminal .xterm").tap();
    await expect(editor).toBeFocused();
    await page.keyboard.type("real xterm touch");
    await expect(editor).toHaveValue("real xterm touch");

    outputSocket!.send(
      JSON.stringify({
        type: "terminal.output",
        version: 1,
        phase: "snapshot",
        seqStart: 0,
        seqEnd: 0,
        byteLength: 0,
        state: {
          version: 1,
          snapshotStartSeq: 0,
          snapshotSeq: 0,
          protocolRevision: 0,
          modes: { bracketedPaste: false },
        },
      }),
    );
    outputSocket!.send(Buffer.alloc(0));
    await expect(page.locator("#terminalComposer")).toHaveAttribute("data-can-send", "true");
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue("real xterm touch");
  });

  test("keeps terminal keyboard focus while sending every soft-key sequence", async ({ page }) => {
    const writes: string[] = [];
    let outputSocket: WebSocketRoute | null = null;
    await page.addInitScript(() => {
      localStorage.setItem("laymux.remote.inputMode", "direct");
      // Placement is activation: every key this test drives has to be on the
      // Keys row, in the order the assertion below expects.
      localStorage.setItem(
        "laymux.remote.keybar",
        JSON.stringify({
          expanded: true,
          userKeys: [],
          zones: {
            main: { left: [], center: [], right: ["keyboard", "keys"] },
            expanded: {
              left: [
                "esc",
                "tab",
                "stab",
                "dpad",
                "up",
                "down",
                "left",
                "right",
                "home",
                "end",
                "enter",
                "bksp",
                "ins",
                "del",
                "pgup",
                "pgdn",
                "c-c",
                "c-j",
                "c-l",
                "c-t",
                "c-u",
                "f1",
                "f2",
                "f3",
                "f4",
                "f5",
                "f6",
                "f7",
                "f8",
                "f9",
                "f10",
                "f11",
                "f12",
              ].map((id) => `soft:${id}`),
              center: [],
              right: [],
            },
          },
        }),
      );
    });
    await installRemoteClientRoutes(page);
    await page.route("http://remote.test/remote/v1/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/remote/v1/session/claim") {
        await route.fulfill({ json: { leaseId: "lease-1", heartbeatTimeoutSeconds: 45 } });
        return;
      }
      if (url.pathname === "/remote/v1/navigation") {
        await route.fulfill({
          json: {
            terminals: [{ id: "term-1", title: "Shell", appearance: {} }],
            activeWorkspace: {
              focusedPaneNumber: 1,
              panes: [
                {
                  paneNumber: 1,
                  terminalId: "term-1",
                  terminalLive: true,
                  viewType: "TerminalView",
                },
              ],
            },
            workspaces: [],
            docks: [],
            notifications: [],
          },
        });
        return;
      }
      if (url.pathname === "/remote/v1/terminals/term-1/write") {
        const body = route.request().postDataJSON() as { data: string };
        writes.push(body.data);
      }
      await route.fulfill({ json: {} });
    });
    await page.routeWebSocket(/\/remote\/v1\/terminals\/term-1\/output/, (socket) => {
      outputSocket = socket;
    });

    const cdp = await page.context().newCDPSession(page);
    await page.goto("http://remote.test/remote/#token=test-token");
    await page.locator("#connect").click();
    await expect(page.locator("#focusTerminal")).toBeEnabled();

    // Attach leaves the focus alone on a touch device (ADR-0196), so the first
    // Keyboard tap is what raises the direct input surface. From here the
    // button is a focus toggle, so tapping it again would dismiss it.
    const helperTextarea = page.locator(".xterm-helper-textarea");
    await page.locator("#focusTerminal").tap();
    await expect(helperTextarea).toBeFocused();

    const fixedCases = [
      { id: "esc", sequence: "\x1b" },
      { id: "tab", sequence: "\t" },
      { id: "stab", sequence: "\x1b[Z" },
      { id: "enter", sequence: "\r" },
      { id: "bksp", sequence: "\x7f" },
      { id: "ins", sequence: "\x1b[2~" },
      { id: "del", sequence: "\x1b[3~" },
      { id: "pgup", sequence: "\x1b[5~" },
      { id: "pgdn", sequence: "\x1b[6~" },
      { id: "c-c", sequence: "\x03" },
      { id: "c-j", sequence: "\n" },
      { id: "c-l", sequence: "\x0c" },
      { id: "c-t", sequence: "\x14" },
      { id: "c-u", sequence: "\x15" },
      { id: "f1", sequence: "\x1bOP" },
      { id: "f2", sequence: "\x1bOQ" },
      { id: "f3", sequence: "\x1bOR" },
      { id: "f4", sequence: "\x1bOS" },
      { id: "f5", sequence: "\x1b[15~" },
      { id: "f6", sequence: "\x1b[17~" },
      { id: "f7", sequence: "\x1b[18~" },
      { id: "f8", sequence: "\x1b[19~" },
      { id: "f9", sequence: "\x1b[20~" },
      { id: "f10", sequence: "\x1b[21~" },
      { id: "f11", sequence: "\x1b[23~" },
      { id: "f12", sequence: "\x1b[24~" },
    ];
    const cursorCases = [
      { id: "up", final: "A" },
      { id: "down", final: "B" },
      { id: "left", final: "D" },
      { id: "right", final: "C" },
      { id: "home", final: "H" },
      { id: "end", final: "F" },
    ];
    const renderedKeyIds = await page
      .locator("#keyRow .key-btn")
      .evaluateAll((buttons) => buttons.map((button) => (button as HTMLButtonElement).dataset.key));
    expect(renderedKeyIds).toEqual([
      "esc",
      "tab",
      "stab",
      "dpad",
      "up",
      "down",
      "left",
      "right",
      "home",
      "end",
      "enter",
      "bksp",
      "ins",
      "del",
      "pgup",
      "pgdn",
      "c-c",
      "c-j",
      "c-l",
      "c-t",
      "c-u",
      "f1",
      "f2",
      "f3",
      "f4",
      "f5",
      "f6",
      "f7",
      "f8",
      "f9",
      "f10",
      "f11",
      "f12",
    ]);

    const pressKey = async (id: string, sequence: string) => {
      const writeIndex = writes.length;
      await page.locator(`[data-key="${id}"]`).tap();
      await expect(helperTextarea).toBeFocused();
      await expect.poll(() => writes.length).toBe(writeIndex + 1);
      expect(writes[writeIndex]).toBe(sequence);
    };

    const flickKey = async (dx: number, dy: number, sequence: string) => {
      const flickButton = page.locator('[data-key="dpad"]');
      await flickButton.scrollIntoViewIfNeeded();
      const box = await flickButton.boundingBox();
      expect(box).not.toBeNull();
      const writeIndex = writes.length;
      const x = box!.x + box!.width / 2;
      const y = box!.y + box!.height / 2;
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y, id: 1 }],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x + dx, y: y + dy, id: 1 }],
      });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await expect(helperTextarea).toBeFocused();
      await expect.poll(() => writes.length).toBe(writeIndex + 1);
      expect(writes[writeIndex]).toBe(sequence);
    };

    for (const key of fixedCases) {
      await pressKey(key.id, key.sequence);
    }
    for (const key of cursorCases) {
      await pressKey(key.id, `\x1b[${key.final}`);
    }
    await flickKey(0, -32, "\x1b[A");
    await flickKey(32, 0, "\x1b[C");
    await flickKey(0, 32, "\x1b[B");
    await flickKey(-32, 0, "\x1b[D");

    await expect.poll(() => outputSocket).not.toBeNull();
    outputSocket!.send(Buffer.from("\x1b[?1hAPP-MODE"));
    await expect(page.locator(".xterm-rows")).toContainText("APP-MODE");
    for (const key of cursorCases) {
      await pressKey(key.id, `\x1bO${key.final}`);
    }
    await flickKey(0, -32, "\x1bOA");
    await flickKey(32, 0, "\x1bOC");
    await flickKey(0, 32, "\x1bOB");
    await flickKey(-32, 0, "\x1bOD");
  });

  test("keeps accelerated alternate-buffer scrolling as discrete replay-safe writes", async ({
    page,
  }) => {
    const writes: string[] = [];
    let outputSocket: WebSocketRoute | null = null;
    await page.addInitScript(() => {
      type ScrollTestWindow = Window & {
        __twoFingerTerminal?: unknown;
        __holdScrollReplay?: boolean;
        __scrollReplayParsed?: boolean;
        __releaseScrollReplay?: () => void;
      };
      let capturedConstructor: typeof window.Terminal | undefined;
      Object.defineProperty(window, "Terminal", {
        configurable: true,
        get: () => capturedConstructor,
        set: (TerminalConstructor: typeof window.Terminal) => {
          capturedConstructor = class extends TerminalConstructor {
            constructor(options?: ConstructorParameters<typeof TerminalConstructor>[0]) {
              super(options);
              Object.defineProperty(window, "__twoFingerTerminal", {
                configurable: true,
                value: this,
              });
            }

            write(data: string | Uint8Array, callback?: () => void) {
              super.write(data, () => {
                const state = window as ScrollTestWindow;
                if (state.__holdScrollReplay && data instanceof Uint8Array) {
                  state.__scrollReplayParsed = true;
                  state.__releaseScrollReplay = () => callback?.();
                  return;
                }
                callback?.();
              });
            }
          };
        },
      });
    });
    await installRemoteClientRoutes(page);
    await page.route("http://remote.test/remote/v1/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/remote/v1/session/claim") {
        await route.fulfill({ json: { leaseId: "lease-1", heartbeatTimeoutSeconds: 45 } });
        return;
      }
      if (url.pathname === "/remote/v1/navigation") {
        await route.fulfill({
          json: {
            terminals: [
              {
                id: "term-1",
                title: "Codex",
                appearance: {
                  scrollSensitivity: 1,
                  fastScrollSensitivity: 5,
                  touchScrollSensitivity: 1,
                  twoFingerScrollSensitivity: 5,
                },
              },
            ],
            activeWorkspace: {
              focusedPaneNumber: 1,
              panes: [
                {
                  paneNumber: 1,
                  terminalId: "term-1",
                  terminalLive: true,
                  viewType: "TerminalView",
                },
              ],
            },
            workspaces: [],
            docks: [],
            notifications: [],
          },
        });
        return;
      }
      if (url.pathname === "/remote/v1/terminals/term-1/write") {
        const body = route.request().postDataJSON() as { data: string };
        writes.push(body.data);
      }
      await route.fulfill({ json: {} });
    });
    await page.routeWebSocket(/\/remote\/v1\/terminals\/term-1\/output/, (socket) => {
      outputSocket = socket;
    });

    const cdp = await page.context().newCDPSession(page);
    await page.goto("http://remote.test/remote/#token=test-token");
    await page.locator("#connect").click();
    await expect(page.locator("#focusTerminal")).toBeEnabled();

    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const terminal = (
            window as Window & {
              __twoFingerTerminal?: { write(data: string, callback: () => void): void };
            }
          ).__twoFingerTerminal;
          terminal?.write("\x1b[?1049h\x1b[?1007h", resolve);
        }),
    );
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as Window & {
                __twoFingerTerminal?: { buffer?: { active?: { type?: string } } };
              }
            ).__twoFingerTerminal?.buffer?.active?.type,
        ),
      )
      .toBe("alternate");

    const screenBox = await page.locator(".xterm-screen").boundingBox();
    expect(screenBox).not.toBeNull();
    const geometry = await page.evaluate(() => {
      const terminal = (
        window as Window & {
          __twoFingerTerminal?: { cols?: number; rows?: number };
        }
      ).__twoFingerTerminal;
      return { cols: terminal?.cols, rows: terminal?.rows };
    });
    const cols = geometry?.cols || 80;
    const rows = geometry?.rows || 24;
    const cellHeight = screenBox!.height / rows;
    const centerX = screenBox!.x + screenBox!.width / 2;
    const startY = screenBox!.y + screenBox!.height / 2;
    const points = (y: number) => [
      { x: centerX - 12, y, id: 1 },
      { x: centerX + 12, y, id: 2 },
    ];

    const dragOneCell = async () => {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: points(startY),
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: points(startY - cellHeight),
      });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    };

    const scrollOptions = await page.evaluate(() => {
      const terminal = (
        window as Window & {
          __twoFingerTerminal?: {
            options?: { fastScrollModifier?: string; fastScrollSensitivity?: number };
          };
        }
      ).__twoFingerTerminal;
      return {
        modifier: terminal?.options?.fastScrollModifier,
        sensitivity: terminal?.options?.fastScrollSensitivity,
      };
    });
    expect(scrollOptions).toEqual({ modifier: "alt", sensitivity: 5 });
    await page.locator(".xterm").evaluate((element) => {
      element.dispatchEvent(
        new WheelEvent("wheel", {
          altKey: true,
          bubbles: true,
          cancelable: true,
          deltaMode: WheelEvent.DOM_DELTA_LINE,
          deltaY: 1,
        }),
      );
    });
    await expect.poll(() => writes).toEqual(Array(5).fill("\x1b[B"));
    writes.length = 0;

    await dragOneCell();
    await expect.poll(() => writes).toEqual(Array(5).fill("\x1b[B"));
    writes.length = 0;

    await expect.poll(() => outputSocket).not.toBeNull();
    await page.evaluate(() => {
      const state = window as Window & {
        __holdScrollReplay?: boolean;
        __scrollReplayParsed?: boolean;
      };
      state.__holdScrollReplay = true;
      state.__scrollReplayParsed = false;
    });
    const snapshot = Buffer.from("\x1b[?1049h\x1b[?1007h");
    outputSocket!.send(
      JSON.stringify({
        type: "terminal.output",
        version: 1,
        phase: "snapshot",
        seqStart: 0,
        seqEnd: snapshot.byteLength,
        byteLength: snapshot.byteLength,
        state: {
          version: 1,
          generation: 1,
          snapshotStartSeq: 0,
          snapshotSeq: snapshot.byteLength,
          sourceStartSeq: 0,
          sourceSeq: snapshot.byteLength,
          snapshotKind: "screen",
          protocolRevision: 0,
          modes: { bracketedPaste: false },
          geometry: { revision: 0, cols, rows },
        },
      }),
    );
    outputSocket!.send(snapshot);
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as Window & { __scrollReplayParsed?: boolean }).__scrollReplayParsed,
        ),
      )
      .toBe(true);

    await dragOneCell();
    await page.evaluate(() => {
      const state = window as Window & {
        __holdScrollReplay?: boolean;
        __releaseScrollReplay?: () => void;
      };
      state.__holdScrollReplay = false;
      const release = state.__releaseScrollReplay;
      state.__releaseScrollReplay = undefined;
      release?.();
    });
    await page.locator('[data-key="c-c"]').click();
    await expect.poll(() => writes.includes("\x03")).toBe(true);
    expect(writes).toEqual(["\x03"]);
  });

  test("copies a selection when mouseup lands outside the terminal", async ({ page }) => {
    await page.addInitScript(() => {
      class MockTerminal {
        options: Record<string, unknown>;
        modes = { applicationCursorKeysMode: false };
        cols = 80;
        rows = 24;
        selection = "";

        constructor(options: Record<string, unknown>) {
          this.options = options;
          Object.defineProperty(window, "__mockTerminal", { value: this, configurable: true });
        }

        loadAddon(_addon: unknown) {}
        open(_element: HTMLElement) {}
        onData(_listener: (data: string) => void) {}
        onResize(_listener: (size: { cols: number; rows: number }) => void) {}
        onSelectionChange(_listener: () => void) {}
        onScroll(_listener: () => void) {}
        hasSelection() {
          return Boolean(this.selection);
        }
        getSelection() {
          return this.selection;
        }
        getSelectionPosition() {
          return null;
        }
        reset() {}
        refresh(_start: number, _end: number) {}
        write(_data: string | Uint8Array, callback?: () => void) {
          callback?.();
        }
        focus() {}
        scrollLines(_amount: number) {}
      }

      class MockFitAddon {
        fit() {}
      }

      class MockResizeObserver {
        observe(_target: Element) {}
        disconnect() {}
      }

      class MockWebSocket {
        binaryType = "";
        onopen: (() => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onclose: (() => void) | null = null;
        onerror: (() => void) | null = null;
        close() {}
      }

      Object.defineProperty(window, "Terminal", { value: MockTerminal, configurable: true });
      Object.defineProperty(window, "FitAddon", {
        value: { FitAddon: MockFitAddon },
        configurable: true,
      });
      Object.defineProperty(window, "ResizeObserver", {
        value: MockResizeObserver,
        configurable: true,
      });
      Object.defineProperty(window, "WebSocket", {
        value: MockWebSocket,
        configurable: true,
      });
    });
    await page.route("http://remote.test/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>remote test</title>",
      }),
    );
    await page.route("**/remote/v1/**", (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.endsWith("/session/claim")) {
        return route.fulfill({ json: { leaseId: "lease-1", heartbeatTimeoutSeconds: 45 } });
      }
      if (pathname.endsWith("/navigation")) {
        return route.fulfill({
          json: {
            terminals: [{ id: "term-1", title: "Shell", appearance: {} }],
            activeWorkspace: {
              focusedPaneNumber: 1,
              panes: [
                {
                  paneNumber: 1,
                  terminalId: "term-1",
                  terminalLive: true,
                  viewType: "TerminalView",
                },
              ],
            },
            workspaces: [],
            docks: [],
            notifications: [],
          },
        });
      }
      return route.fulfill({ json: {} });
    });
    await page.goto("http://remote.test/");
    await page.setContent(remoteClientMarkupWithoutXterm());
    await page.locator("#token").fill("test-token");
    await page.locator("#connect").click();
    await expect(page.locator('[data-key="c-c"]')).toBeEnabled();

    await page.evaluate(() => {
      const testWindow = window as Window & {
        __copiedText?: string[];
        __mockTerminal?: { selection: string };
      };
      testWindow.__copiedText = [];
      Object.defineProperty(document, "execCommand", {
        configurable: true,
        value: (command: string) => {
          if (command !== "copy") return false;
          const active = document.activeElement as HTMLTextAreaElement | null;
          testWindow.__copiedText?.push(active?.value || "");
          return true;
        },
      });
      document.addEventListener(
        "mouseup",
        () => {
          if (testWindow.__mockTerminal) {
            testWindow.__mockTerminal.selection = "selected outside terminal";
          }
        },
        { once: true },
      );
      document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });

    await expect
      .poll(() =>
        page.evaluate(() => (window as Window & { __copiedText?: string[] }).__copiedText || []),
      )
      .toEqual(["selected outside terminal"]);
  });

  test("tracks the restored visual viewport height", async ({ page }) => {
    await page.route("http://remote.test/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>remote test</title>",
      }),
    );
    await page.goto("http://remote.test/");
    await page.setContent(remoteClientMarkupWithoutXterm());
    const app = page.locator(".app");

    // Default Keys row placement: navPad + Esc/Tab/Shift+Tab/flick pad on the
    // left, ^J ^U ^T ^L on the right.
    await expect(page.locator("#keyRow .key-btn")).toHaveCount(9);
    await expect(page.locator("#keyBar")).toBeHidden();
    await page.locator("#keyBarToggle").click();
    await expect(page.locator("#keyBar")).toBeVisible();

    await page.setViewportSize({ width: 390, height: 500 });
    await expect(app).toHaveCSS("height", "500px");

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(app).toHaveCSS("height", "844px");
    expect((await app.boundingBox())?.height).toBe(844);
  });
});

test.describe("remote terminal protocol query ownership", () => {
  test("real xterm suppresses mixed and trailing OSC color queries while applying setters", async ({
    page,
  }) => {
    const writes: string[] = [];
    let outputSocket: WebSocketRoute | null = null;

    await page.addInitScript(() => {
      localStorage.setItem("laymux.remote.inputMode", "direct");
      let capturedConstructor: typeof window.Terminal | undefined;
      Object.defineProperty(window, "Terminal", {
        configurable: true,
        get: () => capturedConstructor,
        set: (TerminalConstructor: typeof window.Terminal) => {
          capturedConstructor = class extends TerminalConstructor {
            constructor(options?: ConstructorParameters<typeof TerminalConstructor>[0]) {
              super(options);
              Object.defineProperty(window, "__realRemoteTerminal", {
                configurable: true,
                value: this,
              });
            }
          };
        },
      });
    });

    await installRemoteClientRoutes(page);
    await page.route("http://remote.test/remote/v1/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/remote/v1/session/claim") {
        await route.fulfill({ json: { leaseId: "lease-1", heartbeatTimeoutSeconds: 45 } });
        return;
      }
      if (url.pathname === "/remote/v1/navigation") {
        await route.fulfill({
          json: {
            terminals: [{ id: "term-1", title: "Shell", appearance: {} }],
            activeWorkspace: {
              id: "ws-1",
              name: "Main",
              focusedPaneNumber: 1,
              panes: [
                {
                  paneNumber: 1,
                  terminalId: "term-1",
                  terminalLive: true,
                  viewType: "TerminalView",
                },
              ],
            },
            workspaces: [],
            docks: [],
            notifications: [],
          },
        });
        return;
      }
      if (url.pathname === "/remote/v1/terminals/term-1/write") {
        const body = route.request().postDataJSON() as { data: string };
        writes.push(body.data);
      }
      await route.fulfill({ json: {} });
    });
    await page.routeWebSocket(/\/remote\/v1\/terminals\/term-1\/output/, (socket) => {
      outputSocket = socket;
    });

    await page.goto("http://remote.test/remote/#token=test-token");
    await page.locator("#connect").click();
    await expect(page.locator("#focusTerminal")).toBeEnabled();
    await expect.poll(() => outputSocket).not.toBeNull();

    let outputSeq = 0;
    const sendOutput = (text: string, phase: "snapshot" | "delta") => {
      const payload = Buffer.from(text);
      const seqStart = outputSeq;
      outputSeq += payload.byteLength;
      outputSocket!.send(
        JSON.stringify({
          type: "terminal.output",
          version: 1,
          phase,
          seqStart,
          seqEnd: outputSeq,
          byteLength: payload.byteLength,
          ...(phase === "snapshot"
            ? {
                state: {
                  version: 1,
                  snapshotStartSeq: seqStart,
                  snapshotSeq: outputSeq,
                  protocolRevision: 0,
                  modes: { bracketedPaste: false },
                },
              }
            : {}),
        }),
      );
      outputSocket!.send(payload);
    };
    const terminalColors = () =>
      page.evaluate(() => {
        // xterm is deliberately pinned to 6.0.0; inspect its fixed internal
        // theme state so the regression proves setters execute in stream order.
        const terminal = (
          window as Window & {
            __realRemoteTerminal: {
              _core: {
                _themeService: {
                  colors: {
                    foreground: { css: string };
                    background: { css: string };
                    ansi: Array<{ css: string }>;
                  };
                };
              };
            };
          }
        ).__realRemoteTerminal;
        return {
          foreground: terminal._core._themeService.colors.foreground.css,
          background: terminal._core._themeService.colors.background.css,
          ansi8: terminal._core._themeService.colors.ansi[8].css,
        };
      });

    sendOutput("SNAPSHOT-READY", "snapshot");
    await expect(page.locator(".xterm-rows")).toContainText("SNAPSHOT-READY");
    const initialColors = await terminalColors();

    sendOutput(
      [
        "\x1b]10;?\x1b\\",
        "\x1b]11;?\x07",
        "\x1b]10;?;#123456\x1b\\",
        "\x1b]10;#654321;?\x1b\\",
        "\x1b]4;7;?;8;#abcdef\x1b\\",
        "\x1b]12;?;\x07",
        "OSC-QUERIES-PARSED",
      ].join(""),
      "delta",
    );
    await expect(page.locator(".xterm-rows")).toContainText("OSC-QUERIES-PARSED");

    await expect
      .poll(terminalColors)
      .toEqual({ foreground: "#654321", background: "#123456", ansi8: "#abcdef" });

    sendOutput(
      [
        "\x1b]10;#ff0000;?\x1b\\",
        "\x1b]10;#0000ff\x1b\\",
        "\x1b]4;8;#ff0000;7;?\x1b\\",
        "\x1b]4;8;#0000ff\x1b\\",
        "OSC-ORDER-PARSED",
      ].join(""),
      "delta",
    );
    await expect(page.locator(".xterm-rows")).toContainText("OSC-ORDER-PARSED");
    await expect.poll(terminalColors).toEqual({
      foreground: "#0000ff",
      background: "#123456",
      ansi8: "#0000ff",
    });

    sendOutput(
      [
        "\x1b]10;#00ff00;?\x1b\\",
        "\x1b]110\x1b\\",
        "\x1b]111\x1b\\",
        "\x1b]4;8;#00ff00;7;?\x1b\\",
        "\x1b]104;8\x1b\\",
        "OSC-RESET-PARSED",
      ].join(""),
      "delta",
    );
    await expect(page.locator(".xterm-rows")).toContainText("OSC-RESET-PARSED");
    await expect.poll(terminalColors).toEqual(initialColors);

    const helperTextarea = page.locator(".xterm-helper-textarea");
    await helperTextarea.focus();
    await page.keyboard.type("q");
    await expect.poll(() => writes).toEqual(["q"]);
  });
});
