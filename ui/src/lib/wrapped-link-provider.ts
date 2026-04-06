/**
 * Custom xterm.js link provider that detects URLs spanning soft-wrapped lines.
 *
 * xterm.js's built-in WebLinksAddon only matches URLs within a single buffer
 * line. When a long URL wraps due to terminal width, it becomes two or more
 * buffer lines — the addon only links the first fragment.
 *
 * This provider uses IBufferLine.isWrapped to join continuation lines before
 * running URL detection, then maps matches back to correct buffer ranges.
 */

import type { Terminal, ILinkProvider, ILink, IBufferCellPosition } from "@xterm/xterm";

/** Minimal line info extracted from xterm buffer — also used in tests. */
export interface WrappedLineInfo {
  text: string;
  isWrapped: boolean;
  lineNumber: number; // 1-based
}

interface UrlMatch {
  text: string;
  range: { start: IBufferCellPosition; end: IBufferCellPosition };
}

// URL regex — matches http:// and https:// URLs with non-whitespace chars.
// Intentionally broad (same philosophy as WebLinksAddon).
const URL_RE = /https?:\/\/[^\s)>\]"'`]+/g;

/**
 * Given a set of buffer lines and a queried line number, find all URLs
 * in the joined wrapped-line group that includes the queried line.
 *
 * Exported for testing — the link provider calls this internally.
 */
export function findUrlsInWrappedText(lines: WrappedLineInfo[], _queriedLine: number): UrlMatch[] {
  if (lines.length === 0) return [];

  // Find the group of wrapped lines that includes the queried line.
  // Walk backwards from the first line to find the group start,
  // and forwards to find the group end.
  // Since `lines` already represents the relevant group context,
  // we group all consecutive wrapped lines together.

  const groups: { startIdx: number; endIdx: number }[] = [];
  let i = 0;
  while (i < lines.length) {
    const groupStart = i;
    // Advance past all continuation lines
    while (i + 1 < lines.length && lines[i + 1].isWrapped) {
      i++;
    }
    groups.push({ startIdx: groupStart, endIdx: i });
    i++;
  }

  // Find the group that contains the queried line
  const targetGroup = groups.find((g) => {
    for (let j = g.startIdx; j <= g.endIdx; j++) {
      if (lines[j].lineNumber === _queriedLine) return true;
    }
    return false;
  });

  if (!targetGroup) return [];

  const results: UrlMatch[] = [];

  {
    const group = targetGroup;
    // Build the joined text and track per-line offsets
    const lineOffsets: { lineNumber: number; offset: number; length: number }[] = [];
    let joined = "";
    for (let j = group.startIdx; j <= group.endIdx; j++) {
      lineOffsets.push({
        lineNumber: lines[j].lineNumber,
        offset: joined.length,
        length: lines[j].text.length,
      });
      joined += lines[j].text;
    }

    // Find all URLs in the joined text
    URL_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = URL_RE.exec(joined)) !== null) {
      const matchStart = match.index;
      const matchEnd = match.index + match[0].length - 1;

      // Map matchStart to buffer position
      const start = offsetToBufferPos(matchStart, lineOffsets);
      // Map matchEnd to buffer position
      const end = offsetToBufferPos(matchEnd, lineOffsets);

      results.push({
        text: match[0],
        range: { start, end },
      });
    }
  }

  return results;
}

/** Convert a character offset in joined text to a buffer cell position. */
function offsetToBufferPos(
  offset: number,
  lineOffsets: { lineNumber: number; offset: number; length: number }[],
): IBufferCellPosition {
  for (let i = lineOffsets.length - 1; i >= 0; i--) {
    if (offset >= lineOffsets[i].offset) {
      return {
        x: offset - lineOffsets[i].offset + 1, // 1-based
        y: lineOffsets[i].lineNumber,
      };
    }
  }
  // Fallback — shouldn't happen
  return { x: 1, y: lineOffsets[0].lineNumber };
}

/**
 * Create a custom ILinkProvider that detects URLs across soft-wrapped lines.
 */
export function createWrappedLinkProvider(
  terminal: Terminal,
  onClickLink: (uri: string) => void,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
      const buffer = terminal.buffer.active;

      // Collect the wrapped-line group containing bufferLineNumber.
      // Walk backwards to find the group start.
      let groupStartLine = bufferLineNumber;
      while (groupStartLine > 1) {
        const line = buffer.getLine(groupStartLine - 1);
        if (!line?.isWrapped) break;
        groupStartLine--;
      }

      // Walk forwards to find the group end.
      let groupEndLine = bufferLineNumber;
      while (groupEndLine < buffer.length) {
        const nextLine = buffer.getLine(groupEndLine); // 0-based: groupEndLine is next
        if (!nextLine?.isWrapped) break;
        groupEndLine++;
      }

      // Extract line info
      const lines: WrappedLineInfo[] = [];
      for (let y = groupStartLine; y <= groupEndLine; y++) {
        const bufLine = buffer.getLine(y - 1); // getLine is 0-based
        if (!bufLine) continue;
        lines.push({
          text: bufLine.translateToString(),
          isWrapped: bufLine.isWrapped,
          lineNumber: y,
        });
      }

      const matches = findUrlsInWrappedText(lines, bufferLineNumber);

      if (matches.length === 0) {
        callback(undefined);
        return;
      }

      const links: ILink[] = matches.map((m) => ({
        range: {
          start: m.range.start,
          end: m.range.end,
        },
        text: m.text,
        activate: () => onClickLink(m.text),
      }));

      callback(links);
    },
  };
}
