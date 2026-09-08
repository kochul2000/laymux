import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpreadsheetPreview } from "./SpreadsheetPreview";
import { clipboardWriteText, readSpreadsheetForViewer } from "@/lib/tauri-api";

vi.mock("@/lib/tauri-api", () => ({
  clipboardWriteText: vi.fn().mockResolvedValue(undefined),
  readSpreadsheetForViewer: vi.fn(),
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
    vi.mocked(readSpreadsheetForViewer).mockResolvedValue(data);
  });

  it("searches the whole loaded sheet and copies matches outside the current page", async () => {
    render(<SpreadsheetPreview path="/test.xlsx" />);
    await screen.findByText("상품");
    expect(screen.queryByText("사과 주스")).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId("spreadsheet-search"), { target: { value: "사과" } });
    expect(screen.getByText("사과 주스")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("spreadsheet-copy"));
    await waitFor(() => expect(clipboardWriteText).toHaveBeenCalledWith("사과\t10\n사과 주스\t"));
    fireEvent.click(screen.getByText("10"));
    fireEvent.click(screen.getByTestId("spreadsheet-copy-cell"));
    await waitFor(() => expect(clipboardWriteText).toHaveBeenLastCalledWith("10"));
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

  it("preserves TSV cell boundaries and reports copy failures", async () => {
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
    fireEvent.click(screen.getByTestId("spreadsheet-copy"));
    await waitFor(() =>
      expect(clipboardWriteText).toHaveBeenCalledWith('"a\tb\n""c"""\t<script>bad</script>'),
    );
    vi.mocked(clipboardWriteText).mockRejectedValueOnce(new Error("clipboard unavailable"));
    fireEvent.click(screen.getByTestId("spreadsheet-copy"));
    await screen.findByText("Copy failed");
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
  });
});
