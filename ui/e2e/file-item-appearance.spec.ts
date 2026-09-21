import { test, expect } from "./fixtures";

test("viewer explorer and archive entries use the same kind icons and colors", async ({
  appPage: page,
}, testInfo) => {
  await page.evaluate(() => {
    const host = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> };
    };
    const invoke = host.__TAURI_INTERNALS__.invoke;
    const entries = [
      { name: "folder", isDirectory: true, isSymlink: false, isExecutable: false, size: 0 },
      { name: "notes.txt", isDirectory: false, isSymlink: false, isExecutable: false, size: 24 },
      { name: "current", isDirectory: false, isSymlink: true, isExecutable: false, size: 8 },
    ];
    host.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === "list_directory") return entries;
      if (cmd === "read_file_for_viewer") {
        return {
          kind: "archive",
          format: "zip",
          totalEntries: 2,
          totalBytes: 24,
          truncated: false,
          entries: entries.slice(0, 2).map((entry) => ({ ...entry, compressedSize: entry.size })),
        };
      }
      return invoke(cmd, args);
    };
  });
  await page.keyboard.press("Control+Shift+O");
  await page.getByTestId("file-viewer-overlay-path-input").fill("C:/work/sample.zip");
  await page.getByTestId("file-viewer-overlay-path-submit").click();
  const explorer = page.getByTestId("file-viewer-overlay-explorer");
  for (const [index, icon, color] of [
    [0, "folder-up", "rgb(137, 180, 250)"],
    [1, "folder", "rgb(137, 180, 250)"],
    [2, "file", "rgb(205, 214, 244)"],
    [3, "link", "rgb(166, 227, 161)"],
  ] as const) {
    const row = explorer.getByTestId(`file-explorer-item-${index}`);
    await expect(row).toHaveCSS("color", color);
    await expect(row.locator(`.lucide-${icon}`)).toHaveCSS("color", color);
    await expect(row.locator("svg")).toHaveAttribute("width", "13");
  }
  for (const [name, icon, color] of [
    ["folder", "folder", "rgb(137, 180, 250)"],
    ["notes.txt", "file", "rgb(205, 214, 244)"],
  ]) {
    const row = page.getByTestId("archive-preview-row").filter({ hasText: name });
    await expect(row.locator("td").first()).toHaveCSS("color", color);
    await expect(row.locator(`.lucide-${icon}`)).toHaveCSS("color", color);
    await expect(row.locator("svg")).toHaveAttribute("width", "13");
  }
  await page.screenshot({ path: testInfo.outputPath("viewer-file-items.png") });
});
