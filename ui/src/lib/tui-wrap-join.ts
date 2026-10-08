/**
 * TUI 가 화면 폭에서 나눈 줄 판정 — 복사(smart 줄바꿈 제거)와 여러 줄 URL 링크가
 * 공유한다.
 *
 * Claude Code·Codex 같은 전체 화면 TUI 는 긴 문단을 터미널 auto-wrap 에 맡기지
 * 않고 **자체 레이아웃으로** 행마다 진짜 개행을 넣는다. xterm 버퍼에는 이 행들이
 * `isWrapped=false` 로 남으므로 `getSelection()` 은 화면 폭마다 개행을 넣고, 연속
 * 행의 내어쓰기(2칸, 목록은 4칸)까지 그대로 복사한다. 문자열만으로는 "화면 폭이
 * 차서 넘어간 행"과 "원래 개행"을 구분할 수 없으므로 버퍼 행의 셀 폭으로 판정한다.
 *
 * 판정 근거는 줄바꿈기(word wrap)의 불변식이다: **다음 행의 첫 토큰이 이전 행의
 * 남은 칸에 들어갔다면 줄바꿈기는 그 토큰을 이전 행에 놓았을 것이다.** 따라서
 * `이전 행 끝 셀 + 1(공백) + 다음 첫 토큰 셀 > cols` 일 때만 화면 폭 줄바꿈으로
 * 본다. 여기에 연속 행이 이전 문단의 내어쓰기에 정렬돼 있어야 한다는 조건을 더해
 * 표·상태 줄·셸 출력이 우연히 이어지는 것을 막는다. dev 실측(88 cols) 근거는
 * `__fixtures__/tui-wrap-capture.ts`.
 */

import {
  reconstructLine,
  readLineCells,
  type BufferLineLike,
  type ReconstructedLine,
} from "./terminal-cell-map";

/**
 * 줄바꿈기의 줄 나눔 단위.
 * - `word` — 어절(공백) 경계에서만 나누고, 한 행보다 긴 토큰만 글자 단위로
 *   자른다(Claude Code/Ink, 일반 출력).
 * - `anywhere` — 한글·CJK 는 음절 사이에서도 나눈다(Codex). 와이드 문자끼리
 *   맞닿은 경계가 행 끝에서 잘렸으면 공백 없이 잇는다. 이 경우 원래 공백이
 *   있었는지(`복사하게| 되며`)는 버퍼에 남지 않아 공백 없이 이어지는 쪽으로
 *   기운다 — 음절 경계가 공백 경계보다 훨씬 흔하기 때문이다.
 */
export type WrapStyle = "word" | "anywhere";

/** 다음 행이 이전 행의 화면 폭 줄바꿈일 때 잇는 방법. */
export interface WrapJoin {
  /** 사이에 둘 문자 — 어절 경계면 `" "`, 단어 중간에서 잘렸으면 `""`. */
  separator: "" | " ";
  /** 다음 행에서 이어지는 내용이 시작하는 UTF-16 오프셋(내어쓰기 제외). */
  contentOffset: number;
}

/** 목록·인용·응답 마커. 연속 행이 이 마커로 시작하면 새 항목이다. */
const MARKER_RE = /^(?:[●•⏺◦▪‣∙⎿*+\-–›>]|\d{1,3}[.)])[ \t]+/;
/** 박스·표 테두리, 블록 요소 — 이런 행은 레이아웃이지 문단이 아니다. */
const FRAME_RE = /[─-▟]/;
/** 말줄임으로 잘린 행(상태 줄 등)은 다음 행으로 이어지지 않는다. */
const TRUNCATED_RE = /…\s*$/;
/** TUI 줄바꿈 폭이 cols 보다 좁을 수 있는 최대 여백(셀). */
const WRAP_MARGIN = 2;

interface RowShape {
  /** 첫 비공백 문자 오프셋. */
  indent: number;
  /** 마커 다음 내용 시작 오프셋(마커가 없으면 `indent`). */
  contentStart: number;
  /** 마지막 비공백 문자 오프셋. */
  last: number;
}

function rowShape(line: ReconstructedLine): RowShape | null {
  const indent = line.text.search(/[^ \t]/);
  if (indent < 0) return null;
  const marker = MARKER_RE.exec(line.text.slice(indent));
  return {
    indent,
    contentStart: indent + (marker ? marker[0].length : 0),
    last: line.text.search(/\S\s*$/),
  };
}

/** 오프셋 문자 앞에 있는 셀 수(0-based 시작 컬럼). */
const cellsBefore = (line: ReconstructedLine, offset: number) => line.columns[offset] - 1;
/** 오프셋 문자까지 차지한 셀 수(1-based 끝 컬럼). */
const cellsThrough = (line: ReconstructedLine, offset: number) => line.endColumns[offset];

/**
 * `next` 가 `prev` 에서 화면 폭 때문에 넘어간 연속 행인지 판정한다.
 *
 * @param prev 이전 논리 줄의 **마지막** 물리 행(행이 찼는지 본다).
 * @param next 다음 논리 줄의 첫 물리 행.
 * @param cols 터미널 폭(셀).
 * @param lead 이전 논리 줄의 **첫** 물리 행 — 내어쓰기 정렬의 기준. 기본 `prev`.
 */
export function detectTuiWrap(
  prev: ReconstructedLine,
  next: ReconstructedLine,
  cols: number,
  style: WrapStyle = "word",
  lead: ReconstructedLine = prev,
): WrapJoin | null {
  if (FRAME_RE.test(prev.text) || FRAME_RE.test(next.text) || FRAME_RE.test(lead.text)) {
    return null;
  }
  if (TRUNCATED_RE.test(prev.text)) return null;
  const p = rowShape(prev);
  const n = rowShape(next);
  const l = rowShape(lead);
  if (!p || !n || !l) return null;
  if (MARKER_RE.test(next.text.slice(n.indent))) return null;

  // 연속 행은 이전 문단의 내어쓰기에 정렬된다 — 마커 뒤 내용 시작(`● `·`  - `
  // 다음) 또는 마커 없는 행이면 그 행의 들여쓰기.
  const nextIndentCells = cellsBefore(next, n.indent);
  if (
    nextIndentCells !== cellsBefore(lead, l.indent) &&
    nextIndentCells !== cellsBefore(lead, l.contentStart)
  ) {
    return null;
  }

  const prevEnd = cellsThrough(prev, p.last);
  const token = /^\S+/.exec(next.text.slice(n.indent))![0];
  const tokenCells = cellsThrough(next, n.indent + token.length - 1) - nextIndentCells;
  if (prevEnd + 1 + tokenCells <= cols) return null;

  // 한 행보다 긴 토큰(URL 등)은 행 끝까지 채운 뒤 글자 단위로 잘린다. 앞 행이
  // 줄바꿈 폭까지 찼고 두 조각을 합친 길이가 한 행에 들어가지 않을 때만 그렇게
  // 본다 — 짧은 앞 단어 뒤로 긴 URL 이 통째로 다음 행에 놓인 경우(`문서는` +
  // URL 행)는 어절 경계다. 줄바꿈 폭은 cols 보다 작을 수 있다: Codex 입력창은
  // cols-1, Claude OAuth 화면은 오른쪽 여백 2칸(cols-2)에서 자른다.
  const headStart = prev.text.slice(0, p.last + 1).search(/\S+$/);
  const headCells = prevEnd - cellsBefore(prev, headStart);
  const midToken = prevEnd >= cols - WRAP_MARGIN && headCells + tokenCells > cols - nextIndentCells;

  // 음절 사이에서도 자르는 줄바꿈기: 와이드 문자끼리 맞닿은 경계에서 다음 글자가
  // 앞 행에 들어갈 자리가 없었다면 단어 중간으로 본다.
  const lastWide = prevEnd - cellsBefore(prev, p.last) > 1;
  const firstCells = cellsThrough(next, n.indent) - nextIndentCells;
  const midSyllable =
    style === "anywhere" && lastWide && firstCells > 1 && prevEnd + firstCells > cols;

  return { separator: midToken || midSyllable ? "" : " ", contentOffset: n.indent };
}

/** 선택 범위의 물리 행. */
export interface WrapRow extends ReconstructedLine {
  isWrapped: boolean;
}

/**
 * `getSelection()` 의 논리 줄들 사이에서 화면 폭 줄바꿈을 지운다.
 *
 * `rows` 는 선택 범위의 물리 행 전체(행 전체 텍스트)다. xterm 은 `isWrapped`
 * 연속 행을 개행 없이 붙이므로 논리 줄 수가 `lines` 길이와 같아야 하고, 아니면
 * (열 선택 모드 등) 매핑을 믿을 수 없어 `null` 을 돌려준다. 연속 줄은 선택이
 * 0열부터 시작하므로 내어쓰기 오프셋이 버퍼 행과 같다.
 */
export function joinTuiWrappedLines(
  lines: string[],
  rows: WrapRow[],
  cols: number,
  style: WrapStyle = "word",
): string[] | null {
  const groups: WrapRow[][] = [];
  for (const row of rows) {
    if (groups.length > 0 && row.isWrapped) groups[groups.length - 1].push(row);
    else groups.push([row]);
  }
  if (groups.length !== lines.length) return null;

  const out = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    const prevGroup = groups[i - 1];
    const join = detectTuiWrap(
      prevGroup[prevGroup.length - 1],
      groups[i][0],
      cols,
      style,
      prevGroup[0],
    );
    const line = lines[i];
    const indent = line.slice(0, join?.contentOffset ?? 0);
    if (join && /^[ \t]*$/.test(indent) && line.length > join.contentOffset) {
      out[out.length - 1] += join.separator + line.slice(join.contentOffset);
    } else {
      out.push(line);
    }
  }
  return out;
}

/** `joinTuiWrappedSelection` 이 쓰는 xterm `Terminal` 의 최소 표면. */
export interface SelectionSource {
  cols: number;
  getSelectionPosition(): { start: { y: number }; end: { y: number } } | undefined;
  buffer: {
    active: { getLine(y: number): (BufferLineLike & { isWrapped: boolean }) | undefined };
  };
}

/**
 * 현재 선택의 버퍼 행을 읽어 `text`(= `getSelection()`) 에서 화면 폭 줄바꿈을
 * 지운다. 선택 위치·행을 읽지 못하거나 논리 줄 매핑이 맞지 않으면 `text` 를
 * 그대로 돌려준다 — 복사가 원문보다 나빠지는 일은 없다.
 */
export function joinTuiWrappedSelection(
  terminal: SelectionSource,
  text: string,
  style: WrapStyle = "word",
): string {
  const position = terminal.getSelectionPosition();
  if (!position || !text.includes("\n")) return text;
  const startY = Math.min(position.start.y, position.end.y);
  const endY = Math.max(position.start.y, position.end.y);
  const rows: WrapRow[] = [];
  for (let y = startY; y <= endY; y++) {
    const line = terminal.buffer.active.getLine(y);
    if (!line) return text;
    rows.push({ ...reconstructLine(readLineCells(line)), isWrapped: line.isWrapped });
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const joined = joinTuiWrappedLines(text.split(/\r?\n/), rows, terminal.cols, style);
  return joined ? joined.join(eol) : text;
}
