import { useMemo, useState } from "react";
import type { ArchiveEntry } from "@/lib/tauri-api";
import { formatBytes, pluralize } from "@/lib/preview/format";
import { PreviewNotice } from "./PreviewNotice";

type SortKey = "name" | "size";

/**
 * Archive contents as a sortable table.
 *
 * Listing only — nothing is extracted (ADR-0109), so there is no way to open an
 * entry from here. The point is answering "what is in this jar" without leaving
 * the app for a shell.
 */
export function ArchivePreview({
  format,
  entries,
  totalEntries,
  truncated,
  bodyStyle,
}: {
  format: string;
  entries: ArchiveEntry[];
  totalEntries: number;
  truncated: boolean;
  bodyStyle?: React.CSSProperties;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("name");

  const sorted = useMemo(() => {
    const rows = [...entries];
    if (sortKey === "size") {
      rows.sort((a, b) => b.size - a.size);
    } else {
      rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    }
    return rows;
  }, [entries, sortKey]);

  const uncompressed = useMemo(
    () => entries.reduce((total, entry) => total + entry.size, 0),
    [entries],
  );

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div
        className="flex items-center gap-3 px-3 py-1"
        style={{
          background: "var(--bg-overlay)",
          borderBottom: "1px solid var(--border)",
          color: "var(--text-secondary)",
          fontSize: "var(--fs-sm)",
          flex: "0 0 auto",
        }}
        data-testid="archive-preview-summary"
      >
        <span style={{ color: "var(--text-primary)" }}>{format}</span>
        <span>{pluralize(totalEntries, "entry", "entries")}</span>
        <span>{`${formatBytes(uncompressed)} uncompressed`}</span>
      </div>
      {truncated && (
        <PreviewNotice testId="archive-preview-truncated">
          {`Showing the first ${entries.length.toLocaleString()} of ${totalEntries.toLocaleString()} entries.`}
        </PreviewNotice>
      )}
      <div
        className="empty-view-scroll min-h-0 flex-1 overflow-auto"
        style={{ ...bodyStyle }}
        data-testid="archive-preview"
      >
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={headerStyle}>
                <button type="button" style={sortButtonStyle} onClick={() => setSortKey("name")}>
                  {`Name${sortKey === "name" ? " ▾" : ""}`}
                </button>
              </th>
              <th style={{ ...headerStyle, textAlign: "right" }}>
                <button type="button" style={sortButtonStyle} onClick={() => setSortKey("size")}>
                  {`Size${sortKey === "size" ? " ▾" : ""}`}
                </button>
              </th>
              <th style={{ ...headerStyle, textAlign: "right" }}>Packed</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((entry) => (
              <tr key={entry.name} className="hover-bg" data-testid="archive-preview-row">
                <td style={{ ...cellStyle, overflowWrap: "anywhere" }}>
                  <span style={{ color: "var(--text-muted)", userSelect: "none" }}>
                    {entry.isDirectory ? "▸ " : "  "}
                  </span>
                  <span style={{ color: entry.isDirectory ? "var(--accent)" : undefined }}>
                    {entry.name}
                  </span>
                </td>
                <td style={{ ...cellStyle, textAlign: "right", whiteSpace: "nowrap" }}>
                  {entry.isDirectory ? "" : formatBytes(entry.size)}
                </td>
                <td
                  style={{
                    ...cellStyle,
                    textAlign: "right",
                    whiteSpace: "nowrap",
                    color: "var(--text-muted)",
                  }}
                >
                  {entry.isDirectory ? "" : formatBytes(entry.compressedSize)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const cellStyle: React.CSSProperties = {
  borderBottom: "1px solid var(--border)",
  color: "var(--text-primary)",
  padding: "2px 8px",
  textAlign: "left",
  verticalAlign: "top",
};

const headerStyle: React.CSSProperties = {
  position: "sticky",
  top: 0,
  background: "var(--bg-surface)",
  borderBottom: "1px solid var(--border)",
  color: "var(--text-secondary)",
  padding: "2px 8px",
  textAlign: "left",
};

const sortButtonStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "inherit",
  cursor: "pointer",
  font: "inherit",
  padding: 0,
};
