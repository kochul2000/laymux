import { type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { expect, test } from "./fixtures";

test("제공 HTML 구조가 SPA fallback으로 열리고 PC 버튼이 원본 파일을 전달한다", async ({
  appPage: page,
}) => {
  const source = process.env.LAYMUX_HTML_PREVIEW_REPRO_FILE
    ? await readFile(process.env.LAYMUX_HTML_PREVIEW_REPRO_FILE, "utf8")
    : '<div id="printer-container"></div><script>window.PrinterApp.mountPrinter()</script>';
  const path = "/tmp/dd-presentation-r15/dd.preview.html";
  await page.evaluate((source) => {
    const host = window as unknown as {
      __TAURI_INTERNALS__: {
        invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
      };
      htmlOsOpenRequests: Record<string, unknown>[];
    };
    host.htmlOsOpenRequests = [];
    const original = host.__TAURI_INTERNALS__.invoke;
    host.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === "read_file_for_viewer")
        return { kind: "text", content: source, truncated: false };
      if (cmd === "open_in_os") {
        host.htmlOsOpenRequests.push(args);
        return;
      }
      return original(cmd, args);
    };
  }, source);
  await page.keyboard.press("Control+Shift+O");
  await page.getByTestId("file-viewer-overlay-path-input").fill(path);
  await page.getByTestId("file-viewer-overlay-path-submit").click();
  await expect(page.getByTestId("file-viewer-html-empty")).toBeVisible();
  const open = page.getByTestId("file-viewer-html-os-open");
  await expect(open).toBeVisible();
  const requests = () =>
    page.evaluate(
      () =>
        (window as unknown as { htmlOsOpenRequests: Record<string, unknown>[] }).htmlOsOpenRequests,
    );
  expect(await requests()).toEqual([]);
  await page
    .getByTestId("file-viewer-overlay")
    .screenshot({ path: "../.screenshots/html-spa-fallback.png" });
  page.on("dialog", (dialog) => dialog.accept());
  await open.click();
  await expect.poll(requests).toEqual([{ path, wslDistro: null, mode: "open" }]);
  await page.getByTestId("file-viewer-source-mode").click();
  await expect(page.getByTestId("file-viewer-text")).toContainText("printer-container");
  await expect(open).toHaveCount(0);
});

async function showPreview(page: Page, source: string, sandbox: string) {
  await page.route("**/__html-preview", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }),
  );
  await page.goto("/__html-preview");
  await page.evaluate(
    async ({ source, sandbox }) => {
      const modulePath = "/src/lib/file-preview.ts";
      const { htmlToSafePreviewDocument } = await import(/* @vite-ignore */ modulePath);
      const frame = document.createElement("iframe");
      frame.title = "HTML preview";
      frame.setAttribute("sandbox", sandbox);
      frame.style.cssText = "width:100%;height:500px;border:0";
      frame.srcdoc = htmlToSafePreviewDocument(source);
      document.body.append(frame);
    },
    { source, sandbox },
  );
  return page.frameLocator("iframe");
}

for (const sandbox of ["", "allow-same-origin"]) {
  test.describe(`HTML 미리보기 sandbox=${sandbox || "Remote"}`, () => {
    test("빈 SPA와 숨긴 본문은 실제 iframe에서 안내가 보인다", async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 640 });
      for (const source of [
        '<div id="printer-container"></div><script>mountPrinter()</script>',
        '<div id="root" style="width:100%;height:100vh"></div>',
        '<div style="display:none"><p>Report</p></div>',
        '<div style="content-visibility:hidden"><p>Report</p></div>',
        '<div style="visibility:hidden">Report</div>',
        '<div style="opacity:0">Report</div>',
        '<div style="font-size:0">Report</div>',
      ]) {
        const frame = await showPreview(page, source, sandbox);
        await expect(
          frame.getByText(/PC의 브라우저 등 외부 프로그램으로 열어 주세요/),
        ).toBeVisible();
        await expect(frame.locator("script")).toHaveCount(0);
      }
    });

    test("로딩 문구와 CSS 도형을 정상 콘텐츠로 보존한다", async ({ page }) => {
      const loadingFrame = await showPreview(page, "<p>Loading...</p>", sandbox);
      await expect(loadingFrame.getByText("Loading...")).toBeVisible();
      await expect(loadingFrame.getByText(/PC의 브라우저/)).toHaveCount(0);
      const frame = await showPreview(
        page,
        '<div id="drawing" style="content-visibility:hidden;width:80px;height:80px;background:#ff0000"></div>',
        sandbox,
      );
      await expect(frame.locator("#drawing")).toBeVisible();
      await expect(frame.getByText(/PC의 브라우저/)).toHaveCount(0);
    });
  });
}
