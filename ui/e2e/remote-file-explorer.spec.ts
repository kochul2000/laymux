import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { fulfillRemoteClientAsset } from "./remote-client-assets";

/**
 * Remote in-overlay file explorer (ADR-0198): the header folder button and the
 * directory rows drive `/remote/v1/file-viewer/list`, files open through the
 * existing render route, and Back re-requests the listing instead of caching.
 */

type ListingEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
};

const dir = (name: string, path: string): ListingEntry => ({
  name,
  path,
  isDirectory: true,
  isSymlink: false,
  size: 0,
});
const file = (name: string, path: string, size = 24): ListingEntry => ({
  name,
  path,
  isDirectory: false,
  isSymlink: false,
  size,
});
const symlink = (name: string, path: string, size = 8): ListingEntry => ({
  name,
  path,
  isDirectory: false,
  isSymlink: true,
  size,
});

const LISTINGS: Record<
  string,
  { path: string; parent: string | null; entries: ListingEntry[]; truncated: boolean }
> = {
  "/home/user": {
    path: "/home/user",
    parent: "/home",
    entries: [
      dir("repo", "/home/user/repo"),
      dir("empty", "/home/user/empty"),
      dir("huge", "/home/user/huge"),
      dir("denied", "/home/user/denied"),
      file("<img src=x onerror=alert(1)>.txt", "/home/user/<img src=x onerror=alert(1)>.txt"),
      file("notes.txt", "/home/user/notes.txt"),
      symlink("current", "/home/user/current"),
    ],
    truncated: false,
  },
  "/home/user/repo": {
    path: "/home/user/repo",
    parent: "/home/user",
    entries: [file("main.rs", "/home/user/repo/main.rs", 512)],
    truncated: false,
  },
  "/home/user/empty": {
    path: "/home/user/empty",
    parent: "/home/user",
    entries: [],
    truncated: false,
  },
  "/home/user/huge": {
    path: "/home/user/huge",
    parent: "/home/user",
    entries: [file("first.txt", "/home/user/huge/first.txt")],
    truncated: true,
  },
};

async function installRemoteExplorerMocks(context: BrowserContext, withTerminal = false) {
  const listRequests: Array<{
    lease: string | null;
    fileViewerCapability: string | null;
    body: Record<string, unknown>;
  }> = [];
  const renderRequests: Array<Record<string, unknown>> = [];

  await context.route("http://remote.test/remote/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (await fulfillRemoteClientAsset(route, url.pathname)) return;
    if (url.pathname === "/remote/v1/session/claim") {
      return route.fulfill({
        json: {
          active: true,
          leaseId: "lease-197",
          resumeToken: "resume-197",
          fileViewerToken: "viewer-197",
          heartbeatTimeoutSeconds: 45,
        },
      });
    }
    if (url.pathname === "/remote/v1/session/heartbeat") {
      return route.fulfill({ json: { ok: true } });
    }
    if (url.pathname === "/remote/v1/session/release") {
      return route.fulfill({ json: { ok: true } });
    }
    if (url.pathname === "/remote/v1/navigation") {
      const pane = {
        id: "pane-1",
        location: "workspace",
        workspaceId: "ws-1",
        paneIndex: 0,
        paneNumber: 1,
        viewType: "TerminalView",
        terminalId: "terminal-1",
        terminalLive: true,
        title: "Shell",
        profile: "PowerShell",
        cwd: "/home/user",
        activity: { type: "shell" },
        isFocused: true,
        hidden: false,
        collapsed: false,
        x: 0,
        y: 0,
        w: 1,
        h: 1,
      };
      return route.fulfill({
        json: {
          activeWorkspace: withTerminal ? { id: "ws-1", name: "Main", panes: [pane] } : null,
          workspaces: withTerminal
            ? [{ id: "ws-1", name: "Main", isActive: true, hidden: false, panes: [pane] }]
            : [],
          docks: [],
          terminals: withTerminal
            ? [
                {
                  id: "terminal-1",
                  title: "Shell",
                  profile: "PowerShell",
                  cwd: "/home/user",
                  workspaceId: "ws-1",
                  paneNumber: 1,
                  appearance: {
                    fontFamily: "'Cascadia Mono', 'Consolas', monospace",
                    cursorStyle: "bar",
                    cursorWidth: 1,
                    theme: {},
                  },
                },
              ]
            : [],
          workspaceSelector: { display: {}, pathEllipsis: "start" },
          notifications: [],
          unreadNotificationCount: 0,
        },
      });
    }
    if (url.pathname === "/remote/v1/file-viewer/list") {
      const body = JSON.parse(request.postData() || "{}") as Record<string, unknown>;
      listRequests.push({
        lease: await request.headerValue("x-laymux-remote-lease"),
        fileViewerCapability: await request.headerValue("x-laymux-remote-file-viewer"),
        body,
      });
      const path = body.source === "terminalCwd" ? "/home/user" : String(body.path || "");
      const listing = LISTINGS[path];
      if (!listing) {
        return route.fulfill({ status: 502, json: { error: "Cannot read directory: denied" } });
      }
      return route.fulfill({ json: listing });
    }
    if (url.pathname === "/remote/v1/file-viewer/render") {
      const body = JSON.parse(request.postData() || "{}") as Record<string, unknown>;
      renderRequests.push(body);
      return route.fulfill({
        json: {
          kind: "text",
          path: String(body.path || ""),
          content: "fn main() {}",
          truncated: false,
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: "not mocked" } });
  });
  if (withTerminal) {
    await context.routeWebSocket(/\/remote\/v1\/terminals\/terminal-1\/output/, () => {});
  }

  return { listRequests, renderRequests };
}

async function connectRemote(page: Page, localApp = false) {
  await page.goto(`http://remote.test/remote/${localApp ? "?localApp=1" : ""}`);
  await page.locator("#token").fill("remote-secret");
  await page.locator("#connect").click();
  await expect(page.locator("#exit")).toBeEnabled();
}

async function flickTerminalEdge(page: Page, edge: "left" | "right") {
  await page.locator("#terminal .xterm").evaluate((element, selectedEdge) => {
    const target = element as HTMLElement;
    const rect = target.getBoundingClientRect();
    target.setPointerCapture = () => {};
    target.releasePointerCapture = () => {};
    target.hasPointerCapture = () => false;
    const startX = selectedEdge === "left" ? rect.left + 1 : rect.right - 1;
    const endX = startX + (selectedEdge === "left" ? 80 : -80);
    const dispatch = (type: string, clientX: number) =>
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 41,
          pointerType: "touch",
          isPrimary: true,
          clientX,
          clientY: rect.top + rect.height / 2,
          screenX: clientX,
          screenY: rect.top + rect.height / 2,
        }),
      );
    dispatch("pointerdown", startX);
    dispatch("pointermove", endX);
    dispatch("pointerup", endX);
  }, edge);
}

async function tapTerminalLeftEdge(page: Page) {
  await page.locator("#terminal .xterm").evaluate((element) => {
    const target = element as HTMLElement;
    const rect = target.getBoundingClientRect();
    target.setPointerCapture = () => {};
    target.releasePointerCapture = () => {};
    target.hasPointerCapture = () => false;
    const clientX = rect.left + 1;
    const init = {
      bubbles: true,
      cancelable: true,
      pointerId: 42,
      pointerType: "touch",
      isPrimary: true,
      clientX,
      clientY: rect.top + rect.height / 2,
      screenX: clientX,
      screenY: rect.top + rect.height / 2,
    };
    target.dispatchEvent(new PointerEvent("pointerdown", init));
    target.dispatchEvent(new PointerEvent("pointerup", init));
  });
}

test("the header folder button appears with the capability and lists the cwd", async ({
  context,
  page,
}) => {
  const { listRequests } = await installRemoteExplorerMocks(context);

  await page.goto("http://remote.test/remote/");
  // No lease yet: the entry point means nothing, so it is hidden, not disabled.
  await expect(page.locator("#fileExplorerHeader")).toBeHidden();

  await page.locator("#token").fill("remote-secret");
  await page.locator("#connect").click();
  await expect(page.locator("#exit")).toBeEnabled();
  await expect(page.locator("#fileExplorerHeader")).toBeVisible();

  await page.locator("#fileExplorerHeader").click();
  const overlay = page.locator("#fileViewerOverlay");
  await expect(overlay).toBeVisible();
  await expect(page.locator("#fileViewerTitle")).toHaveText("/home/user");

  const rows = page.locator(".file-viewer-directory-row");
  await expect(rows).toHaveCount(8); // ".." + four dirs + two files + symlink
  await expect(rows.nth(0)).toHaveText("..");
  await expect(rows.nth(1)).toContainText("repo");
  // A hostile entry name stays text, never markup.
  await expect(rows.nth(5)).toContainText("<img src=x onerror=alert(1)>.txt");
  await expect(rows.nth(0).locator("[data-remote-icon-name=FolderUp]")).toHaveCount(1);
  await expect(
    page
      .locator(".file-viewer-directory-row", { hasText: "repo" })
      .locator("[data-remote-icon-name=Folder]"),
  ).toHaveCount(1);
  await expect(
    page
      .locator(".file-viewer-directory-row", { hasText: "notes.txt" })
      .locator("[data-remote-icon-name=File]"),
  ).toHaveCount(1);
  await expect(
    page
      .locator(".file-viewer-directory-row", { hasText: "current" })
      .locator("[data-remote-icon-name=Link]"),
  ).toHaveCount(1);

  // Zoom and download are file-mode affordances — hidden, not disabled.
  await expect(page.locator("#fileViewerZoom")).toBeHidden();
  await expect(page.locator("#fileViewerDownload")).toBeHidden();
  await expect(page.locator("#fileViewerBack")).toBeHidden();

  expect(listRequests).toEqual([
    {
      lease: "lease-197",
      fileViewerCapability: "viewer-197",
      body: { source: "terminalCwd" },
    },
  ]);
});

test("navigates into a directory, opens a file and Back re-requests the listing", async ({
  context,
  page,
}) => {
  const { listRequests, renderRequests } = await installRemoteExplorerMocks(context);
  await connectRemote(page);

  await page.locator("#fileExplorerHeader").click();
  await expect(page.locator("#fileViewerTitle")).toHaveText("/home/user");

  await page.locator(".file-viewer-directory-row", { hasText: "repo" }).click();
  await expect(page.locator("#fileViewerTitle")).toHaveText("/home/user/repo");
  await expect(page.locator(".file-viewer-directory-row", { hasText: "main.rs" })).toBeVisible();

  await page.locator(".file-viewer-directory-row", { hasText: "main.rs" }).click();
  await expect(page.locator("#fileViewerText")).toHaveText("fn main() {}");
  await expect(page.locator("#fileViewerTitle")).toHaveText("/home/user/repo/main.rs");
  // File mode brings the download affordance back.
  await expect(page.locator("#fileViewerDownload")).toBeVisible();
  expect(renderRequests).toEqual([{ source: "path", path: "/home/user/repo/main.rs" }]);

  // Back exists only for a file reached through the explorer and re-lists.
  await expect(page.locator("#fileViewerBack")).toBeVisible();
  await page.locator("#fileViewerBack").click();
  await expect(page.locator("#fileViewerTitle")).toHaveText("/home/user/repo");
  await expect(page.locator(".file-viewer-directory-row", { hasText: "main.rs" })).toBeVisible();
  expect(listRequests.map((item) => item.body)).toEqual([
    { source: "terminalCwd" },
    { path: "/home/user/repo" },
    { path: "/home/user/repo" },
  ]);

  // The ".." row walks up.
  await page.locator(".file-viewer-directory-row.parent").click();
  await expect(page.locator("#fileViewerTitle")).toHaveText("/home/user");
  // Directory mode has no stale download target.
  await expect(page.locator("#fileViewerDownload")).toBeHidden();
});

test("a file opened outside the explorer has no Back button", async ({ context, page }) => {
  await installRemoteExplorerMocks(context);
  await connectRemote(page);

  await page.locator("#navToggle").click();
  await page.locator("#fileViewerPath").fill("/home/user/notes.txt");
  await page.locator("#openFileViewer").click();
  await expect(page.locator("#fileViewerText")).toHaveText("fn main() {}");
  await expect(page.locator("#fileViewerBack")).toBeHidden();
});

test("empty, truncated and failing listings are reported", async ({ context, page }) => {
  await installRemoteExplorerMocks(context);
  await connectRemote(page);

  await page.locator("#fileExplorerHeader").click();
  await expect(page.locator("#fileViewerTitle")).toHaveText("/home/user");

  await page.locator(".file-viewer-directory-row", { hasText: "empty" }).click();
  await expect(page.locator(".file-viewer-directory-empty")).toHaveText("Empty directory");
  // The ".." row still walks out of an empty directory.
  await page.locator(".file-viewer-directory-row.parent").click();
  await expect(page.locator("#fileViewerTitle")).toHaveText("/home/user");

  await page.locator(".file-viewer-directory-row", { hasText: "huge" }).click();
  await expect(page.locator(".file-viewer-directory-row", { hasText: "first.txt" })).toBeVisible();
  await expect(page.locator("#fileViewerMessage")).toHaveText(
    "Listing truncated at the Remote entry limit.",
  );

  await page.locator(".file-viewer-directory-row.parent").click();
  await page.locator(".file-viewer-directory-row", { hasText: "denied" }).click();
  await expect(page.locator("#fileViewerMessage")).toContainText("Cannot read directory");
});

test("closing the explorer clears its state", async ({ context, page }) => {
  await installRemoteExplorerMocks(context);
  await connectRemote(page);

  await page.locator("#fileExplorerHeader").click();
  const overlay = page.locator("#fileViewerOverlay");
  await expect(overlay).toBeVisible();
  await expect(page.locator(".file-viewer-directory-row").first()).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(overlay).toBeHidden();
  await expect(page.locator(".file-viewer-directory-row")).toHaveCount(0);
  await expect(page.locator("#fileViewerTitle")).toHaveText("");
});

test("the explorer works at a mobile viewport", async ({ context, page }) => {
  await installRemoteExplorerMocks(context);
  await page.setViewportSize({ width: 390, height: 720 });
  await connectRemote(page);

  await page.locator("#fileExplorerHeader").click();
  await expect(page.locator("#fileViewerOverlay")).toBeVisible();
  const row = page.locator(".file-viewer-directory-row", { hasText: "repo" });
  await expect(row).toBeVisible();
  // Touch target: the row must be at least 44px tall.
  const box = await row.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  await row.click();
  await expect(page.locator("#fileViewerTitle")).toHaveText("/home/user/repo");
});

test("mobile terminal edge flicks open workspaces on the left and files on the right", async ({
  context,
  page,
}) => {
  const { listRequests } = await installRemoteExplorerMocks(context, true);
  await page.setViewportSize({ width: 390, height: 720 });
  await connectRemote(page, true);

  await flickTerminalEdge(page, "left");
  await expect(page.locator(".app")).toHaveClass(/nav-open/);
  await page.locator("#navScrim").evaluate((button: HTMLButtonElement) => button.click());

  await flickTerminalEdge(page, "right");
  await expect(page.locator("#fileViewerOverlay")).toBeVisible();
  await expect(page.locator("#fileViewerTitle")).toHaveText("/home/user");
  expect(listRequests.at(-1)?.body).toEqual({
    source: "terminalCwd",
    terminalId: "terminal-1",
  });
});

test("the device-local setting disables both terminal edge flicks", async ({ context, page }) => {
  await installRemoteExplorerMocks(context, true);
  await page.setViewportSize({ width: 390, height: 720 });
  await connectRemote(page, true);

  await page.locator("#navToggle").click();
  await page.locator("#drawerSettingsButton").click();
  await page.locator("#settingsTabDisplay").click();
  const toggle = page.locator("#edgeSwipeDrawersToggle");
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("laymux.remote.edgeSwipeDrawers")))
    .toBe("0");
  await page.locator("#navToggle").click();

  await flickTerminalEdge(page, "left");
  await expect(page.locator(".app")).not.toHaveClass(/nav-open/);
  await flickTerminalEdge(page, "right");
  await expect(page.locator("#fileViewerOverlay")).toBeHidden();
});

test("an enabled edge gesture still preserves a plain terminal tap", async ({ context, page }) => {
  await installRemoteExplorerMocks(context, true);
  await page.addInitScript(() => localStorage.setItem("laymux.remote.inputMode", "direct"));
  await page.setViewportSize({ width: 390, height: 720 });
  await connectRemote(page, true);

  await page
    .locator(".xterm-helper-textarea")
    .evaluate((input: HTMLTextAreaElement) => input.blur());
  await tapTerminalLeftEdge(page);

  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await expect(page.locator(".app")).not.toHaveClass(/nav-open/);
});
