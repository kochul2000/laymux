import { useEffect, useState } from "react";
import {
  highlightCode,
  highlightSkipReason,
  type HighlightToken,
} from "@/lib/preview/code-highlight";
import { PreviewNotice } from "./PreviewNotice";

const SKIP_MESSAGE = {
  "too-large": "File is too large to highlight; showing plain source.",
  "too-many-lines": "File has too many lines to highlight; showing plain source.",
} as const;

/**
 * A finished highlight, tagged with the input it belongs to.
 *
 * Tagging rather than resetting on change: clearing the previous result would
 * mean a `setState` in the effect body, which
 * `react-hooks/set-state-in-effect` rejects. While the tag does not match the
 * current props the component simply renders "loading", so a prop change shows
 * the loading state without anyone writing state synchronously.
 */
interface HighlightOutcome {
  content: string;
  language: string;
  /** Null when the highlighter could not produce tokens for this input. */
  lines: HighlightToken[][] | null;
}

/**
 * Syntax-highlighted source with line numbers.
 *
 * Tokens come back from the highlighter as data and are rendered as React
 * spans. The highlighter's HTML API is deliberately unused (ADR-0109) — this
 * path never builds an HTML string, so it needs no sanitizer.
 *
 * Highlighting is best-effort: an oversized file, a missing grammar, or a
 * failed chunk load all fall back to plain source with the reason shown, rather
 * than leaving the pane empty.
 */
export function CodePreview({
  content,
  language,
  bodyStyle,
}: {
  content: string;
  language: string;
  bodyStyle?: React.CSSProperties;
}) {
  // Pure, so it belongs in the render pass: an oversized file never starts a
  // highlight at all and goes straight to plain source.
  const skip = highlightSkipReason(content);
  const [outcome, setOutcome] = useState<HighlightOutcome | null>(null);

  useEffect(() => {
    if (skip) return;
    let cancelled = false;
    void highlightCode(content, language).then((lines) => {
      if (!cancelled) setOutcome({ content, language, lines });
    });
    return () => {
      cancelled = true;
    };
  }, [content, language, skip]);

  const current =
    outcome && outcome.content === content && outcome.language === language ? outcome : null;

  if (!skip && !current) {
    return (
      <div
        className="flex h-full items-center justify-center"
        style={{ color: "var(--text-secondary)" }}
        data-testid="code-preview-loading"
      >
        Highlighting…
      </div>
    );
  }

  const plainReason = skip
    ? SKIP_MESSAGE[skip]
    : current?.lines
      ? null
      : "Syntax highlighting is unavailable.";
  const lines: HighlightToken[][] =
    current?.lines ?? content.split("\n").map((line) => [{ content: line }]);
  const gutterWidth = `${String(lines.length).length + 1}ch`;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {plainReason && <PreviewNotice testId="code-preview-plain">{plainReason}</PreviewNotice>}
      <div
        className="empty-view-scroll min-h-0 flex-1 overflow-auto"
        style={{ ...bodyStyle }}
        data-testid="code-preview"
      >
        {lines.map((tokens, index) => (
          <div key={index} className="flex items-start">
            <span
              style={{
                color: "var(--text-muted)",
                minWidth: gutterWidth,
                paddingRight: "1ch",
                textAlign: "right",
                flex: "0 0 auto",
                userSelect: "none",
              }}
            >
              {index + 1}
            </span>
            <span
              className="min-w-0 flex-1"
              style={{
                color: "var(--text-primary)",
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
              }}
            >
              {tokens.length === 0
                ? " "
                : tokens.map((token, tokenIndex) => (
                    <span
                      key={tokenIndex}
                      style={{
                        color: token.color,
                        fontStyle: token.fontStyle === "italic" ? "italic" : undefined,
                        fontWeight: token.fontStyle === "bold" ? 700 : undefined,
                        textDecoration: token.fontStyle === "underline" ? "underline" : undefined,
                      }}
                    >
                      {token.content}
                    </span>
                  ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
