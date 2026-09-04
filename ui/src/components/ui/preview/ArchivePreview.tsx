import { useMemo, useState } from "react";
import type { ArchiveEntry } from "@/lib/tauri-api";
import { formatBytes, pluralize } from "@/lib/preview/format";
import { PreviewNotice } from "./PreviewNotice";
import { ChevronDownIcon, FileIcon, FolderIcon } from "@/components/ui/icons";
import { fileKindIconName } from "@/lib/file-kind-icon";

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
  totalBytes,
  truncated,
  bodyStyle,
}: {
  format: string;
  entries: ArchiveEntry[];
  totalEntries: number;
  /**
   * Whole-archive size from the backend. Summing `entries` here would pair a
   * whole-archive count with a listed-entries-only size, which reads as though
   * a capped archive were a fraction of its real weight.
   */
  totalBytes: number;
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
        <span>{`${formatBytes(totalBytes)} uncompressed`}</span>
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
        data-file-viewer-body
      >
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={headerStyle}>
                <button type="button" style={sortButtonStyle} onClick={() => setSortKey("name")}>
                  <span>Name</span>
                  {sortKey === "name" && <ChevronDownIcon size={12} />}
                </button>
              </th>
              <th style={{ ...headerStyle, textAlign: "right" }}>
                <button type="button" style={sortButtonStyle} onClick={() => setSortKey("size")}>
                  <span>Size</span>
                  {sortKey === "size" && <ChevronDownIcon size={12} />}
                </button>
              </th>
              <th style={{ ...headerStyle, textAlign: "right" }}>Packed</th>
            </tr>
          </thead>
          <tbody>
            {/* Index-qualified key: a zip can legally carry two entries with
                the same name, and patched or tool-generated archives do. */}
            {sorted.map((entry, index) => (
              <tr
                key={`${index}:${entry.name}`}
                className="hover-bg"
                data-testid="archive-preview-row"
              >
                <td style={{ ...cellStyle, overflowWrap: "anywhere" }}>
                  <span
                    style={{
                      color: "var(--text-muted)",
                      display: "inline-flex",
                      width: 14,
                      userSelect: "none",
                    }}
                  >
                    {fileKindIconName(entry) === "Folder" ? (
                      <FolderIcon size={12} />
                    ) : (
                      <FileIcon size={12} />
                    )}
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
  alignItems: "center",
  background: "transparent",
  border: "none",
  color: "inherit",
  cursor: "pointer",
  display: "inline-flex",
  font: "inherit",
  gap: 2,
  padding: 0,
};
