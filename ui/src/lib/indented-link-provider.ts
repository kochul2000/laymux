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
 *
 * 좌표계 주의(issue #696): `ILink.range` 는 **셀 컬럼**인데 정규식 매칭 위치는
 * UTF-16 오프셋이다. 한글/CJK/이모지가 끼면 두 계가 갈라지므로, 각 줄을
 * `reconstructLine` 으로 재구성해 오프셋↔컬럼 맵을 함께 들고 다닌다
 * (`#123` 이슈 링크(#441), 경로 밑줄(#691)과 같은 매핑).
 */

import type { Terminal, ILinkProvider, ILink, IBufferCellPosition } from "@xterm/xterm";
import {
  reconstructLine,
  readLineCells,
  type BufferLineLike,
  type ReconstructedLine,
} from "./terminal-cell-map";

/**
 * 한 버퍼 줄의 정보 — 텍스트와 그 줄의 오프셋→셀 컬럼 맵을 함께 담는다.
 * 맵이 줄마다 필요한 이유는 이 provider 가 여러 줄을 결합해 URL 을 만들기
 * 때문이다: 결합 문자열의 오프셋을 (행, 셀) 로 되돌리려면 그 문자가 원래
 * 속했던 줄의 맵을 써야 한다.
 */
export interface IndentedLineInfo extends ReconstructedLine {
  isWrapped: boolean;
  lineNumber: number; // 1-based
}

interface UrlMatch {
  text: string;
  range: { start: IBufferCellPosition; end: IBufferCellPosition };
}

/**
 * URL regex: stops at whitespace and common delimiters )>]"'`.
 * Parentheses () are valid URL chars per RFC 3986, but ( is not excluded
 * here because real URLs (e.g. Wikipedia) use them legitimately.
 */
const URL_RE = /https?:\/\/[^\s)>\]"'`]+/;

/** 결합 문자열과, 그 오프셋마다의 버퍼 좌표. */
interface JoinedGroup {
  text: string;
  /** `starts[o]` = 오프셋 `o` 문자가 **시작**하는 버퍼 좌표(셀 컬럼 1-based). */
  starts: IBufferCellPosition[];
  /** `ends[o]` = 오프셋 `o` 문자가 **끝나는**(포함) 버퍼 좌표. */
  ends: IBufferCellPosition[];
}

/**
 * `IBufferLine` 을 이 provider 가 쓰는 줄 정보로 읽는다.
 * 텍스트와 컬럼 맵을 한 번에 만들어 두 좌표계가 갈라지지 않게 한다.
 */
export function readIndentedLine(
  bufLine: BufferLineLike & { isWrapped: boolean },
  lineNumber: number,
): IndentedLineInfo {
  return {
    ...reconstructLine(readLineCells(bufLine)),
    isWrapped: bufLine.isWrapped,
    lineNumber,
  };
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
    if (!/https?:\/\//.test(content)) continue;

    // Collect continuation lines: same indent, not wrapped, non-empty content
    let endIdx = startIdx;
    for (let j = startIdx + 1; j < lines.length; j++) {
      const nextLine = lines[j];
      // Stop at soft-wrapped lines — these use a different wrapping mechanism
      // (WebLinksAddon handles them). A mixed hard+soft wrap scenario is
      // theoretically possible but extremely rare in practice.
      if (nextLine.isWrapped) break;
      const nextIndent = getIndent(nextLine.text);
      // 끝쪽 패딩을 뗀 내용으로 판정한다 — 결합에 쓰는 것과 같은 문자열이라야
      // "빈 줄에서 멈춘다"가 실제 버퍼(폭만큼 공백으로 채워진 줄)에서도 성립한다.
      const nextContent = trimEnd(nextLine.text.slice(nextIndent));
      // Must have same indent and non-empty content
      if (nextIndent !== indent || nextContent.length === 0) break;
      // Must NOT start with a new URL (that would be an independent link)
      if (/^https?:\/\//.test(nextContent)) break;
      endIdx = j;
    }

    // Only interesting if multiple lines were joined
    if (endIdx === startIdx) continue;

    // Join the content (indent-stripped, trailing whitespace trimmed) together
    // with per-offset buffer coordinates. Terminal buffer lines are padded to
    // terminal width with spaces; without trimming, those spaces would break
    // URL detection.
    const joined = joinGroup(lines, startIdx, endIdx, indent);

    // Extract URL from the joined text
    const urlMatch = joined.text.match(URL_RE);
    if (!urlMatch) continue;

    const urlText = urlMatch[0];
    const urlOffset = urlMatch.index!;

    // Check if this group spans the queried line
    const groupLineNumbers = lines.slice(startIdx, endIdx + 1).map((l) => l.lineNumber);
    if (!groupLineNumbers.includes(queriedLine)) continue;

    // Map start/end back to buffer positions. `end` is inclusive and takes the
    // *last* cell of the final character — a wide char (CJK, emoji) ends one
    // cell past where it starts, so the underline has to cover both halves.
    const startPos = joined.starts[urlOffset];
    const endPos = joined.ends[urlOffset + urlText.length - 1];
    if (!startPos || !endPos) continue; // 맵 범위 밖 — 이론상 발생하지 않는다

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

function trimEnd(text: string): string {
  return text.replace(/\s+$/, "");
}

/**
 * 그룹의 각 줄에서 들여쓰기와 끝쪽 패딩을 뗀 내용을 이어 붙이고, 결합 문자열의
 * 오프셋마다 원래 줄의 셀 좌표를 기록한다. 문자열과 좌표를 같은 루프에서
 * 만들기 때문에 둘이 어긋날 수 없다.
 */
function joinGroup(
  lines: IndentedLineInfo[],
  startIdx: number,
  endIdx: number,
  indent: number,
): JoinedGroup {
  let text = "";
  const starts: IBufferCellPosition[] = [];
  const ends: IBufferCellPosition[] = [];
  for (let i = startIdx; i <= endIdx; i++) {
    const line = lines[i];
    const content = trimEnd(line.text.slice(indent));
    for (let offset = 0; offset < content.length; offset++) {
      const lineOffset = indent + offset;
      starts.push({ x: line.columns[lineOffset], y: line.lineNumber });
      ends.push({ x: line.endColumns[lineOffset], y: line.lineNumber });
    }
    text += content;
  }
  return { text, starts, ends };
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
        lines.push(readIndentedLine(bufLine, y));
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
