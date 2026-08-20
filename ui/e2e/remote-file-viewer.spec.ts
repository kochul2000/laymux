import { expect, test, type BrowserContext } from "@playwright/test";
import { fulfillRemoteClientAsset } from "./remote-client-assets";

/** 1x1 PNG, so the image branch renders a real decodable bitmap. */
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

async function installRemoteViewerMocks(
  context: BrowserContext,
  options: { statusDelayMs?: number; renderDelayMs?: number; downloadStatus?: number } = {},
) {
  const renderRequests: Array<{
    url: string;
    authorization: string | null;
    lease: string | null;
    fileViewerCapability: string | null;
    body: Record<string, unknown>;
  }> = [];
  const downloadRequests: Array<{
    lease: string | null;
    fileViewerCapability: string | null;
    body: Record<string, unknown>;
  }> = [];
  let statusRequestCount = 0;
  let resolveFirstStatusResponse: (() => void) | null = null;
  const firstStatusResponse = new Promise<void>((resolve) => {
    resolveFirstStatusResponse = resolve;
  });

  await context.route("http://remote.test/remote/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (await fulfillRemoteClientAsset(route, url.pathname)) return;
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
      statusRequestCount += 1;
      expect(await request.headerValue("x-laymux-remote-file-viewer")).toBe("viewer-481");
      if (options.statusDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.statusDelayMs));
      }
      await route.fulfill({ json: { open: true, path: "C:\\work\\current.md" } });
      resolveFirstStatusResponse?.();
      resolveFirstStatusResponse = null;
      return;
    }
    if (url.pathname === "/remote/v1/file-viewer/download") {
      const body = JSON.parse(request.postData() || "{}") as Record<string, unknown>;
      downloadRequests.push({
        lease: await request.headerValue("x-laymux-remote-lease"),
        fileViewerCapability: await request.headerValue("x-laymux-remote-file-viewer"),
        body,
      });
      if (options.downloadStatus) {
        return route.fulfill({
          status: options.downloadStatus,
          json: { error: "File exceeds the 8388608 byte viewer limit" },
        });
      }
      const path = String(body.path || "");
      const name = path.split(/[\\/]/).pop() || "download";
      return route.fulfill({
        json: {
          path,
          name,
          mediaType: "text/html",
          // "<h1>host source</h1>" — the source, not the sanitized preview.
          base64: "PGgxPmhvc3Qgc291cmNlPC9oMT4=",
          size: 20,
        },
      });
    }
    if (url.pathname === "/remote/v1/file-viewer/render") {
      const body = JSON.parse(request.postData() || "{}") as Record<string, unknown>;
      renderRequests.push({
        url: request.url(),
        authorization: await request.headerValue("authorization"),
        lease: await request.headerValue("x-laymux-remote-lease"),
        fileViewerCapability: await request.headerValue("x-laymux-remote-file-viewer"),
        body,
      });
      if (options.renderDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.renderDelayMs));
      }
      const path = String(body.path || "");
      if (path.endsWith(".png")) {
        return route.fulfill({
          json: { kind: "image", path, dataUrl: PNG_DATA_URL, size: 68 },
        });
      }
      if (path.endsWith(".txt")) {
        return route.fulfill({
          json: { kind: "text", path, content: "plain host text", truncated: false },
        });
      }
      if (path.endsWith(".bin")) {
        return route.fulfill({ json: { kind: "binary", path, size: 4096 } });
      }
      return route.fulfill({
        json: {
          kind: "text",
          path,
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

  return {
    renderRequests,
    downloadRequests,
    firstStatusResponse,
    statusRequestCount: () => statusRequestCount,
  };
}

async function connectRemote(page: import("@playwright/test").Page) {
  await page.goto("http://remote.test/remote/");
  await page.locator("#token").fill("remote-secret");
  await page.locator("#connect").click();
  await expect(page.locator("#exit")).toBeEnabled();
}

test("renders a lease-gated host file in this document, not a second tab", async ({
  context,
  page,
}) => {
  const { renderRequests, firstStatusResponse, statusRequestCount } =
    await installRemoteViewerMocks(context);
  await connectRemote(page);

  await page.locator("#navToggle").click();
  await page.waitForTimeout(100);
  expect(statusRequestCount()).toBe(0);
  await expect(page.locator("#fileViewerPath")).toHaveValue("");
  await expect(page.locator("#pullHostFileViewerPath")).toHaveText("From host");
  await page.locator("#pullHostFileViewerPath").click();
  await firstStatusResponse;
  await expect(page.locator("#fileViewerPath")).toHaveValue("C:\\work\\current.md");
  await page.locator("#fileViewerPath").fill("C:\\work\\notes.html");

  // A popup would be the old contract; the overlay must appear without one.
  let popups = 0;
  page.on("popup", () => {
    popups += 1;
  });
  await page.locator("#openFileViewer").click();

  const overlay = page.locator("#fileViewerOverlay");
  await expect(overlay).toBeVisible();
  await expect(page.locator("#fileViewerTitle")).toHaveText("C:\\work\\notes.html");
  await expect(page.frameLocator("#fileViewerPreview").locator("h1")).toHaveText(
    "served from the Laymux host",
  );
  // The sandboxed iframe is the boundary, same origin either way (ADR-0041).
  expect(await page.locator("body").getAttribute("data-hacked")).toBeNull();
  expect(popups).toBe(0);
  expect(page.url()).toBe("http://remote.test/remote/");
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

test("Escape closes the viewer instead of reaching the terminal", async ({ context, page }) => {
  await installRemoteViewerMocks(context);
  await connectRemote(page);
  await page.locator("#navToggle").click();
  await page.locator("#fileViewerPath").fill("C:\\work\\notes.txt");
  await page.locator("#openFileViewer").click();

  const overlay = page.locator("#fileViewerOverlay");
  await expect(overlay).toBeVisible();
  await expect(page.locator("#fileViewerText")).toHaveText("plain host text");

  await page.keyboard.press("Escape");
  await expect(overlay).toBeHidden();
  // Closing must not leave the previous file behind for the next open.
  await expect(page.locator("#fileViewerText")).toHaveText("");
  await expect(page.locator("#fileViewerTitle")).toHaveText("");
});

test("the backdrop closes the viewer but the file itself does not", async ({ context, page }) => {
  await installRemoteViewerMocks(context);
  await connectRemote(page);
  await page.locator("#navToggle").click();
  await page.locator("#fileViewerPath").fill("C:\\work\\notes.txt");
  await page.locator("#openFileViewer").click();

  const overlay = page.locator("#fileViewerOverlay");
  await expect(overlay).toBeVisible();
  await page.locator("#fileViewerText").click();
  await expect(overlay).toBeVisible();

  // Click the padding strip of the scrim, outside the dialog box.
  await overlay.click({ position: { x: 2, y: 2 } });
  await expect(overlay).toBeHidden();
});

test("zoom applies to an image and resets between files", async ({ context, page }) => {
  await installRemoteViewerMocks(context);
  await connectRemote(page);
  await page.locator("#navToggle").click();
  await page.locator("#fileViewerPath").fill("C:\\work\\shot.png");
  await page.locator("#openFileViewer").click();

  await expect(page.locator("#fileViewerImage")).toBeVisible();
  await expect(page.locator("#fileViewerZoom")).toBeVisible();
  await expect(page.locator("#fileViewerZoomLevel")).toHaveText("100%");

  await page.locator("#fileViewerZoomIn").click();
  await expect(page.locator("#fileViewerZoomLevel")).toHaveText("125%");
  // Real width, not a transform, so the scroll container can reach the parts
  // the zoom pushed off screen.
  await expect(page.locator("#fileViewerBody")).toHaveAttribute(
    "style",
    /--file-viewer-image-width: 125%/,
  );

  await page.locator("#fileViewerZoomReset").click();
  await expect(page.locator("#fileViewerZoomLevel")).toHaveText("100%");

  await page.locator("#fileViewerClose").click();
  await page.locator("#fileViewerPath").fill("C:\\work\\blob.bin");
  await page.locator("#openFileViewer").click();
  await expect(page.locator("#fileViewerBinary")).toHaveText(
    "Binary or unsupported file · 4.00 KiB",
  );
  // A binary placeholder has nothing to zoom.
  await expect(page.locator("#fileViewerZoom")).toBeHidden();
});

test("a stale render never lands in the overlay of a newer file", async ({ context, page }) => {
  await installRemoteViewerMocks(context, { renderDelayMs: 300 });
  await connectRemote(page);
  await page.locator("#navToggle").click();
  await page.locator("#fileViewerPath").fill("C:\\work\\first.txt");
  await page.locator("#openFileViewer").click();
  await expect(page.locator("#fileViewerOverlay")).toBeVisible();

  await page.locator("#fileViewerClose").click();
  await expect(page.locator("#fileViewerOverlay")).toBeHidden();
  await page.waitForTimeout(400);
  // The in-flight response for the closed file must not reopen anything.
  await expect(page.locator("#fileViewerOverlay")).toBeHidden();
  await expect(page.locator("#fileViewerText")).toHaveText("");
});

test("keeps a newer edit when a host path request finishes", async ({ context, page }) => {
  const { firstStatusResponse } = await installRemoteViewerMocks(context, { statusDelayMs: 200 });
  await connectRemote(page);
  await page.locator("#navToggle").click();

  await page.locator("#fileViewerPath").fill("C:\\work\\draft.txt");
  await page.locator("#pullHostFileViewerPath").click();
  await expect(page.locator("#pullHostFileViewerPath")).toBeDisabled();
  await page.locator("#fileViewerPath").fill("C:\\work\\newer.txt");
  await firstStatusResponse;

  await expect(page.locator("#fileViewerPath")).toHaveValue("C:\\work\\newer.txt");
  await expect(page.locator("#fileViewerStatus")).toHaveText(
    "Host path was not applied because the input changed.",
  );
});

test("does not open a path while IME is committing Enter", async ({ context, page }) => {
  const { renderRequests } = await installRemoteViewerMocks(context);
  await connectRemote(page);
  await page.locator("#navToggle").click();
  const input = page.locator("#fileViewerPath");
  await input.fill("C:\\work\\한글.md");

  await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
  await input.evaluate((element) => {
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    Object.defineProperty(event, "keyCode", { get: () => 229 });
    element.dispatchEvent(event);
  });

  await expect(page.locator("#fileViewerOverlay")).toBeHidden();
  expect(renderRequests).toEqual([]);
});

test("keeps the file viewer drawer usable at mobile width", async ({ context, page }) => {
  await installRemoteViewerMocks(context);
  await page.setViewportSize({ width: 320, height: 640 });
  await connectRemote(page);
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

  await page.locator("#openFileViewer").click();
  await expect(page.locator("#fileViewerOverlay")).toBeVisible();
  // The overlay is the reading surface on a phone: it must not push the page
  // sideways, and the header must stay on one line.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  const header = await page.locator(".file-viewer-header").evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(header.scrollWidth).toBe(header.clientWidth);
});

test("downloads the host bytes, not the rendered preview", async ({ context, page }) => {
  const { downloadRequests } = await installRemoteViewerMocks(context);
  await connectRemote(page);
  await page.locator("#navToggle").click();
  // An HTML file is the case that matters: `render` replaces its source with a
  // sanitized preview document, so a save built from the overlay would write
  // the wrong bytes.
  await page.locator("#fileViewerPath").fill("C:\\work\\notes.html");
  await page.locator("#openFileViewer").click();
  await expect(page.locator("#fileViewerOverlay")).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.locator("#fileViewerDownload").click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toBe("notes.html");
  expect(downloadRequests).toEqual([
    {
      lease: "lease-481",
      fileViewerCapability: "viewer-481",
      body: { path: "C:\\work\\notes.html" },
    },
  ]);
});

test("a download failure is reported without closing the viewer", async ({ context, page }) => {
  await installRemoteViewerMocks(context, { downloadStatus: 413 });
  await connectRemote(page);
  await page.locator("#navToggle").click();
  await page.locator("#fileViewerPath").fill("C:\\work\\huge.bin");
  await page.locator("#openFileViewer").click();
  await expect(page.locator("#fileViewerOverlay")).toBeVisible();

  await page.locator("#fileViewerDownload").click();
  await expect(page.locator("#fileViewerMessage")).toHaveText(
    "File exceeds the 8388608 byte viewer limit",
  );
  await expect(page.locator("#fileViewerMessage")).toHaveClass(/error/);
  await expect(page.locator("#fileViewerOverlay")).toBeVisible();
  // The button has to come back, not stay stuck on "Saving...".
  await expect(page.locator("#fileViewerDownload")).toBeEnabled();
  await expect(page.locator("#fileViewerDownload")).toHaveText("Download");
});
