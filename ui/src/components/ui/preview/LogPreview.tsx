import { useMemo } from "react";
import {
  createAnsiParser,
  detectLogLevel,
  hasAnsiSequences,
  type AnsiSpan,
  type LogLevel,
} from "@/lib/preview/ansi";
import { PreviewNotice } from "./PreviewNotice";

/** Lines rendered before the viewer stops; a build log easily runs past this. */
const MAX_LOG_LINES = 20_000;

const LEVEL_BACKGROUND: Record<LogLevel, string | undefined> = {
  error: "var(--red-08)",
  warn: "var(--yellow-08)",
  info: undefined,
  debug: undefined,
  trace: undefined,
};

const LEVEL_COLOR: Record<LogLevel, string> = {
  error: "var(--red)",
  warn: "var(--yellow)",
  info: "var(--text-primary)",
  debug: "var(--text-secondary)",
  trace: "var(--text-muted)",
};

interface LogLine {
  number: number;
  spans: AnsiSpan[];
  /** Only set for lines the file did not already color itself. */
  level: LogLevel | null;
}

/**
 * Log lines with their ANSI colors intact, plus a severity tint for the plain
 * ones.
 *
 * Level detection is skipped on any line that carries its own SGR codes: the
 * writer already said how that line should look, and a second opinion would
 * fight it.
 */
export function LogPreview({
  content,
  bodyStyle,
}: {
  content: string;
  bodyStyle?: React.CSSProperties;
}) {
  const { lines, totalLines } = useMemo(() => parseLogLines(content), [content]);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {totalLines > lines.length && (
        <PreviewNotice testId="log-preview-truncated">
          {`Showing the first ${lines.length.toLocaleString()} of ${totalLines.toLocaleString()} lines.`}
        </PreviewNotice>
      )}
      <div
        className="empty-view-scroll min-h-0 flex-1 overflow-auto"
        style={{ ...bodyStyle }}
        data-testid="log-preview"
      >
        {lines.map((line) => (
          <div
            key={line.number}
            className="flex items-start"
            style={{ background: line.level ? LEVEL_BACKGROUND[line.level] : undefined }}
            data-testid="log-preview-line"
          >
            <span
              style={{
                color: "var(--text-muted)",
                minWidth: "6ch",
                paddingRight: "1ch",
                textAlign: "right",
                flex: "0 0 auto",
                userSelect: "none",
              }}
            >
              {line.number}
            </span>
            <span
              className="min-w-0 flex-1"
              style={{
                color: line.level ? LEVEL_COLOR[line.level] : "var(--text-primary)",
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
              }}
            >
              {line.spans.length === 0
                ? " "
                : line.spans.map((span, index) => <AnsiTextSpan key={index} span={span} />)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AnsiTextSpan({ span }: { span: AnsiSpan }) {
  const decorations = [span.underline ? "underline" : "", span.strike ? "line-through" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <span
      style={{
        color: span.fg,
        background: span.bg,
        fontWeight: span.bold ? 700 : undefined,
        fontStyle: span.italic ? "italic" : undefined,
        opacity: span.dim ? 0.65 : undefined,
        textDecoration: decorations || undefined,
      }}
    >
      {span.text}
    </span>
  );
}

function parseLogLines(content: string): { lines: LogLine[]; totalLines: number } {
  const rawLines = content.split("\n");
  // A trailing newline should not add a phantom final line.
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();

  const parser = createAnsiParser();
  const lines: LogLine[] = [];
  const rendered = Math.min(rawLines.length, MAX_LOG_LINES);
  for (let index = 0; index < rendered; index += 1) {
    const raw = rawLines[index].replace(/\r$/, "");
    lines.push({
      number: index + 1,
      // The parser carries SGR state forward, so lines are fed in order — an
      // unclosed color on one line keeps coloring the next, as a terminal does.
      spans: parser.parseLine(raw),
      level: hasAnsiSequences(raw) ? null : detectLogLevel(raw),
    });
  }
  return { lines, totalLines: rawLines.length };
}
