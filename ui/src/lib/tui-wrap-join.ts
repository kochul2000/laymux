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
    // 들여쓰기와 같은 문자 집합으로 찾는다 — U+3000·NBSP 만 있는 행도 -1 이 아니다.
    last: line.text.search(/[^ \t][ \t]*$/),
  };
}

/** 오프셋 문자 앞에 있는 셀 수(0-based 시작 컬럼). */
const cellsBefore = (line: ReconstructedLine, offset: number) => line.columns[offset] - 1;
/** 오프셋 문자까지 차지한 셀 수(1-based 끝 컬럼). */
const cellsThrough = (line: ReconstructedLine, offset: number) => line.endColumns[offset];

/**
 * `next` 가 `prev` 에서 화면 폭 때문에 넘어간 연속 행인지 판정한다.
 *
 * 이전 논리 줄은 물리 행 하나여야 한다 — 터미널 soft-wrap(`isWrapped`) 으로
 * 이어진 줄 다음 행은 호출부가 판정하지 않는다. TUI 는 한 행보다 긴
 * 토큰을 soft-wrap 에 맡길 때 그 토큰을 자기 행으로 빼고 다음 내용을 새 행에서
 * 시작하며(Codex), soft-wrap 꼬리 행이 끝 칸까지 찼는지는 앞 내용 길이로 우연히
 * 정해져 셸 출력(`tls.crt: <긴 base64>` 다음 키)을 오결합한다.
 *
 * @param prev 이전 논리 줄(물리 행 하나).
 * @param next 다음 논리 줄의 첫 물리 행.
 * @param cols 터미널 폭(셀).
 */
export function detectTuiWrap(
  prev: ReconstructedLine,
  next: ReconstructedLine,
  cols: number,
  style: WrapStyle = "word",
): WrapJoin | null {
  if (FRAME_RE.test(prev.text) || FRAME_RE.test(next.text)) return null;
  if (TRUNCATED_RE.test(prev.text)) return null;
  const p = rowShape(prev);
  const n = rowShape(next);
  if (!p || !n) return null;
  if (MARKER_RE.test(next.text.slice(n.indent))) return null;

  // 연속 행은 이전 문단의 내어쓰기에 정렬된다 — 마커 뒤 내용 시작(`● `·`  - `
  // 다음) 또는 마커 없는 행이면 그 행의 들여쓰기.
  const nextIndentCells = cellsBefore(next, n.indent);
  if (
    nextIndentCells !== cellsBefore(prev, p.indent) &&
    nextIndentCells !== cellsBefore(prev, p.contentStart)
  ) {
    return null;
  }

  const prevEnd = cellsThrough(prev, p.last);
  // 들여쓰기를 `[ \t]` 로 찾았으니 토큰도 같은 문자 집합으로 끊는다 — `\S` 로
  // 끊으면 U+3000·NBSP 로 시작하는 행에서 매치가 없어 예외가 난다.
  const token = /^[^ \t]+/.exec(next.text.slice(n.indent))![0];
  const tokenCells = cellsThrough(next, n.indent + token.length - 1) - nextIndentCells;
  if (prevEnd + 1 + tokenCells <= cols) return null;

  // 한 행보다 긴 토큰(URL 등)은 행 끝까지 채운 뒤 글자 단위로 잘린다. 앞 행이
  // 줄바꿈 폭까지 찼고 두 조각을 합친 길이가 한 행에 들어가지 않을 때만 그렇게
  // 본다 — 짧은 앞 단어 뒤로 긴 URL 이 통째로 다음 행에 놓인 경우(`문서는` +
  // URL 행)는 어절 경계다. 줄바꿈 폭은 cols 보다 작을 수 있다: Codex 입력창은
  // cols-1, Claude OAuth 화면은 오른쪽 여백 2칸(cols-2)에서 자른다.
  // 행이 전각 공백·NBSP 로 끝나면 `\S` 토큰이 없다 — 그 글자 하나를 머리로 본다.
  const headMatch = prev.text.slice(0, p.last + 1).search(/\S+$/);
  const headStart = headMatch < 0 ? p.last : headMatch;
  const headCells = prevEnd - cellsBefore(prev, headStart);
  // 다음 행이 새 URL 로 시작하면 앞 토큰의 꼬리가 아니다(URL 두 개가 연달아 온 경우).
  const midToken =
    prevEnd >= cols - WRAP_MARGIN &&
    headCells + tokenCells > cols - nextIndentCells &&
    !/^https?:\/\//i.test(token);

  // 음절 사이에서도 자르는 줄바꿈기: 와이드 문자끼리 맞닿은 경계에서 다음 글자가
  // 앞 행에 들어갈 자리가 없었다면 단어 중간으로 본다. 줄바꿈 폭은 cols-1 일 수
  // 있다(Codex 입력창) — 1셀 여백 안에서 구분되지 않는 경계는 공백 없이 잇는 쪽으로
  // 기운다(위 `WrapStyle` 설명과 같은 방향).
  const lastWide = prevEnd - cellsBefore(prev, p.last) > 1;
  const firstCells = cellsThrough(next, n.indent) - nextIndentCells;
  const midSyllable =
    style === "anywhere" && lastWide && firstCells > 1 && prevEnd + firstCells > cols - 1;

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
 * 연속 행을 개행 없이 붙이므로 논리 줄 수가 `lines` 길이와 같아야 한다. 일반
 * 선택은 첫 줄이 행 끝까지, 나머지 줄이 0열부터 이어지므로 각 줄이 버퍼 행
 * 텍스트와 맞아야 한다(첫 줄은 접미, 가운데 줄은 전체, 마지막 줄은 접두). 아니면
 * (열 선택 모드 등) 매핑을 믿을 수 없어 `null` 을 돌려준다.
 *
 * 내어쓰기 없는(0열에서 시작하는) 연속 행은 잇지 않는다. TUI 의 연속 행은 항상
 * 내어쓰기(2칸 이상)가 있고, 0열 행이 화면 폭을 채우는 출력은 대부분 셸 출력이다
 * — pytest 진행 줄·`ps aux` 처럼 폭에 맞춰 채우거나 잘린 행을 한 줄로 합치면 안
 * 된다.
 *
 * `prose` 가 거짓이면 행 끝에서 잘린 URL 의 꼬리(구분자 `""` 이고 이어 붙일 앞
 * 토큰이 `http(s)://` 를 담은 경우)만 잇는다. 어절 경계 결합은 줄바꿈기가 산문을
 * 다시 흘려 배치했다는 가정에 기대므로, 같은 깊이의 코드·설정 파일 줄(`cat`
 * 출력)이 우연히 행 끝 근처에서 끝나면 원래 개행을 지운다. 단어 중간 결합도
 * 들여쓴 고정폭 토큰 행(YAML 안 PEM 블록)이 폭을 채우면 성립하므로 셸에서는 URL
 * 로 한정한다 — 둘 다 TUI 가 실행 중일 때만 넓게 켠다.
 */
export function joinTuiWrappedLines(
  lines: string[],
  rows: WrapRow[],
  cols: number,
  style: WrapStyle = "word",
  prose = true,
): string[] | null {
  const groups: WrapRow[][] = [];
  for (const row of rows) {
    if (groups.length > 0 && row.isWrapped) groups[groups.length - 1].push(row);
    else groups.push([row]);
  }
  if (groups.length !== lines.length) return null;
  if (!selectionMatchesRows(lines, groups)) return null;

  const out = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    const prevGroup = groups[i - 1];
    const join =
      prevGroup.length === 1 ? detectTuiWrap(prevGroup[0], groups[i][0], cols, style) : null;
    const line = lines[i];
    const indent = line.slice(0, join?.contentOffset ?? 0);
    if (
      join &&
      (prose || (join.separator === "" && endsInUrlToken(out[out.length - 1]))) &&
      join.contentOffset > 0 &&
      /^[ \t]*$/.test(indent) &&
      line.length > join.contentOffset
    ) {
      // 앱이 행 끝까지 공백을 직접 쓰면 선택 문자열에 그대로 남아 있다.
      // 선택이 앞 행 내용 오른쪽 빈칸에서 시작했으면 앞 줄이 비어 있다 — 구분자를 넣지 않는다.
      const head = out[out.length - 1].replace(/[ \t]+$/, "");
      out[out.length - 1] =
        head + (head === "" ? "" : join.separator) + line.slice(join.contentOffset);
    } else {
      out.push(line);
    }
  }
  return out;
}

/**
 * 선택 문자열이 일반(행 단위) 선택으로 버퍼 행에서 나왔는지 확인한다. xterm 은
 * `isWrapped` 행을 개행 없이 붙이고 행마다 빈 셀만 잘라 낸다 — 앱이 직접 쓴 끝
 * 공백은 남고 NBSP 는 공백으로 바뀐다. 그래서 양쪽을 같은 규칙(NBSP → 공백, 끝
 * `[ \t]` 제거)으로 맞춘 뒤 비교한다. 열 선택은 둘째 줄부터 선택 시작 열에서
 * 잘리므로 여기서 걸러진다.
 */
function selectionMatchesRows(lines: string[], groups: WrapRow[][]): boolean {
  const NBSP = String.fromCharCode(0xa0);
  const norm = (s: string) =>
    s
      .split(NBSP)
      .join(" ")
      .replace(/[ \t]+$/, "");
  const last = lines.length - 1;
  return lines.every((raw, i) => {
    const text = norm(groups[i].map((row) => norm(row.text)).join(""));
    const line = norm(raw);
    if (i === 0) return text.endsWith(line);
    return i === last ? text.startsWith(line) : text === line;
  });
}

/** 끝 공백을 뺀 마지막 토큰이 URL 을 담는가 — 여러 행에 걸친 URL 이면 이어 붙인 결과를 본다. */
function endsInUrlToken(text: string): boolean {
  return /https?:\/\/\S*$/i.test(text.replace(/[ \t]+$/, ""));
}

/** 버퍼 결합을 시도하는 최대 선택 행 수 — 넘으면(전체 scrollback 복사 등) 원문을 쓴다. */
export const MAX_JOIN_ROWS = 2000;

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
 * 지운다. 선택 위치·행을 읽지 못하거나, 행이 `MAX_JOIN_ROWS` 를 넘거나, 논리 줄
 * 매핑이 맞지 않으면 `text` 를 그대로 돌려준다 — 복사가 원문보다 나빠지는 일은
 * 없다. `prose` 는 `joinTuiWrappedLines` 와 같다.
 */
export function joinTuiWrappedSelection(
  terminal: SelectionSource,
  text: string,
  style: WrapStyle = "word",
  prose = true,
): string {
  const position = terminal.getSelectionPosition();
  if (!position || !text.includes("\n")) return text;
  const startY = Math.min(position.start.y, position.end.y);
  const endY = Math.max(position.start.y, position.end.y);
  if (endY - startY + 1 > MAX_JOIN_ROWS) return text;
  const rows: WrapRow[] = [];
  for (let y = startY; y <= endY; y++) {
    const line = terminal.buffer.active.getLine(y);
    if (!line) return text;
    rows.push({ ...reconstructLine(readLineCells(line)), isWrapped: line.isWrapped });
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const joined = joinTuiWrappedLines(text.split(/\r?\n/), rows, terminal.cols, style, prose);
  return joined ? joined.join(eol) : text;
}
