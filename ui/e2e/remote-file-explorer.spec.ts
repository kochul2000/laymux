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

async function installRemoteExplorerMocks(context: BrowserContext) {
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
      return route.fulfill({
        json: {
          activeWorkspace: null,
          workspaces: [],
          docks: [],
          terminals: [],
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

  return { listRequests, renderRequests };
}

async function connectRemote(page: Page) {
  await page.goto("http://remote.test/remote/");
  await page.locator("#token").fill("remote-secret");
  await page.locator("#connect").click();
  await expect(page.locator("#exit")).toBeEnabled();
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
  await expect(rows).toHaveCount(7); // ".." + four dirs + two files
  await expect(rows.nth(0)).toHaveText("..");
  await expect(rows.nth(1)).toContainText("repo");
  // A hostile entry name stays text, never markup.
  await expect(rows.nth(5)).toContainText("<img src=x onerror=alert(1)>.txt");

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
