import { test, expect } from "./fixtures";

test("four spreadsheet extensions open in the viewer with sheet search and TSV copy", async ({
  appPage: page,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(() => {
    const host = window as unknown as {
      __TAURI_INTERNALS__: {
        invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
      };
    };
    const original = host.__TAURI_INTERNALS__.invoke;
    host.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
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
    await page.getByRole("button", { name: "Select all cells" }).click();
    await page.keyboard.press("Control+c");
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("사과\t12\t\n사과 주스\t\t");
    await page.getByTestId("spreadsheet-sheet").selectOption("재고");
    await expect(page.getByText("<img src=x onerror=alert(1)>", { exact: true })).toBeVisible();
    await expect(page.getByTestId("spreadsheet-preview").locator("img")).toHaveCount(0);
  }
  await page.getByTestId("spreadsheet-sheet").selectOption("매출");
  await expect(page.getByText("상품", { exact: true })).toBeVisible();
  expect(
    await page
      .getByTestId("spreadsheet-grid")
      .locator("table")
      .evaluate((table) => table.getBoundingClientRect().width),
  ).toBe(488);
  const start = await page.getByRole("button", { name: "A1: 상품" }).boundingBox();
  const end = await page.getByRole("button", { name: "B2: 12" }).boundingBox();
  if (!start || !end) throw new Error("Missing spreadsheet cells");
  await page.mouse.move(start.x + 4, start.y + 4);
  await page.mouse.down();
  await page.mouse.move(end.x + 4, end.y + 4, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.press("Control+c");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("상품\t수량\n사과\t12");
  await page.getByRole("button", { name: "Select column A" }).click();
  await page.getByTestId("spreadsheet-grid").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.getByRole("button", { name: "A56: 사과 주스" })).toBeVisible();
  await page.keyboard.press("Control+c");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("상품\n사과" + "\n".repeat(54) + "사과 주스");
  await page.getByTestId("spreadsheet-grid").evaluate((element) => {
    element.scrollTop = 0;
  });
  const gridBox = await page.getByTestId("spreadsheet-grid").boundingBox();
  if (!gridBox) throw new Error("Missing grid");
  await page.mouse.move(start.x + 4, start.y + 4);
  await page.mouse.down();
  await page.mouse.move(start.x + 4, gridBox.y + gridBox.height - 3, { steps: 5 });
  await expect
    .poll(() => page.getByTestId("spreadsheet-grid").evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await page.mouse.up();
  await page.getByTestId("spreadsheet-grid").evaluate((element) => {
    element.scrollTop = 0;
  });
  await page
    .getByTestId("file-viewer-overlay")
    .screenshot({ path: "../.screenshots/spreadsheet-viewer-e2e.png" });
});

test("extends column selection while horizontally auto-scrolling", async ({ appPage: page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(() => {
    const host = window as unknown as {
      __TAURI_INTERNALS__: {
        invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
      };
    };
    const original = host.__TAURI_INTERNALS__.invoke;
    host.__TAURI_INTERNALS__.invoke = async (cmd, args) =>
      cmd === "read_spreadsheet_for_viewer"
        ? {
            sheetNames: ["Wide"],
            sheet: "Wide",
            totalRows: 2,
            totalColumns: 30,
            truncated: false,
            cells: Array.from({ length: 30 }, (_, column) => ({
              row: 0,
              column,
              value: String(column),
            })),
          }
        : original(cmd, args);
  });
  await page.keyboard.press("Control+Shift+O");
  await page.getByTestId("file-viewer-overlay-path-input").fill("C:/wide.xlsx");
  await page.getByTestId("file-viewer-overlay-path-submit").click();
  const header = page.getByRole("button", { name: "Select column A", exact: true });
  await expect(header).toBeVisible();
  const a = await header.boundingBox();
  const grid = page.getByTestId("spreadsheet-grid");
  const rect = await grid.boundingBox();
  if (!a || !rect) throw new Error("Missing header");
  await page.mouse.move(a.x + 10, a.y + 10);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width + 10, a.y + 10, { steps: 10 });
  await expect.poll(() => grid.evaluate((element) => element.scrollLeft)).toBeGreaterThan(450);
  await page.mouse.up();
  await page.keyboard.press("Control+c");
  await expect
    .poll(async () => {
      const text = await page.evaluate(() => navigator.clipboard.readText());
      return text.split("\n")[0].split("\t").length;
    })
    .toBeGreaterThan(Math.floor(rect.width / 144) + 1);
});
