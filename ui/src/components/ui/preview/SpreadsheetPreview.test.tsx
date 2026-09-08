import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpreadsheetPreview } from "./SpreadsheetPreview";
import {
  openSpreadsheetForViewer,
  nextSpreadsheetForViewer,
  closeSpreadsheetForViewer,
} from "@/lib/tauri-api";
const readSpreadsheetForViewer = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri-api", () => ({
  openSpreadsheetForViewer: vi.fn(async (path, sheet) => {
    const content = await readSpreadsheetForViewer(path, sheet);
    return { content, sessionId: path, loadedRows: content.totalRows, hasMore: false };
  }),
  nextSpreadsheetForViewer: vi.fn(),
  closeSpreadsheetForViewer: vi.fn().mockResolvedValue(undefined),
}));

const data = {
  sheetNames: ["매출", "빈 시트"],
  sheet: "매출",
  cells: [
    { row: 0, column: 0, value: "상품" },
    { row: 1, column: 0, value: "사과" },
    { row: 1, column: 1, value: "10" },
    { row: 55, column: 0, value: "사과 주스" },
  ],
  totalRows: 56,
  totalColumns: 2,
  truncated: false,
};

describe("SpreadsheetPreview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    HTMLElement.prototype.scrollTo = vi.fn();
    vi.mocked(readSpreadsheetForViewer).mockResolvedValue(data);
  });

  it("searches the whole loaded sheet and copies matches outside the current page", async () => {
    render(<SpreadsheetPreview path="/test.xlsx" />);
    await screen.findByText("상품");
    expect(screen.queryByText("사과 주스")).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId("spreadsheet-search"), { target: { value: "사과" } });
    expect(screen.getByText("사과 주스")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select all cells" }));
    const copied = copySelection();
    expect(copied).toHaveBeenCalledWith("text/plain", "사과\t10\n사과 주스\t");
    fireEvent.click(screen.getByText("10"));
    expect(copySelection()).toHaveBeenCalledWith("text/plain", "10");
  });

  it("switches sheets and reports empty/truncated sheets", async () => {
    render(<SpreadsheetPreview path="/test.ods" />);
    await screen.findByText("상품");
    vi.mocked(readSpreadsheetForViewer).mockResolvedValue({
      ...data,
      sheet: "빈 시트",
      cells: [],
      totalRows: 0,
      totalColumns: 0,
      truncated: true,
    });
    fireEvent.change(screen.getByTestId("spreadsheet-sheet"), { target: { value: "빈 시트" } });
    await screen.findByTestId("spreadsheet-empty");
    expect(screen.getByTestId("spreadsheet-truncated")).toBeVisible();
    expect(readSpreadsheetForViewer).toHaveBeenLastCalledWith("/test.ods", "빈 시트");
  });

  it("preserves TSV cell boundaries", async () => {
    vi.mocked(readSpreadsheetForViewer).mockResolvedValue({
      ...data,
      totalRows: 1,
      cells: [
        { row: 0, column: 0, value: 'a\tb\n"c"' },
        { row: 0, column: 1, value: "<script>bad</script>" },
      ],
    });
    render(<SpreadsheetPreview path="/test.xlsx" />);
    await screen.findByText("<script>bad</script>");
    fireEvent.click(screen.getByRole("button", { name: "Select all cells" }));
    const copied = copySelection();
    expect(copied).toHaveBeenCalledWith("text/plain", '"a\tb\n""c"""\t<script>bad</script>');
  });

  it("retains the sheet selector after a failed read so another sheet can be opened", async () => {
    render(<SpreadsheetPreview path="/test.xlsx" />);
    await screen.findByText("상품");
    vi.mocked(readSpreadsheetForViewer).mockRejectedValueOnce(new Error("broken sheet"));
    fireEvent.change(screen.getByTestId("spreadsheet-sheet"), { target: { value: "빈 시트" } });
    await screen.findByTestId("spreadsheet-error");
    fireEvent.change(screen.getByTestId("spreadsheet-sheet"), { target: { value: "매출" } });
    await screen.findByText("상품");
  });

  it("discards a response after the file changes", async () => {
    let finish!: (value: typeof data) => void;
    vi.mocked(readSpreadsheetForViewer).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(<SpreadsheetPreview path="/old.xls" />);
    view.rerender(<SpreadsheetPreview path="/new.xlsb" />);
    await screen.findByText("상품");
    await act(async () => finish({ ...data, cells: [{ row: 0, column: 0, value: "stale" }] }));
    expect(screen.queryByText("stale")).not.toBeInTheDocument();
    expect(closeSpreadsheetForViewer).toHaveBeenCalledWith("/old.xls");
  });
});

function copySelection() {
  const setData = vi.fn();
  fireEvent.copy(screen.getByTestId("spreadsheet-grid"), { clipboardData: { setData } });
  return setData;
}

it("reads another window only on demand and allows only one pending request", async () => {
  const content = {
    ...data,
    totalRows: 100,
    totalColumns: 1,
    cells: [{ row: 0, column: 0, value: "first" }],
  };
  vi.mocked(openSpreadsheetForViewer).mockResolvedValueOnce({
    sessionId: "stream",
    content,
    loadedRows: 100,
    hasMore: true,
  });
  let finish!: (value: Awaited<ReturnType<typeof nextSpreadsheetForViewer>>) => void;
  vi.mocked(nextSpreadsheetForViewer).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(<SpreadsheetPreview path="/stream.xlsx" />);
  await screen.findByText("first");
  expect(nextSpreadsheetForViewer).not.toHaveBeenCalled();
  const grid = screen.getByTestId("spreadsheet-grid");
  fireEvent.scroll(grid);
  fireEvent.scroll(grid);
  expect(nextSpreadsheetForViewer).toHaveBeenCalledTimes(1);
  await act(async () =>
    finish({
      sessionId: "stream",
      loadedRows: 101,
      hasMore: false,
      content: { ...content, cells: [{ row: 100, column: 0, value: "last" }] },
    }),
  );
  fireEvent.change(screen.getByTestId("spreadsheet-search"), { target: { value: "last" } });
  expect(screen.getByText("last")).toBeVisible();
  view.unmount();
  expect(closeSpreadsheetForViewer).toHaveBeenCalledWith("stream");
});

it("selects rows, columns and a dragged rectangle", async () => {
  vi.mocked(readSpreadsheetForViewer).mockResolvedValue({ ...data, totalRows: 3 });
  render(<SpreadsheetPreview path="/selection.xlsx" />);
  await screen.findByText("상품");
  fireEvent.click(screen.getByRole("button", { name: "Select row 2" }));
  expect(copySelection()).toHaveBeenCalledWith("text/plain", "사과\t10");
  fireEvent.click(screen.getByRole("button", { name: "Select column B" }));
  expect(copySelection()).toHaveBeenCalledWith("text/plain", "\n10\n");
  fireEvent.mouseDown(screen.getByRole("button", { name: "A1: 상품" }), { button: 0, buttons: 1 });
  fireEvent.mouseEnter(screen.getByRole("button", { name: "B2: 10" }), { buttons: 1 });
  fireEvent.mouseUp(window);
  expect(copySelection()).toHaveBeenCalledWith("text/plain", "상품\t\n사과\t10");
  expect(screen.queryByTestId("spreadsheet-pagination")).not.toBeInTheDocument();
});

it("windows a long sheet while preserving offscreen selection and resetting search", async () => {
  HTMLElement.prototype.scrollTo = vi.fn();
  vi.mocked(readSpreadsheetForViewer).mockResolvedValue({
    ...data,
    totalRows: 10000,
    totalColumns: 1,
    cells: [
      { row: 0, column: 0, value: "start" },
      { row: 9999, column: 0, value: "end" },
    ],
  });
  render(<SpreadsheetPreview path="/long.xlsx" />);
  await screen.findByText("start");
  const grid = screen.getByTestId("spreadsheet-grid");
  expect(grid.querySelectorAll("tbody tr[data-row]").length).toBeLessThan(50);
  fireEvent.click(screen.getByRole("button", { name: "Select column A" }));
  expect(copySelection()).toHaveBeenCalledWith("text/plain", "start" + "\n".repeat(9999) + "end");
  fireEvent.scroll(grid, { target: { scrollTop: 280000 } });
  expect(screen.getByText("end")).toBeVisible();
  expect(screen.queryByText("start")).not.toBeInTheDocument();
  expect(copySelection()).toHaveBeenCalledWith("text/plain", "start" + "\n".repeat(9999) + "end");
  fireEvent.change(screen.getByTestId("spreadsheet-search"), { target: { value: "start" } });
  expect(screen.getByText("start")).toBeVisible();
  expect(copySelection()).not.toHaveBeenCalled();
});

it("windows wide sheets without stretching small sheets", async () => {
  vi.mocked(readSpreadsheetForViewer).mockResolvedValue({
    ...data,
    totalRows: 10000,
    totalColumns: 256,
    cells: [
      { row: 0, column: 0, value: "left" },
      { row: 0, column: 255, value: "right" },
    ],
  });
  render(<SpreadsheetPreview path="/wide.xlsx" />);
  await screen.findByText("left");
  const grid = screen.getByTestId("spreadsheet-grid");
  expect(grid.querySelectorAll("td").length).toBeLessThan(500);
  fireEvent.scroll(grid, { target: { scrollLeft: 36200 } });
  expect(screen.getByText("right")).toBeVisible();
  expect(screen.queryByText("left")).not.toBeInTheDocument();
  expect(grid.querySelectorAll("td").length).toBeLessThan(500);
});
