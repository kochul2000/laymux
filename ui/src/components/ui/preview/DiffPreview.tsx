import { useMemo } from "react";
import { parseUnifiedDiff, type DiffFile, type DiffLine } from "@/lib/preview/unified-diff";
import { PreviewNotice } from "./PreviewNotice";

const LINE_BACKGROUND: Record<DiffLine["type"], string | undefined> = {
  add: "var(--green-15)",
  del: "var(--red-15)",
  context: undefined,
  meta: "var(--yellow-08)",
};

const LINE_MARKER: Record<DiffLine["type"], string> = {
  add: "+",
  del: "-",
  context: " ",
  meta: "\\",
};

const STATUS_LABEL: Record<DiffFile["status"], string> = {
  added: "added",
  deleted: "deleted",
  renamed: "renamed",
  modified: "modified",
};

/** Unified diff with old/new line gutters, colored by line type. */
export function DiffPreview({
  content,
  bodyStyle,
}: {
  content: string;
  bodyStyle?: React.CSSProperties;
}) {
  const parsed = useMemo(() => parseUnifiedDiff(content), [content]);
  const renderedLines = useMemo(
    () =>
      parsed.files.reduce(
        (total, file) => total + file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0),
        0,
      ),
    [parsed],
  );

  if (parsed.files.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col">
        <PreviewNotice tone="info" testId="diff-preview-empty">
          No diff hunks found in this file. Switch to Source to read it as text.
        </PreviewNotice>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {parsed.truncated && (
        <PreviewNotice testId="diff-preview-truncated">
          {`Showing the first ${renderedLines.toLocaleString()} of ${parsed.totalLines.toLocaleString()} diff lines.`}
        </PreviewNotice>
      )}
      <div
        className="empty-view-scroll min-h-0 flex-1 overflow-auto"
        style={{ ...bodyStyle }}
        data-testid="diff-preview"
      >
        {parsed.files.map((file, fileIndex) => (
          <div key={`${file.oldPath}→${file.newPath}#${fileIndex}`}>
            <div
              className="sticky top-0 flex items-center gap-2 px-2 py-1"
              style={{
                background: "var(--bg-overlay)",
                borderBottom: "1px solid var(--border)",
                color: "var(--text-primary)",
              }}
              data-testid="diff-preview-file"
            >
              <span className="min-w-0 flex-1" style={{ overflowWrap: "anywhere" }}>
                {file.oldPath === file.newPath ? file.newPath : `${file.oldPath} → ${file.newPath}`}
              </span>
              <span style={{ color: "var(--text-muted)" }}>{STATUS_LABEL[file.status]}</span>
              <span style={{ color: "var(--green)" }}>{`+${file.additions}`}</span>
              <span style={{ color: "var(--red)" }}>{`-${file.deletions}`}</span>
            </div>
            {file.binary ? (
              <div className="px-2 py-1" style={{ color: "var(--text-secondary)" }}>
                Binary file — no textual diff.
              </div>
            ) : (
              file.hunks.map((hunk, hunkIndex) => (
                <div key={`${hunk.header}#${hunkIndex}`}>
                  <div
                    className="px-2"
                    style={{ background: "var(--accent-08)", color: "var(--accent)" }}
                    data-testid="diff-preview-hunk"
                  >
                    {hunk.header}
                  </div>
                  {hunk.lines.map((line, lineIndex) => (
                    <DiffLineRow key={lineIndex} line={line} />
                  ))}
                </div>
              ))
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function DiffLineRow({ line }: { line: DiffLine }) {
  return (
    <div
      className="flex items-start"
      style={{ background: LINE_BACKGROUND[line.type] }}
      data-testid={`diff-preview-line-${line.type}`}
    >
      <span style={gutterStyle}>{line.oldNumber ?? ""}</span>
      <span style={gutterStyle}>{line.newNumber ?? ""}</span>
      <span
        style={{
          color: "var(--text-muted)",
          width: "2ch",
          flex: "0 0 auto",
          userSelect: "none",
        }}
      >
        {LINE_MARKER[line.type]}
      </span>
      <span
        className="min-w-0 flex-1"
        style={{ color: "var(--text-primary)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
      >
        {line.text}
      </span>
    </div>
  );
}

const gutterStyle: React.CSSProperties = {
  color: "var(--text-muted)",
  minWidth: "5ch",
  paddingRight: "1ch",
  textAlign: "right",
  flex: "0 0 auto",
  userSelect: "none",
};
