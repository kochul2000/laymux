import { expect, test, type Page } from "@playwright/test";

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
      const frame = await showPreview(
        page,
        '<p>Loading...</p><div id="drawing" style="width:80px;height:80px;background:#ff0000"></div>',
        sandbox,
      );
      await expect(frame.getByText("Loading...")).toBeVisible();
      await expect(frame.locator("#drawing")).toBeVisible();
      await expect(frame.getByText(/PC의 브라우저/)).toHaveCount(0);
    });
  });
}
