/**
 * Custom xterm.js link provider that detects URLs a TUI broke across rows
 * with hard newlines.
 *
 * Claude Code (and its OAuth login screen) prints long URLs with its own
 * layout: the URL is cut at the last cell of the row and continues on the next
 * row behind a hanging indent — 2 cells in a paragraph, 4 in a list item:
 *
 *   ● 문서: https://github.com/o/r/blob/main/docs/architecture/da
 *     ta-flow.md 를 참고하세요.
 *
 * xterm.js's WebLinksAddon (which handles soft-wraps) cannot detect these
 * because the rows are NOT marked as `isWrapped`; it links only the cut-off
 * head of the first row.
 *
 * Which rows continue a URL is decided by `detectTuiWrap` (shared with smart
 * copy): the previous row must be filled to the screen width and the next row
 * must sit on the hanging indent. Indent equality alone glued the first word of
 * the next prose line onto a URL that merely ended a line (`…/pull/12를`).
 *
 * This provider must be registered **before** WebLinksAddon so that xterm's
 * Linkifier prefers the joined URL and drops the intersecting cut-off head.
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
import { matchTerminalUrls } from "./terminal-url";
import { detectTuiWrap } from "./tui-wrap-join";

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
 * Given buffer lines and a queried line number, detect URLs that a TUI broke
 * across rows with hard newlines and that span the queried line.
 *
 * Strategy:
 * 1. From each logical line that contains a URL start (`https?://`), follow
 *    the rows `detectTuiWrap` reports as a mid-token continuation
 *    (separator `""`). A word-boundary continuation (`" "`) ends the chain —
 *    a URL cannot contain a space.
 * 2. Join the continuation content (hanging indent and trailing padding
 *    stripped) together with per-offset buffer coordinates.
 * 3. Report URLs in the joined text that cross a hard row break. URLs inside
 *    one logical line (single row or soft-wrapped) are WebLinksAddon's.
 *
 * `cols` is the widest row in the window — production rows are padded to the
 * terminal width, so it is the terminal width.
 */
export function findIndentedUrls(lines: IndentedLineInfo[], queriedLine: number): UrlMatch[] {
  if (lines.length === 0) return [];
  const cols = Math.max(...lines.map((line) => line.endColumns[line.endColumns.length - 1] ?? 0));

  // 논리 줄 = 첫 행 + isWrapped 연속 행. 경계 판정은 논리 줄 단위로 한다.
  const logical: IndentedLineInfo[][] = [];
  for (const line of lines) {
    if (logical.length > 0 && line.isWrapped) logical[logical.length - 1].push(line);
    else logical.push([line]);
  }

  const results: UrlMatch[] = [];
  for (let startIdx = 0; startIdx < logical.length; startIdx++) {
    const first = logical[startIdx];
    // 창 맨 위가 soft-wrap 연속 행이면 그 논리 줄의 시작을 모른다.
    if (first[0].isWrapped) continue;
    if (!first.some((row) => /https?:\/\//i.test(row.text))) continue;

    const parts: { line: IndentedLineInfo; from: number }[] = first.map((line) => ({
      line,
      from: 0,
    }));
    let endIdx = startIdx;
    while (endIdx + 1 < logical.length) {
      const prev = logical[endIdx];
      const next = logical[endIdx + 1];
      // soft-wrap 으로 이어진 논리 줄 다음 행은 hard wrap 으로 보지 않는다(detectTuiWrap).
      if (prev.length > 1) break;
      const join = detectTuiWrap(prev[0], next[0], cols, "word");
      if (!join || join.separator !== "") break;
      parts.push({ line: next[0], from: join.contentOffset });
      for (const line of next.slice(1)) parts.push({ line, from: 0 });
      endIdx++;
    }
    if (endIdx === startIdx) continue;

    const joined = joinParts(parts);
    for (const match of matchTerminalUrls(joined.text)) {
      const startPos = joined.starts[match.index];
      const endPos = joined.ends[match.index + match.text.length - 1];
      // 컬럼 맵이 줄 텍스트보다 짧으면 좌표 객체는 있지만 `x` 가 undefined 다.
      // 객체 존재만 보면 그런 좌표가 그대로 `ILink` 로 나간다 — `x` 를 확인한다.
      if (startPos?.x === undefined || endPos?.x === undefined) continue;
      // 한 논리 줄 안의 URL 은 WebLinksAddon 몫이다.
      if (joined.logical[match.index] === joined.logical[match.index + match.text.length - 1]) {
        continue;
      }
      if (queriedLine < startPos.y || queriedLine > endPos.y) continue;
      results.push({ text: match.text, range: { start: startPos, end: endPos } });
    }

    startIdx = endIdx;
  }

  return results;
}

/**
 * 각 행의 `from` 오프셋부터 끝쪽 패딩을 뗀 내용을 이어 붙이고, 결합 문자열의
 * 오프셋마다 원래 행의 셀 좌표와 논리 줄 번호를 기록한다. 문자열과 좌표를 같은
 * 루프에서 만들기 때문에 둘이 어긋날 수 없다.
 */
function joinParts(
  parts: { line: IndentedLineInfo; from: number }[],
): JoinedGroup & { logical: number[] } {
  let text = "";
  const starts: IBufferCellPosition[] = [];
  const ends: IBufferCellPosition[] = [];
  const logical: number[] = [];
  let logicalIndex = -1;
  for (const { line, from } of parts) {
    if (!line.isWrapped) logicalIndex++;
    const content = line.text.slice(from).replace(/\s+$/, "");
    for (let offset = 0; offset < content.length; offset++) {
      starts.push({ x: line.columns[from + offset], y: line.lineNumber });
      ends.push({ x: line.endColumns[from + offset], y: line.lineNumber });
      logical.push(logicalIndex);
    }
    text += content;
  }
  return { text, starts, ends, logical };
}

/**
 * Create an ILinkProvider for indented hard-wrapped URLs.
 *
 * @param onClickLink - Invoked with the joined URL. The activation `MouseEvent`
 *   and the link's buffer range come along so the caller can gate execution
 *   behind an action chip (ADR-0224) — the chip needs a place to appear and a
 *   cell range to re-check.
 * @param isEnabled - Called on each provideLinks invocation so the provider
 *   respects dynamic setting changes without re-registration.
 */
export function createIndentedLinkProvider(
  terminal: Terminal,
  onClickLink: (
    uri: string,
    event?: MouseEvent,
    range?: { start: IBufferCellPosition; end: IBufferCellPosition },
  ) => void,
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
        activate: (event) => onClickLink(m.text, event, m.range),
      }));

      callback(links);
    },
  };
}
