import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  clipboardWriteText,
  readSpreadsheetForViewer,
  type SpreadsheetContent,
} from "@/lib/tauri-api";
import { PreviewNotice } from "./PreviewNotice";
import { Button } from "../Button";

const PAGE_ROWS = 50;
const MAX_ROWS = 10_000;
const MAX_COLUMNS = 256;

export function SpreadsheetPreview({
  path,
  bodyStyle,
}: {
  path: string;
  bodyStyle?: React.CSSProperties;
}) {
  const { t } = useTranslation("common");
  const [sheet, setSheet] = useState<string>();
  const [loaded, setLoaded] = useState<{
    path: string;
    requestedSheet?: string;
    data?: SpreadsheetContent;
    error?: string;
  }>();
  useEffect(() => {
    let cancelled = false;
    readSpreadsheetForViewer(path, sheet).then(
      (data) => {
        if (!cancelled) setLoaded({ path, requestedSheet: sheet, data });
      },
      (error) => {
        if (!cancelled)
          setLoaded((previous) => ({
            path,
            requestedSheet: sheet,
            error: String(error),
            data: previous?.path === path ? previous.data : undefined,
          }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [path, sheet]);
  const current = loaded?.path === path && loaded.requestedSheet === sheet ? loaded : undefined;
  // Keep the selector usable after a failed sheet read.
  const names = loaded?.path === path ? loaded.data?.sheetNames : undefined;
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col" data-testid="spreadsheet-preview">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2" style={toolbarStyle}>
        <label className="flex items-center gap-2">
          {t("spreadsheet.sheet")}
          <select
            aria-label={t("spreadsheet.sheet")}
            data-testid="spreadsheet-sheet"
            value={sheet ?? current?.data?.sheet ?? ""}
            onChange={(event) => setSheet(event.target.value)}
            style={{ ...inputStyle, maxWidth: "30ch" }}
          >
            {(names ?? (sheet ? [sheet] : [])).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <span style={{ color: "var(--text-muted)" }}>{t("spreadsheet.readOnly")}</span>
      </div>
      {current?.error ? (
        <PreviewNotice tone="error" testId="spreadsheet-error">
          {current.error}
        </PreviewNotice>
      ) : current?.data ? (
        <SheetTable
          key={path + "\u0000" + current.data.sheet}
          data={current.data}
          bodyStyle={bodyStyle}
        />
      ) : (
        <PreviewNotice tone="info">{t("spreadsheet.loading")}</PreviewNotice>
      )}
    </div>
  );
}

function SheetTable({
  data,
  bodyStyle,
}: {
  data: SpreadsheetContent;
  bodyStyle?: React.CSSProperties;
}) {
  const { t } = useTranslation("common");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<{ row: number; column: number; value: string }>();
  const [copyStatus, setCopyStatus] = useState<"done" | "error">();
  const columnCount = Math.min(data.totalColumns, MAX_COLUMNS);
  const rows = useMemo(() => {
    const result = Array.from({ length: Math.min(data.totalRows, MAX_ROWS) }, (_, index) => ({
      index,
      values: new Map<number, string>(),
    }));
    for (const cell of data.cells) result[cell.row]?.values.set(cell.column, cell.value);
    return result;
  }, [data]);
  const filtered = useMemo(() => {
    const needle = query.toLocaleLowerCase();
    return needle
      ? rows.filter((row) =>
          [...row.values.values()].some((v) => v.toLocaleLowerCase().includes(needle)),
        )
      : rows;
  }, [rows, query]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_ROWS));
  const columns = Array.from({ length: columnCount }, (_, index) => index);
  const pageRows = filtered.slice(page * PAGE_ROWS, (page + 1) * PAGE_ROWS);
  async function copy(value: string) {
    try {
      await clipboardWriteText(value);
      setCopyStatus("done");
    } catch {
      setCopyStatus("error");
    }
  }
  return (
    <>
      {data.truncated && (
        <PreviewNotice testId="spreadsheet-truncated">{t("spreadsheet.truncated")}</PreviewNotice>
      )}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2" style={toolbarStyle}>
        <input
          type="search"
          aria-label={t("spreadsheet.search")}
          placeholder={t("spreadsheet.search")}
          data-testid="spreadsheet-search"
          value={query}
          style={{ ...inputStyle, minWidth: 0 }}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(0);
            setSelected(undefined);
            setCopyStatus(undefined);
          }}
        />
        <Button
          data-testid="spreadsheet-copy"
          disabled={!filtered.length || !columnCount}
          title={!filtered.length || !columnCount ? t("spreadsheet.nothingToCopy") : undefined}
          onClick={() =>
            void copy(
              filtered
                .map((row) => columns.map((col) => tsvCell(row.values.get(col) ?? "")).join("\t"))
                .join("\n"),
            )
          }
        >
          {t("spreadsheet.copyRows")}
        </Button>
        <Button
          data-testid="spreadsheet-copy-cell"
          disabled={!selected}
          title={!selected ? t("spreadsheet.selectCell") : undefined}
          onClick={() => {
            if (selected) void copy(selected.value);
          }}
        >
          {t("spreadsheet.copyCell")}
        </Button>
        <span
          role="status"
          style={{ color: copyStatus === "error" ? "var(--red)" : "var(--text-muted)" }}
        >
          {copyStatus
            ? t("spreadsheet." + (copyStatus === "done" ? "copied" : "copyFailed"))
            : t("spreadsheet.rows", { count: filtered.length })}
        </span>
      </div>
      <div
        className="empty-view-scroll min-h-0 flex-1 overflow-auto"
        style={bodyStyle}
        data-file-viewer-body
      >
        {!rows.length || !columnCount ? (
          <PreviewNotice tone="info" testId="spreadsheet-empty">
            {t("spreadsheet.empty")}
          </PreviewNotice>
        ) : !filtered.length ? (
          <PreviewNotice tone="info">{t("spreadsheet.noMatches")}</PreviewNotice>
        ) : (
          <table
            style={{
              borderCollapse: "separate",
              borderSpacing: 0,
              minWidth: "100%",
              width: "max-content",
            }}
          >
            <thead>
              <tr>
                <th scope="col" style={{ ...headerStyle, width: "1%", minWidth: "5ch" }}>
                  #
                </th>
                {columns.map((column) => (
                  <th key={column} scope="col" style={headerStyle}>
                    {columnName(column)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row) => (
                <tr key={row.index} className="hover-bg">
                  <th
                    scope="row"
                    style={{ ...cellStyle, color: "var(--text-muted)", fontWeight: 400 }}
                  >
                    {row.index + 1}
                  </th>
                  {columns.map((column) => {
                    const value = row.values.get(column) ?? "";
                    const active = selected?.row === row.index && selected.column === column;
                    const match =
                      query && value.toLocaleLowerCase().includes(query.toLocaleLowerCase());
                    return (
                      <td
                        key={column}
                        style={{
                          ...cellStyle,
                          background: active
                            ? "var(--accent-20)"
                            : match
                              ? "var(--yellow-08)"
                              : undefined,
                        }}
                      >
                        <button
                          type="button"
                          className="w-full text-left"
                          style={{
                            whiteSpace: "pre-wrap",
                            overflowWrap: "anywhere",
                            minHeight: "1.5em",
                            cursor: "cell",
                            userSelect: "text",
                          }}
                          aria-label={columnName(column) + (row.index + 1) + ": " + value}
                          aria-pressed={active}
                          onClick={() => {
                            setSelected({ row: row.index, column, value });
                            setCopyStatus(undefined);
                          }}
                        >
                          {value || "\u00a0"}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 px-3 py-2" style={toolbarStyle}>
        <Button
          disabled={page === 0}
          title={page === 0 ? t("spreadsheet.firstPage") : undefined}
          onClick={() => setPage(page - 1)}
        >
          {t("spreadsheet.previous")}
        </Button>
        <span>
          {page + 1} / {pageCount}
        </span>
        <Button
          disabled={page + 1 >= pageCount}
          title={page + 1 >= pageCount ? t("spreadsheet.lastPage") : undefined}
          onClick={() => setPage(page + 1)}
        >
          {t("spreadsheet.next")}
        </Button>
      </div>
    </>
  );
}

function tsvCell(value: string): string {
  return /[\t\r\n"]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
}

function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

const toolbarStyle: React.CSSProperties = {
  background: "var(--bg-surface)",
  color: "var(--text-secondary)",
  borderBottom: "1px solid var(--border)",
  fontSize: "var(--fs-sm)",
};
const inputStyle: React.CSSProperties = {
  background: "var(--bg-overlay)",
  color: "var(--text-primary)",
  border: "1px solid var(--border)",
  padding: "4px 8px",
};
const cellStyle: React.CSSProperties = {
  borderRight: "1px solid var(--border)",
  borderBottom: "1px solid var(--border)",
  color: "var(--text-primary)",
  padding: "2px 8px",
  minWidth: "6ch",
  maxWidth: "60ch",
  verticalAlign: "top",
};
const headerStyle: React.CSSProperties = {
  ...cellStyle,
  position: "sticky",
  top: 0,
  background: "var(--bg-overlay)",
  zIndex: 1,
};
