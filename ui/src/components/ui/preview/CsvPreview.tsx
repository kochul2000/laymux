import { useMemo } from "react";
import { detectDelimiter, parseDelimited } from "@/lib/preview/delimited";
import { PreviewNotice } from "./PreviewNotice";

/**
 * Delimited data as a table with the first row pinned as the header.
 *
 * Whether row one really is a header is a guess, so it is styled as one rather
 * than removed from the data — a headerless file still shows every value.
 */
export function CsvPreview({
  content,
  path,
  bodyStyle,
}: {
  content: string;
  path: string;
  bodyStyle?: React.CSSProperties;
}) {
  const parsed = useMemo(() => {
    const delimiter = detectDelimiter(path, content);
    return parseDelimited(content, delimiter);
  }, [content, path]);

  if (parsed.rows.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col">
        <PreviewNotice tone="info" testId="csv-preview-empty">
          This file has no rows.
        </PreviewNotice>
      </div>
    );
  }

  const [header, ...body] = parsed.rows;
  const columns = Array.from({ length: parsed.columnCount }, (_, index) => index);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {parsed.truncated && (
        <PreviewNotice testId="csv-preview-truncated">
          {`Showing the first ${parsed.rows.length.toLocaleString()} of ${parsed.totalRows.toLocaleString()} rows.`}
        </PreviewNotice>
      )}
      <div
        className="empty-view-scroll min-h-0 flex-1 overflow-auto"
        style={{ ...bodyStyle }}
        data-testid="csv-preview"
      >
        <table style={{ borderCollapse: "collapse", width: "max-content", minWidth: "100%" }}>
          <thead>
            <tr>
              <th style={{ ...cellStyle, ...gutterCellStyle, ...headerCellStyle }}>#</th>
              {columns.map((column) => (
                <th key={column} style={{ ...cellStyle, ...headerCellStyle }}>
                  {header[column] ?? ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, rowIndex) => (
              <tr key={rowIndex} className="hover-bg" data-testid="csv-preview-row">
                <td style={{ ...cellStyle, ...gutterCellStyle }}>{rowIndex + 2}</td>
                {columns.map((column) => (
                  <td key={column} style={cellStyle}>
                    {row[column] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const cellStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  color: "var(--text-primary)",
  padding: "2px 8px",
  textAlign: "left",
  verticalAlign: "top",
  whiteSpace: "pre-wrap",
  maxWidth: "60ch",
  overflowWrap: "anywhere",
};

const headerCellStyle: React.CSSProperties = {
  // Sticky so the header survives scrolling a long export.
  position: "sticky",
  top: 0,
  background: "var(--bg-overlay)",
  fontWeight: 600,
};

const gutterCellStyle: React.CSSProperties = {
  color: "var(--text-muted)",
  textAlign: "right",
  userSelect: "none",
};
