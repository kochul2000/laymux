import { test, expect } from "./fixtures";

test("four spreadsheet extensions open in the viewer with sheet search and TSV copy", async ({
  appPage: page,
}) => {
  await page.evaluate(() => {
    const host = window as unknown as {
      __TAURI_INTERNALS__: {
        invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
      };
      spreadsheetCopy: string;
    };
    const original = host.__TAURI_INTERNALS__.invoke;
    host.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === "clipboard_write_text") {
        host.spreadsheetCopy = String(args.text);
        return;
      }
      if (cmd === "read_spreadsheet_for_viewer") {
        const sheet = args.sheet ?? "매출";
        return {
          sheetNames: ["매출", "재고"],
          sheet,
          totalRows: 56,
          totalColumns: 3,
          truncated: false,
          cells:
            sheet === "매출"
              ? [
                  { row: 0, column: 0, value: "상품" },
                  { row: 0, column: 1, value: "수량" },
                  { row: 1, column: 0, value: "사과" },
                  { row: 1, column: 1, value: "12" },
                  { row: 55, column: 0, value: "사과 주스" },
                ]
              : [{ row: 0, column: 0, value: "<img src=x onerror=alert(1)>" }],
        };
      }
      return original(cmd, args);
    };
  });
  await page.keyboard.press("Control+Shift+O");
  const path = page.getByTestId("file-viewer-overlay-path-input");
  for (const extension of ["xls", "XLSX", "xlsb", "ods"]) {
    await path.fill("C:/data/report." + extension);
    await page.getByTestId("file-viewer-overlay-path-submit").click();
    await expect(page.getByText("상품", { exact: true })).toBeVisible();
    const search = page.getByTestId("spreadsheet-search");
    await search.fill("사과");
    await expect(page.getByText("사과 주스", { exact: true })).toBeVisible();
    await page.getByTestId("spreadsheet-copy").click();
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { spreadsheetCopy: string }).spreadsheetCopy),
      )
      .toBe("사과\t12\t\n사과 주스\t\t");
    await page.getByTestId("spreadsheet-sheet").selectOption("재고");
    await expect(page.getByText("<img src=x onerror=alert(1)>", { exact: true })).toBeVisible();
    await expect(page.getByTestId("spreadsheet-preview").locator("img")).toHaveCount(0);
  }
  await page.getByTestId("spreadsheet-sheet").selectOption("매출");
  await expect(page.getByText("상품", { exact: true })).toBeVisible();
  await page
    .getByTestId("file-viewer-overlay")
    .screenshot({ path: "../.screenshots/spreadsheet-viewer-e2e.png" });
});
