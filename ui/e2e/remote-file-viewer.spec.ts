import { expect, test, type BrowserContext } from "@playwright/test";
import { fileURLToPath } from "node:url";

const remoteRoot = fileURLToPath(new URL("../../src-tauri/src/remote_server/", import.meta.url));

async function installRemoteViewerMocks(context: BrowserContext) {
  const renderRequests: Array<{
    url: string;
    authorization: string | null;
    lease: string | null;
    fileViewerCapability: string | null;
    body: Record<string, unknown>;
  }> = [];

  await context.route("http://remote.test/remote/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/remote/") {
      return route.fulfill({
        path: `${remoteRoot}page.html`,
        contentType: "text/html; charset=utf-8",
      });
    }
    if (url.pathname === "/remote/viewer/") {
      return route.fulfill({
        path: `${remoteRoot}viewer_page.html`,
        contentType: "text/html; charset=utf-8",
        headers: {
          "content-security-policy":
            "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'",
        },
      });
    }
    if (url.pathname === "/remote/viewer/viewer.js") {
      return route.fulfill({
        path: `${remoteRoot}viewer_page.js`,
        contentType: "text/javascript; charset=utf-8",
      });
    }
    if (url.pathname === "/remote/vendor/xterm.js") {
      return route.fulfill({
        path: `${remoteRoot}assets/xterm.js`,
        contentType: "application/javascript; charset=utf-8",
      });
    }
    if (url.pathname === "/remote/vendor/addon-fit.js") {
      return route.fulfill({
        path: `${remoteRoot}assets/addon-fit.js`,
        contentType: "application/javascript; charset=utf-8",
      });
    }
    if (url.pathname === "/remote/vendor/xterm.css") {
      return route.fulfill({
        path: `${remoteRoot}assets/xterm.css`,
        contentType: "text/css; charset=utf-8",
      });
    }
    if (url.pathname === "/remote/v1/session/claim") {
      return route.fulfill({
        json: {
          active: true,
          leaseId: "lease-481",
          resumeToken: "resume-481",
          fileViewerToken: "viewer-481",
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
    if (url.pathname === "/remote/v1/file-viewer/status") {
      expect(await request.headerValue("x-laymux-remote-file-viewer")).toBe("viewer-481");
      return route.fulfill({ json: { open: true, path: "C:\\work\\current.md" } });
    }
    if (url.pathname === "/remote/v1/file-viewer/render") {
      renderRequests.push({
        url: request.url(),
        authorization: await request.headerValue("authorization"),
        lease: await request.headerValue("x-laymux-remote-lease"),
        fileViewerCapability: await request.headerValue("x-laymux-remote-file-viewer"),
        body: JSON.parse(request.postData() || "{}") as Record<string, unknown>,
      });
      return route.fulfill({
        json: {
          kind: "text",
          path: "C:\\work\\notes.html",
          content: "<h1>served from the Laymux host</h1>",
          truncated: false,
          previewKind: "html",
          previewDocument:
            "<!doctype html><html><body><h1>served from the Laymux host</h1><script>parent.document.body.dataset.hacked='true'</script></body></html>",
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: "not mocked" } });
  });

  return renderRequests;
}

test("opens a lease-gated host file in a credential-free new tab", async ({ context, page }) => {
  const renderRequests = await installRemoteViewerMocks(context);
  await page.goto("http://remote.test/remote/");
  await page.locator("#token").fill("remote-secret");
  await page.locator("#connect").click();
  await expect(page.locator("#release")).toBeEnabled();

  await page.locator("#navToggle").click();
  await expect(page.locator("#fileViewerStatus")).toHaveText("C:\\work\\current.md");
  await page.locator("#fileViewerPath").fill("C:\\work\\notes.html");

  const popupPromise = page.waitForEvent("popup");
  await page.locator("#openFileViewerPath").click();
  const popup = await popupPromise;

  await expect(popup.frameLocator("#preview").locator("h1")).toHaveText(
    "served from the Laymux host",
  );
  await expect(popup).toHaveTitle("Laymux File Viewer");
  expect(await popup.locator("body").getAttribute("data-hacked")).toBeNull();
  expect(popup.url()).toBe("http://remote.test/remote/viewer/");
  expect(popup.url()).not.toContain("remote-secret");
  expect(popup.url()).not.toContain("lease-481");
  expect(popup.url()).not.toContain("notes.html");
  expect(renderRequests).toEqual([
    {
      url: "http://remote.test/remote/v1/file-viewer/render",
      authorization: "Bearer remote-secret",
      lease: "lease-481",
      fileViewerCapability: "viewer-481",
      body: { source: "path", path: "C:\\work\\notes.html" },
    },
  ]);
});

test("does not open a path while IME is committing Enter", async ({ context, page }) => {
  await installRemoteViewerMocks(context);
  await page.goto("http://remote.test/remote/");
  await page.locator("#token").fill("remote-secret");
  await page.locator("#connect").click();
  await page.locator("#navToggle").click();
  const input = page.locator("#fileViewerPath");
  await input.fill("C:\\work\\한글.md");
  await page.evaluate(() => {
    (window as Window & { fileViewerOpenCalls?: number }).fileViewerOpenCalls = 0;
    window.open = () => {
      (window as Window & { fileViewerOpenCalls?: number }).fileViewerOpenCalls! += 1;
      return null;
    };
  });

  await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
  await input.evaluate((element) => {
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    Object.defineProperty(event, "keyCode", { get: () => 229 });
    element.dispatchEvent(event);
  });

  expect(
    await page.evaluate(
      () => (window as Window & { fileViewerOpenCalls?: number }).fileViewerOpenCalls,
    ),
  ).toBe(0);
});

test("keeps the file viewer drawer usable at mobile width", async ({ context, page }) => {
  await installRemoteViewerMocks(context);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("http://remote.test/remote/");
  await page.locator("#token").fill("remote-secret");
  await page.locator("#connect").click();
  await page.locator("#navToggle").click();
  await page
    .locator("#fileViewerPath")
    .fill("/tmp/a very long file name that must stay inside.txt");
  await expect(page.locator("#fileViewerPath")).toHaveAttribute("autocapitalize", "off");

  const panel = await page.locator("#fileViewerSection").evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    inputWidth: element.querySelector("input")?.getBoundingClientRect().width || 0,
  }));
  expect(panel.scrollWidth).toBe(panel.clientWidth);
  expect(panel.inputWidth).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
});
