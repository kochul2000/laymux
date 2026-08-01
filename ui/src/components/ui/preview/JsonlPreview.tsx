import { useMemo, useState } from "react";
import { parseJsonl, summarizeJsonlValue } from "@/lib/preview/jsonl";
import { PreviewNotice } from "./PreviewNotice";
import { JsonPreview } from "./JsonPreview";

/**
 * One row per line, collapsed to a single-line summary.
 *
 * The files this exists for are agent transcripts and structured logs, where
 * the useful operation is "scan the lines, then open the one that matters".
 * Expanding a row reuses the JSON tree so both views agree on how a value looks.
 */
export function JsonlPreview({
  content,
  bodyStyle,
}: {
  content: string;
  bodyStyle?: React.CSSProperties;
}) {
  const parsed = useMemo(() => parseJsonl(content), [content]);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());

  const toggle = (line: number) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(line)) next.delete(line);
      else next.add(line);
      return next;
    });

  const notices: string[] = [];
  if (parsed.truncated) {
    notices.push(
      `Showing the first ${parsed.records.length.toLocaleString()} of ${parsed.totalRecords.toLocaleString()} records.`,
    );
  }
  if (parsed.invalidCount > 0) {
    notices.push(`${parsed.invalidCount.toLocaleString()} line(s) are not valid JSON.`);
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {notices.length > 0 && (
        <PreviewNotice testId="jsonl-preview-notice">{notices.join(" ")}</PreviewNotice>
      )}
      <div
        className="empty-view-scroll min-h-0 flex-1 overflow-auto"
        style={{ ...bodyStyle }}
        data-testid="jsonl-preview"
      >
        {parsed.records.map((record) => {
          const isOpen = expanded.has(record.line);
          const failed = record.error !== undefined;
          return (
            <div key={record.line} style={{ borderBottom: "1px solid var(--border)" }}>
              <div
                className="hover-bg flex items-start gap-2 px-2"
                style={{ cursor: failed ? "default" : "pointer" }}
                onClick={failed ? undefined : () => toggle(record.line)}
                data-testid="jsonl-preview-row"
              >
                <span
                  style={{
                    color: "var(--text-muted)",
                    minWidth: "4ch",
                    textAlign: "right",
                    flex: "0 0 auto",
                    userSelect: "none",
                  }}
                >
                  {record.line}
                </span>
                <span
                  className="min-w-0 flex-1"
                  style={{
                    color: failed ? "var(--red)" : "var(--text-primary)",
                    overflowWrap: "anywhere",
                  }}
                >
                  {failed ? `${record.error} — ${record.raw}` : summarizeJsonlValue(record.value)}
                </span>
              </div>
              {isOpen && !failed && (
                <div style={{ background: "var(--bg-base)" }}>
                  <JsonPreview content={record.raw} embedded />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
