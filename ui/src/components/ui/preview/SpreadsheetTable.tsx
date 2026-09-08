import { toolbarStyle, inputStyle } from "./spreadsheet-styles";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SpreadsheetContent } from "@/lib/tauri-api";
import { PreviewNotice } from "./PreviewNotice";
const ROW_HEIGHT = 28;
const COLUMN_WIDTH = 144;
const ROW_HEADER_WIDTH = 56;
const OVERSCAN = 5;
const MAX_ROWS = 10_000;
const MAX_COLUMNS = 256;
type Selection = {
  kind: "cells" | "rows" | "columns";
  row: number;
  column: number;
  endRow: number;
  endColumn: number;
};

export function SpreadsheetTable({
  data,
  bodyStyle,
}: {
  data: SpreadsheetContent;
  bodyStyle?: React.CSSProperties;
}) {
  const { t } = useTranslation("common");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Selection>();
  const [dragging, setDragging] = useState(false);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ top: 0, left: 0, width: 800, height: 560 });
  useEffect(() => {
    if (!scroller) return;
    const measure = () =>
      setViewport({
        top: scroller.scrollTop,
        left: scroller.scrollLeft,
        width: scroller.clientWidth || 800,
        height: scroller.clientHeight || 560,
      });
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    measure();
    return () => observer.disconnect();
  }, [scroller]);
  useEffect(() => {
    const stop = () => setDragging(false);
    window.addEventListener("mouseup", stop);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("mouseup", stop);
      window.removeEventListener("blur", stop);
    };
  }, []);
  useEffect(() => {
    if (!dragging || !scroller) return;
    let pointer: { x: number; y: number } | undefined;
    let frame = 0;
    const move = (event: MouseEvent) => {
      pointer = { x: event.clientX, y: event.clientY };
    };
    const scroll = () => {
      if (pointer) {
        const rect = scroller.getBoundingClientRect();
        const dy =
          selected?.kind === "columns"
            ? 0
            : pointer.y < rect.top + ROW_HEIGHT + 16
              ? -12
              : pointer.y > rect.bottom - 16
                ? 12
                : 0;
        const dx =
          selected?.kind === "rows"
            ? 0
            : pointer.x < rect.left + 16
              ? -12
              : pointer.x > rect.right - 16
                ? 12
                : 0;
        if (dx || dy) {
          scroller.scrollTop += dy;
          scroller.scrollLeft += dx;
          const target = document
            .elementFromPoint(
              selected?.kind === "rows"
                ? rect.left + ROW_HEADER_WIDTH / 2
                : Math.max(rect.left + ROW_HEADER_WIDTH + 1, Math.min(rect.right - 18, pointer.x)),
              selected?.kind === "columns"
                ? rect.top + ROW_HEIGHT / 2
                : Math.max(rect.top + ROW_HEIGHT + 1, Math.min(rect.bottom - 18, pointer.y)),
            )
            ?.closest<HTMLButtonElement>("[data-selection-kind]");
          if (target && scroller.contains(target))
            setSelected((previous) => {
              const row = Number(target.dataset.selectionRow);
              const column = Number(target.dataset.selectionColumn);
              return previous &&
                previous.kind === target.dataset.selectionKind &&
                (previous.endRow !== row || previous.endColumn !== column)
                ? { ...previous, endRow: row, endColumn: column }
                : previous;
            });
        }
      }
      frame = requestAnimationFrame(scroll);
    };
    window.addEventListener("mousemove", move);
    frame = requestAnimationFrame(scroll);
    return () => {
      window.removeEventListener("mousemove", move);
      cancelAnimationFrame(frame);
    };
  }, [dragging, scroller, selected?.kind]);
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
          [...row.values.values()].some((value) => value.toLocaleLowerCase().includes(needle)),
        )
      : rows;
  }, [rows, query]);
  const first = Math.max(
    0,
    Math.min(filtered.length - 1, Math.floor(viewport.top / ROW_HEIGHT) - OVERSCAN),
  );
  const last = Math.min(
    filtered.length,
    first + Math.ceil(viewport.height / ROW_HEIGHT) + OVERSCAN * 2,
  );
  const columns = Array.from({ length: columnCount }, (_, index) => index);
  const firstColumn = Math.max(
    0,
    Math.floor((viewport.left - ROW_HEADER_WIDTH) / COLUMN_WIDTH) - 1,
  );
  const lastColumn = Math.min(
    columnCount,
    firstColumn + Math.ceil(viewport.width / COLUMN_WIDTH) + 3,
  );
  const visibleColumns = columns.slice(firstColumn, lastColumn);
  const spacer = { padding: 0, border: 0 };
  const span =
    visibleColumns.length + 1 + Number(firstColumn > 0) + Number(lastColumn < columnCount);
  const bounds = selected && {
    firstRow: selected.kind === "columns" ? 0 : Math.min(selected.row, selected.endRow),
    lastRow:
      selected.kind === "columns" ? filtered.length - 1 : Math.max(selected.row, selected.endRow),
    firstCol: selected.kind === "rows" ? 0 : Math.min(selected.column, selected.endColumn),
    lastCol:
      selected.kind === "rows" ? columnCount - 1 : Math.max(selected.column, selected.endColumn),
  };
  function select(row: number, column: number, kind: Selection["kind"], extend = false) {
    setSelected((previous) =>
      extend && previous?.kind === kind
        ? { ...previous, endRow: row, endColumn: column }
        : { kind, row, column, endRow: row, endColumn: column },
    );
  }
  function selectionHandlers(row: number, column: number, kind: Selection["kind"]) {
    return {
      "data-selection-row": row,
      "data-selection-column": column,
      "data-selection-kind": kind,
      onMouseDown: (event: React.MouseEvent<HTMLButtonElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        scroller?.focus({ preventScroll: true });
        select(row, column, kind, event.shiftKey);
        setDragging(true);
      },
      onMouseEnter: (event: React.MouseEvent<HTMLButtonElement>) => {
        if (dragging && event.buttons === 1 && selected?.kind === kind)
          select(row, column, kind, true);
      },
      onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
        if (event.detail === 0) select(row, column, kind, event.shiftKey);
      },
    };
  }
  return (
    <>
      {data.truncated && (
        <PreviewNotice testId="spreadsheet-truncated">{t("spreadsheet.truncated")}</PreviewNotice>
      )}
      <div className="flex flex-wrap items-center gap-3 px-3 py-2" style={toolbarStyle}>
        <input
          type="search"
          aria-label={t("spreadsheet.search")}
          placeholder={t("spreadsheet.search")}
          data-testid="spreadsheet-search"
          value={query}
          style={inputStyle}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(undefined);
            setDragging(false);
            scroller?.scrollTo({ top: 0 });
            setViewport((previous) => ({ ...previous, top: 0 }));
          }}
        />
        <span style={{ color: "var(--text-muted)" }}>{t("spreadsheet.selectionHint")}</span>
        <span role="status" className="ml-auto">
          {bounds
            ? t("spreadsheet.selectionSize", {
                rows: bounds.lastRow - bounds.firstRow + 1,
                columns: bounds.lastCol - bounds.firstCol + 1,
              })
            : t("spreadsheet.rows", { count: filtered.length })}
        </span>
      </div>
      <div
        ref={setScroller}
        tabIndex={0}
        data-testid="spreadsheet-grid"
        data-file-viewer-body
        className="empty-view-scroll min-h-0 flex-1 overflow-auto"
        style={bodyStyle}
        onScroll={(event) =>
          setViewport({
            top: event.currentTarget.scrollTop,
            left: event.currentTarget.scrollLeft,
            width: event.currentTarget.clientWidth || 800,
            height: event.currentTarget.clientHeight || 560,
          })
        }
        onCopy={(event) => {
          if (!bounds) return;
          event.preventDefault();
          event.stopPropagation();
          const value = filtered
            .slice(bounds.firstRow, bounds.lastRow + 1)
            .map((row) =>
              columns
                .slice(bounds.firstCol, bounds.lastCol + 1)
                .map((column) => tsvCell(row.values.get(column) ?? ""))
                .join("\t"),
            )
            .join("\n");
          event.clipboardData.setData("text/plain", value);
        }}
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
              tableLayout: "fixed",
              width: ROW_HEADER_WIDTH + columnCount * COLUMN_WIDTH,
              userSelect: "none",
            }}
          >
            <colgroup>
              <col style={{ width: ROW_HEADER_WIDTH }} />
              {firstColumn > 0 && <col style={{ width: firstColumn * COLUMN_WIDTH }} />}
              {visibleColumns.map((column) => (
                <col key={column} style={{ width: COLUMN_WIDTH }} />
              ))}
              {lastColumn < columnCount && (
                <col style={{ width: (columnCount - lastColumn) * COLUMN_WIDTH }} />
              )}
            </colgroup>
            <thead>
              <tr>
                <th scope="col" style={{ ...headerStyle, left: 0, zIndex: 3 }}>
                  <button
                    type="button"
                    className="w-full"
                    aria-label={t("spreadsheet.selectAll")}
                    onClick={() => {
                      setSelected({
                        kind: "rows",
                        row: 0,
                        endRow: filtered.length - 1,
                        column: 0,
                        endColumn: columnCount - 1,
                      });
                      scroller?.focus({ preventScroll: true });
                    }}
                  >
                    #
                  </button>
                </th>
                {firstColumn > 0 && <th aria-hidden="true" style={spacer} />}
                {visibleColumns.map((column) => (
                  <th key={column} scope="col" style={headerStyle}>
                    <button
                      type="button"
                      className="w-full"
                      aria-label={t("spreadsheet.selectColumn", { column: columnName(column) })}
                      {...selectionHandlers(0, column, "columns")}
                    >
                      {columnName(column)}
                    </button>
                  </th>
                ))}
                {lastColumn < columnCount && <th aria-hidden="true" style={spacer} />}
              </tr>
            </thead>
            <tbody>
              {first > 0 && (
                <tr aria-hidden="true">
                  <td
                    colSpan={span}
                    style={{ height: first * ROW_HEIGHT, padding: 0, border: 0 }}
                  />
                </tr>
              )}
              {filtered.slice(first, last).map((row, offset) => {
                const rowPosition = first + offset;
                return (
                  <tr key={row.index} data-row={row.index}>
                    <th
                      scope="row"
                      style={{
                        ...cellStyle,
                        position: "sticky",
                        left: 0,
                        zIndex: 2,
                        background: "var(--bg-overlay)",
                      }}
                    >
                      <button
                        type="button"
                        className="w-full"
                        aria-label={t("spreadsheet.selectRow", { row: row.index + 1 })}
                        {...selectionHandlers(rowPosition, 0, "rows")}
                      >
                        {row.index + 1}
                      </button>
                    </th>
                    {firstColumn > 0 && <td aria-hidden="true" style={spacer} />}
                    {visibleColumns.map((column) => {
                      const value = row.values.get(column) ?? "";
                      const active =
                        !!bounds &&
                        rowPosition >= bounds.firstRow &&
                        rowPosition <= bounds.lastRow &&
                        column >= bounds.firstCol &&
                        column <= bounds.lastCol;
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
                            className="block w-full truncate text-left"
                            style={{ height: ROW_HEIGHT - 1, cursor: "cell" }}
                            title={value}
                            aria-label={columnName(column) + (row.index + 1) + ": " + value}
                            aria-pressed={active}
                            {...selectionHandlers(rowPosition, column, "cells")}
                          >
                            {value || "\u00a0"}
                          </button>
                        </td>
                      );
                    })}
                    {lastColumn < columnCount && <td aria-hidden="true" style={spacer} />}
                  </tr>
                );
              })}
              {last < filtered.length && (
                <tr aria-hidden="true">
                  <td
                    colSpan={span}
                    style={{ height: (filtered.length - last) * ROW_HEIGHT, padding: 0, border: 0 }}
                  />
                </tr>
              )}
            </tbody>
          </table>
        )}
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

const cellStyle: React.CSSProperties = {
  borderRight: "1px solid var(--border)",
  borderBottom: "1px solid var(--border)",
  color: "var(--text-primary)",
  padding: "0 8px",
  height: ROW_HEIGHT,
  overflow: "hidden",
};
const headerStyle: React.CSSProperties = {
  ...cellStyle,
  position: "sticky",
  top: 0,
  background: "var(--bg-overlay)",
  zIndex: 1,
};
