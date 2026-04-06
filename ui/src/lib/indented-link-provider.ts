/**
 * Custom xterm.js link provider that detects URLs spanning hard-wrapped
 * indented lines.
 *
 * Some programs (e.g. Claude Code) output long URLs with hard newlines
 * and consistent indentation:
 *
 *   https://example.com/authorize?code_challenge=abc&cod
 *   e_challenge_method=S256&redirect_uri=http%3A%2F%2Flo
 *   calhost%3A52516%2Fcallback
 *
 * xterm.js's WebLinksAddon (which handles soft-wraps) cannot detect
 * these because the lines are NOT marked as `isWrapped`.
 *
 * This provider looks at adjacent non-wrapped lines with the same
 * indentation, strips the common indent, joins them, and checks if the
 * result is a valid URL.
 */

import type { Terminal, ILinkProvider, ILink, IBufferCellPosition } from "@xterm/xterm";

/** Minimal line info — also used in tests. */
export interface IndentedLineInfo {
  text: string;
  isWrapped: boolean;
  lineNumber: number; // 1-based
}

interface UrlMatch {
  text: string;
  range: { start: IBufferCellPosition; end: IBufferCellPosition };
}

/**
 * Given buffer lines and a queried line number, detect indented multi-line
 * URLs that span the queried line.
 *
 * Strategy:
 * 1. Find the line containing a URL start (`https?://`)
 * 2. Look at subsequent non-wrapped lines with the same indent
 * 3. Strip indent, join, check if it forms a single URL
 */
export function findIndentedUrls(lines: IndentedLineInfo[], queriedLine: number): UrlMatch[] {
  if (lines.length === 0) return [];

  const results: UrlMatch[] = [];

  // Try to find a URL-starting line and extend downward
  for (let startIdx = 0; startIdx < lines.length; startIdx++) {
    const line = lines[startIdx];
    // Skip soft-wrapped lines — WebLinksAddon already handles those
    if (line.isWrapped) continue;

    const indent = getIndent(line.text);
    const content = line.text.slice(indent);

    // Must contain a URL start
    const urlStart = content.search(/https?:\/\//);
    if (urlStart < 0) continue;

    // Collect continuation lines: same indent, not wrapped, non-empty content
    let endIdx = startIdx;
    for (let j = startIdx + 1; j < lines.length; j++) {
      const nextLine = lines[j];
      // Stop at soft-wrapped lines — these use a different wrapping mechanism
      // (WebLinksAddon handles them). A mixed hard+soft wrap scenario is
      // theoretically possible but extremely rare in practice.
      if (nextLine.isWrapped) break;
      const nextIndent = getIndent(nextLine.text);
      const nextContent = nextLine.text.slice(nextIndent);
      // Must have same indent and non-empty content
      if (nextIndent !== indent || nextContent.length === 0) break;
      // Must NOT start with a new URL (that would be an independent link)
      if (/^https?:\/\//.test(nextContent)) break;
      endIdx = j;
    }

    // Only interesting if multiple lines were joined
    if (endIdx === startIdx) continue;

    // Join the content (indent-stripped)
    const joined = lines
      .slice(startIdx, endIdx + 1)
      .map((l) => l.text.slice(indent))
      .join("");

    // Extract URL from the joined text
    // URL regex: stops at whitespace and common delimiters )>]"'`.
    // Parentheses () are valid URL chars per RFC 3986, but ( is not excluded
    // here because real URLs (e.g. Wikipedia) use them legitimately.
    const urlMatch = joined.match(/https?:\/\/[^\s)>\]"'`]+/);
    if (!urlMatch) continue;

    const urlText = urlMatch[0];
    const urlOffset = urlMatch.index!;

    // Check if this group spans the queried line
    const groupLineNumbers = lines.slice(startIdx, endIdx + 1).map((l) => l.lineNumber);
    if (!groupLineNumbers.includes(queriedLine)) continue;

    // Map start/end back to buffer positions
    const startPos = offsetToPos(urlOffset, lines, startIdx, endIdx, indent);
    const endPos = offsetToPos(urlOffset + urlText.length - 1, lines, startIdx, endIdx, indent);

    results.push({ text: urlText, range: { start: startPos, end: endPos } });

    // Skip past this group
    startIdx = endIdx;
  }

  return results;
}

function getIndent(text: string): number {
  const match = text.match(/^([ \t]*)/);
  return match ? match[1].length : 0;
}

function offsetToPos(
  offset: number,
  lines: IndentedLineInfo[],
  startIdx: number,
  endIdx: number,
  indent: number,
): IBufferCellPosition {
  let remaining = offset;
  for (let i = startIdx; i <= endIdx; i++) {
    const contentLen = lines[i].text.length - indent;
    if (remaining < contentLen || i === endIdx) {
      return {
        x: indent + Math.min(remaining, contentLen - 1) + 1, // 1-based, clamped
        y: lines[i].lineNumber,
      };
    }
    remaining -= contentLen;
  }
  return { x: 1, y: lines[startIdx].lineNumber };
}

/**
 * Create an ILinkProvider for indented hard-wrapped URLs.
 *
 * @param isEnabled - Called on each provideLinks invocation so the provider
 *   respects dynamic setting changes without re-registration.
 */
export function createIndentedLinkProvider(
  terminal: Terminal,
  onClickLink: (uri: string) => void,
  isEnabled: () => boolean = () => true,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
      if (!isEnabled()) {
        callback(undefined);
        return;
      }

      const buffer = terminal.buffer.active;

      // Gather a window of lines around the queried line.
      // Look up to 10 lines before/after to find the URL group.
      const windowSize = 10;
      const startLine = Math.max(1, bufferLineNumber - windowSize);
      const endLine = Math.min(buffer.length, bufferLineNumber + windowSize);

      const lines: IndentedLineInfo[] = [];
      for (let y = startLine; y <= endLine; y++) {
        const bufLine = buffer.getLine(y - 1); // 0-based
        if (!bufLine) continue;
        lines.push({
          text: bufLine.translateToString(),
          isWrapped: bufLine.isWrapped,
          lineNumber: y,
        });
      }

      const matches = findIndentedUrls(lines, bufferLineNumber);

      if (matches.length === 0) {
        callback(undefined);
        return;
      }

      const links: ILink[] = matches.map((m) => ({
        range: { start: m.range.start, end: m.range.end },
        text: m.text,
        activate: () => onClickLink(m.text),
      }));

      callback(links);
    },
  };
}
