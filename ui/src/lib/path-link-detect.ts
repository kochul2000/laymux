/**
 * 터미널에서 사용자가 *선택(드래그)* 한 (상대/절대) 파일/디렉토리 경로를
 * 클릭으로 viewer 열기·cwd 이동하는 기능(issue #363, 선택 기반)의 순수 로직.
 *
 * 책임 분리:
 *   - 선택 문자열에서 경로 토큰 추출/정리(`trimSelectionToPath`)와 cwd 조합
 *     (`joinCwdPath`, MSYS 정규화 포함), 선택 좌표→버퍼 좌표 매핑
 *     (`mapSelectionToPathRange`), stat 결과 분기(`decidePathLinkAction`)는
 *     여기(순수 함수)에서 한다.
 *   - 절대 경로의 *실제 존재 여부*는 백엔드 `stat_path` 가 판정한다(여기서는
 *     fs 접근하지 않는다). 선택 기반이라 형태 휴리스틱은 느슨하게 두고
 *     존재 검증을 실질 게이트로 삼는다.
 */

import { reconstructLine, type CellInfo } from "./terminal-cell-map";

/** 흔한 URL/프로토콜 스킴 — 이 스킴이 붙어 있으면 경로가 아니다(URL provider 담당). */
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/** 넓은 선택에서 maximal token을 자르는 경계. 내부 substring은 다시 보지 않는다. */
const SELECTION_TOKEN_RE = /[^\s"'`()<>[\]{}|]+/g;

/** 넓은 선택에서 맨이름 오탐을 줄이는 파일 확장자 형태. */
const FILE_EXTENSION_RE = /\.[A-Za-z][A-Za-z0-9_-]{0,15}$/;

export const PATH_LINK_MAX_SELECTION_LENGTH = 1024;
export const PATH_LINK_MAX_SELECTION_LINES = 8;
export const PATH_LINK_MAX_CANDIDATES = 16;

export interface PathSelectionCandidate {
  /** 장식과 `:line:col`을 제거한 경로 원문. */
  text: string;
  /** 선택 문자열 안의 0-based 줄 번호. */
  lineIndex: number;
  /** 해당 선택 줄 안의 UTF-16 시작 offset(inclusive). */
  startIndex: number;
  /** 해당 선택 줄 안의 UTF-16 끝 offset(exclusive). */
  endIndex: number;
}

export interface PathSelectionLimits {
  maxSelectionLength: number;
  maxLines: number;
  maxCandidates: number;
  maxPathLength: number;
}

/** 비동기 stat 요청이 시작된 뒤 pane CWD가 바뀌지 않았는지 확인한다. */
export function isPathLinkCwdCurrent(
  requestedCwd: string | undefined,
  currentCwd: string | undefined,
): boolean {
  return requestedCwd === currentCwd;
}

export function pathSelectionLimits(maxPathLength: number): PathSelectionLimits {
  return {
    maxSelectionLength: PATH_LINK_MAX_SELECTION_LENGTH,
    maxLines: PATH_LINK_MAX_SELECTION_LINES,
    maxCandidates: PATH_LINK_MAX_CANDIDATES,
    maxPathLength,
  };
}

/** 절대 경로 판별: POSIX `/`, Windows 드라이브 `C:\`/`C:/`, UNC `\\`. */
export function isAbsolutePath(path: string): boolean {
  if (path.startsWith("/")) return true;
  if (/^[A-Za-z]:[\\/]/.test(path)) return true;
  if (path.startsWith("\\\\")) return true;
  return false;
}

/**
 * 토큰에서 경로가 아닌 장식을 떼어낸다.
 * - 후행 `:line:col`(grep/컴파일러 스타일) 제거.
 * - 후행 문장부호(`.,;:` 등) 제거.
 * 시작/끝 컬럼 보정을 위해 앞에서 떼어낸 길이도 함께 반환한다.
 */
export function trimPathToken(raw: string): { text: string; leading: number } {
  let text = raw;
  let leading = 0;

  // 앞쪽 여는 괄호/따옴표 제거.
  const leadMatch = text.match(/^[("'`[{<]+/);
  if (leadMatch) {
    leading = leadMatch[0].length;
    text = text.slice(leading);
  }

  // 뒤쪽 닫는 괄호/따옴표 제거.
  text = text.replace(/[)"'`\]}>]+$/, "");

  // 후행 문장부호(마침표/쉼표/세미콜론/콜론) 먼저 제거 — `file:42:5:` 처럼
  // 줄번호 뒤에 콜론이 더 붙은 grep 출력을 정리한다.
  text = text.replace(/[.,;:]+$/, "");

  // 후행 `:line` 또는 `:line:col`(숫자) 제거 — 경로 자체에는 포함 안 함.
  // 여러 번 붙을 수 있으므로(`file:42:5`) 반복 매칭으로 모두 제거한다.
  text = text.replace(/(:\d+)+$/, "");

  return { text, leading };
}

/**
 * MSYS/git-bash 스타일 cwd(`^/<drive>/...`)를 Windows 드라이브 경로로 변환한다.
 *
 * git-bash/MSYS 셸은 cwd 를 `/d/PycharmProjects/...` 처럼 POSIX 드라이브 표기로
 * 보고한다. 이 문자열을 그대로 상대경로와 조합해 백엔드 `stat_path`
 * (`resolve_address_path`)로 넘기면, 선행 `/` 가 `/mnt/` 가 아니므로 Windows
 * 에서 WSL 경로(`\\wsl.localhost\...`)로 오인돼 검증이 실패한다(이슈 #363 Win 증상).
 *
 * 그래서 이 기능 범위 안에서만, 조합 *직전에* MSYS cwd 를 `X:\...` 로 바꾼다.
 * 백엔드 `resolve_address_path` 는 전역 변경하지 않는다.
 *
 * 변환 규칙(보수적):
 *   - `^/<단일영문자>(/...|$)` → `<대문자>:\...` (예: `/d/proj` → `D:\proj`).
 *   - `/mnt/...`(WSL 마운트)은 변환하지 않는다 — WSL/POSIX 경로로 그대로 둔다.
 *   - 그 외(`\\wsl.localhost\...`, `C:\...`, 일반 POSIX `/home/...`)는 그대로.
 *
 * `^/c/` 처럼 한 글자 디렉토리가 실제 POSIX 경로일 가능성도 있으나, MSYS 가
 * 보고하는 cwd 맥락에서는 드라이브 표기가 압도적이고, 변환 후에도 백엔드가
 * 실제 존재를 stat 으로 검증하므로 false positive 로 인한 오작동은 없다.
 */
export function normalizeMsysCwd(cwd: string): string {
  // `/mnt/...` 은 제외(WSL 마운트). 그 외 `^/<a>/` 또는 `^/<a>$` 만 변환.
  const m = /^\/([A-Za-z])(\/.*|)$/.exec(cwd);
  if (!m) return cwd;
  if (cwd.startsWith("/mnt/")) return cwd;
  const drive = m[1].toUpperCase();
  const rest = m[2].replace(/\//g, "\\"); // 선행 `/` 포함 → `\...`
  return `${drive}:${rest}`;
}

/**
 * cwd 와 (상대) 경로를 조합해 절대 경로 문자열을 만든다.
 * - 입력이 이미 절대 경로면 그대로 반환.
 * - MSYS 스타일 cwd(`^/<drive>/...`)는 먼저 Windows 드라이브 경로로 정규화한다.
 * - cwd 가 Windows 스타일(`C:\` 또는 `\\`)이면 백슬래시로, 아니면 슬래시로 조합.
 * - cwd 가 비어 있으면 null.
 *
 * 실제 경로 정규화(`..`, WSL/Windows 변환)는 백엔드 `resolve_address_path`
 * 가 담당하므로 여기서는 단순 결합만 한다.
 */
export function joinCwdPath(cwdRaw: string | undefined, relativePath: string): string | null {
  if (isAbsolutePath(relativePath)) return relativePath;
  if (!cwdRaw || cwdRaw.length === 0) return null;
  const cwd = normalizeMsysCwd(cwdRaw);

  const cwdIsWindows = /^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith("\\\\");
  const sep = cwdIsWindows ? "\\" : "/";

  // cwd 후행 구분자 제거.
  const base = cwd.replace(/[\\/]+$/, "");
  // 상대경로의 구분자를 대상 OS 구분자로 통일.
  const rel = cwdIsWindows ? relativePath.replace(/\//g, "\\") : relativePath.replace(/\\/g, "/");

  return `${base}${sep}${rel}`;
}

/**
 * 선택(드래그) 문자열을 경로 토큰으로 정리한다(선택 기반 동작, 이슈 #363 재설계).
 *
 * 줄 전체를 토큰별로 도는 대신, 사용자가 선택한 *한 덩어리* 문자열을 받아
 * `trimPathToken` 으로 양끝 공백/따옴표/괄호/grep 꼬리(`:line:col`)를 정리한다.
 * 선택은 보통 한 토큰이다.
 *
 * 반환:
 *   - 경로처럼 보이면 정리된 경로 텍스트(`text`).
 *   - 비었거나 경로처럼 안 보이면 null.
 *
 * 길이 가드(maxLength)는 호출부에서 *원본 선택 길이* 로 먼저 적용한다
 * (여기서는 형태 판별만). 순수 함수라 fs 접근/설정 의존이 없다.
 */
export function trimSelectionToPath(selection: string): string | null {
  if (!selection) return null;
  // 여러 줄 선택은 미지원: 첫 줄만 본다(깨지지 않게 안전 처리).
  const firstLine = selection.split(/\r?\n/, 1)[0] ?? "";
  const trimmedOuter = firstLine.trim();
  if (!trimmedOuter) return null;
  // 선택 안에 공백이 끼어 있으면(여러 토큰) 경로 한 건으로 보지 않는다.
  if (/\s/.test(trimmedOuter)) return null;

  const { text } = trimPathToken(trimmedOuter);
  if (!text) return null;
  // URL 은 WebLinks/indented provider 가 담당 → 제외.
  if (SCHEME_RE.test(text)) return null;
  // 선택 기반(#363): 사용자가 명시적으로 고른 단일 토큰이므로 슬래시·확장자가
  // 없는 맨이름(디렉토리/확장자 없는 파일, 예: `laymux`, `v3`)도 후보로 받는다.
  // 형태 휴리스틱으로 거르지 않고, 실제 존재 여부는 stat_path 가 판정한다
  // (존재하지 않으면 밑줄/링크가 켜지지 않음).
  return text;
}

function looksLikeStrongPath(text: string): boolean {
  return isAbsolutePath(text) || /[\\/]/.test(text) || FILE_EXTENSION_RE.test(text);
}

/**
 * 선택 영역을 왼쪽부터 maximal-munch로 소비해 서로 겹치지 않는 경로 후보를 찾는다.
 *
 * 단일 maximal token 선택은 기존 선택 기반 계약을 유지해 `laymux` 같은 맨이름도
 * 받는다. 넓은 선택에서는 일반 단어의 stat 폭증을 막기 위해 절대경로, 구분자,
 * 확장자 중 하나가 있는 strong candidate만 받는다. 한 maximal token을 후보로
 * 확정하거나 버린 뒤에는 그 내부 suffix를 다시 경로로 해석하지 않는다. 따라서
 * 긴 후보의 stat이 실패해도 우연히 존재하는 basename으로 fallback하지 않는다.
 *
 * 상한을 넘긴 선택이나 후보가 너무 많은 선택은 부분 결과가 아니라 빈 목록을
 * 반환한다. 그래야 잘린 결과 일부만 링크로 보이는 예측 불가능한 상태가 없다.
 */
export function extractPathCandidatesFromSelection(
  selection: string,
  limits: PathSelectionLimits,
): PathSelectionCandidate[] {
  if (
    !selection ||
    selection.length > limits.maxSelectionLength ||
    limits.maxLines < 1 ||
    limits.maxCandidates < 1 ||
    limits.maxPathLength < 1
  ) {
    return [];
  }

  const lines = selection.split(/\r?\n/);
  if (lines.length > limits.maxLines) return [];

  const maximalTokens: Array<PathSelectionCandidate & { strong: boolean }> = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const matcher = new RegExp(SELECTION_TOKEN_RE.source, "g");
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(line)) !== null) {
      const raw = match[0];
      const { text, leading } = trimPathToken(raw);
      if (!text || SCHEME_RE.test(text)) continue;
      const startIndex = match.index + leading;
      maximalTokens.push({
        text,
        lineIndex,
        startIndex,
        endIndex: startIndex + text.length,
        strong: looksLikeStrongPath(text),
      });
    }
  }

  const exactSingleToken =
    maximalTokens.length === 1 && trimSelectionToPath(selection) === maximalTokens[0].text;
  const candidates: PathSelectionCandidate[] = [];
  for (const candidate of maximalTokens) {
    if (candidate.text.length > limits.maxPathLength) continue;
    if (!exactSingleToken && !candidate.strong) continue;
    candidates.push({
      text: candidate.text,
      lineIndex: candidate.lineIndex,
      startIndex: candidate.startIndex,
      endIndex: candidate.endIndex,
    });
    if (candidates.length > limits.maxCandidates) return [];
  }
  return candidates;
}

/**
 * 길이 가드: 선택 문자열이 비었거나 `maxLength` 를 초과하면 false.
 * (파싱·stat 전에 호출부에서 싸게 거르는 용도. 순수 함수.)
 */
export function isWithinPathLengthLimit(selection: string, maxLength: number): boolean {
  if (!selection) return false;
  return selection.length <= maxLength;
}

/** stat 결과(`{exists,isDirectory}`)로 클릭 동작 분기를 결정한다. */
export type PathLinkAction = "none" | "openFile" | "changeDir";

/**
 * stat 결과를 클릭 동작으로 매핑한다(순수 분기 함수).
 *   - 존재하지 않음 → "none"(밑줄 없음).
 *   - 디렉토리 → "changeDir"(cwd 전파).
 *   - 파일 → "openFile"(viewer).
 */
export function decidePathLinkAction(stat: {
  exists: boolean;
  isDirectory: boolean;
}): PathLinkAction {
  if (!stat.exists) return "none";
  return stat.isDirectory ? "changeDir" : "openFile";
}

/** xterm `getSelectionPosition()` 가 돌려주는 선택 좌표(모델 좌표). */
export interface SelectionPos {
  /** 선택 시작 셀. */
  start: { x: number; y: number };
  /** 선택 끝 셀. */
  end: { x: number; y: number };
}

/**
 * 셀 정보로 토큰의 실제 셀 범위를 찾는다(#691). 실패하면 null → 호출부가
 * 문자열 기반 계산으로 떨어진다.
 *
 * 선택 시작 셀보다 앞에서는 찾지 않는다. 같은 토큰이 한 줄에 여러 번 나오면
 * (`a.txt ... a.txt`) 사용자가 고른 쪽에 밑줄이 가야 하므로, 앞쪽 인스턴스로
 * 되돌아가는 재검색을 두지 않는다(그건 실패를 오답으로 바꾼다).
 *
 * 앵커를 `endColumns` 로 잡는 이유: xterm 은 와이드 문자의 **뒷칸**을 선택
 * 시작으로 보고할 수 있다(`Mouse.getCoords` 가 셀 중앙을 기준으로 반올림).
 * 끝 컬럼으로 비교하면 그 경우에도 해당 문자 자신의 오프셋에서 검색이 시작된다.
 */
function mapWithCells(
  pos: SelectionPos,
  token: string,
  lineCells: CellInfo[],
): MappedPathRange | null {
  const { text, columns, endColumns } = reconstructLine(lineCells);
  const startCell = pos.start.x + 1; // 0-based 셀 → 1-based 컬럼
  const searchFrom = endColumns.findIndex((col) => col >= startCell);
  if (searchFrom < 0) return null;
  const index = text.indexOf(token, searchFrom);
  if (index < 0) return null;

  const lastOffset = index + token.length - 1;
  const startCol = columns[index];
  const endCol = endColumns[lastOffset];
  if (startCol === undefined || endCol === undefined) return null;

  return { bufferLine: pos.start.y + 1, startCol, endCol };
}

/** provider 에 넘길 1-based 절대 버퍼 좌표 범위. */
export interface MappedPathRange {
  /** 1-based 절대 버퍼 라인. */
  bufferLine: number;
  /** 1-based 시작 컬럼(inclusive). */
  startCol: number;
  /** 1-based 끝 컬럼(inclusive). */
  endCol: number;
}

/**
 * 선택 상대 후보 범위를 xterm의 1-based 절대 버퍼 셀 범위로 변환한다.
 * 첫 줄만 `position.start.x`에서 시작하고 이후 줄은 셀 0에서 시작한다.
 */
export function mapSelectionCandidateToPathRange(
  position: SelectionPos,
  candidate: PathSelectionCandidate,
  lineCells?: CellInfo[],
): MappedPathRange {
  const selectionBaseCol0 = candidate.lineIndex === 0 ? position.start.x : 0;
  const fallbackStartCol = selectionBaseCol0 + candidate.startIndex + 1;
  const fallbackEndCol = fallbackStartCol + candidate.text.length - 1;
  const bufferLine = position.start.y + candidate.lineIndex + 1;

  if (lineCells && lineCells.length > 0) {
    const { text, columns, endColumns } = reconstructLine(lineCells);
    const selectionStartCell = selectionBaseCol0 + 1;
    const selectionStartOffset = endColumns.findIndex((column) => column >= selectionStartCell);
    if (selectionStartOffset >= 0) {
      const startOffset = selectionStartOffset + candidate.startIndex;
      const endOffset = selectionStartOffset + candidate.endIndex - 1;
      if (
        text.slice(startOffset, endOffset + 1) === candidate.text &&
        columns[startOffset] !== undefined &&
        endColumns[endOffset] !== undefined
      ) {
        return {
          bufferLine,
          startCol: columns[startOffset],
          endCol: endColumns[endOffset],
        };
      }
    }
  }

  return { bufferLine, startCol: fallbackStartCol, endCol: fallbackEndCol };
}

/**
 * xterm 선택 좌표를 검증 선택 범위(1-based 절대 버퍼 좌표)로 매핑한다.
 *
 * 좌표계 주의: `Terminal.getSelectionPosition()` 은 SelectionService 의 모델
 * 좌표(selectionStart/End)를 가공 없이 반환하는데, 이는 **0-based** 이고 `end`
 * 는 **exclusive**(마지막 선택 셀 +1)다. 타입 정의의 "1-based" 주석과 실제
 * 구현이 어긋나는 알려진 불일치. 반면 `ILinkProvider.provideLinks` 의
 * `bufferLineNumber` 와 `ILink.range` 의 셀 좌표는 **1-based 절대 버퍼 라인**
 * (기존 indented-link-provider 와 동일)이다. 따라서 여기서 0-based → 1-based 로
 * 보정하지 않으면 밑줄이 한 행 위·한 칸 왼쪽에 그려진다(#363 회귀).
 *
 * 단일 라인 선택을 가정한다. `rawFirstLine`(선택 원문 첫 줄)에서 `token`
 * (trim 된 경로) 위치를 찾으면, 앞쪽 장식(공백/따옴표/괄호)을 떼어낸 만큼
 * 시작 컬럼을 밀어 실제 경로 셀에만 밑줄이 가게 한다. 여러 줄 선택이면 첫 줄만
 * 사용한다(깨지지 않게).
 */
export function mapSelectionToPathRange(
  pos: SelectionPos,
  rawFirstLine: string,
  token: string,
  lineCells?: CellInfo[],
): MappedPathRange {
  // #691: 셀 정보가 있으면 그쪽이 정확하다. 아래 문자열 기반 계산은 UTF-16
  // 길이를 셀 수로 쓰기 때문에 한글/CJK 경로에서 밑줄이 절반만 그어진다.
  if (lineCells && lineCells.length > 0) {
    const mapped = mapWithCells(pos, token, lineCells);
    if (mapped) return mapped;
  }
  const sameLine = pos.start.y === pos.end.y;
  // 0-based 프레임에서 먼저 계산.
  let startCol0 = pos.start.x;
  // end.x 는 exclusive → 마지막 선택 셀은 end.x - 1. 시작==끝(빈 폭)이면 시작 셀.
  let endCol0 = pos.start.x === pos.end.x ? pos.start.x : pos.end.x - 1;
  const tokenIdx = rawFirstLine.indexOf(token);
  if (tokenIdx >= 0) {
    // 토큰을 첫 줄에서 찾으면 줄 수와 무관하게 첫 줄 기준으로 정확히 매핑.
    // (rawFirstLine 은 선택 시작 컬럼부터의 첫 줄 내용 → +pos.start.x 가 절대 컬럼)
    startCol0 = pos.start.x + tokenIdx;
    endCol0 = startCol0 + token.length - 1;
  } else if (!sameLine) {
    // 여러 줄 선택인데 토큰 위치 불명: end.x 는 다른 줄 좌표라 무의미 → 시작 셀만.
    endCol0 = startCol0;
  }
  if (endCol0 < startCol0) endCol0 = startCol0;
  // 0-based → 1-based 절대 버퍼 좌표로 보정.
  return {
    bufferLine: pos.start.y + 1,
    startCol: startCol0 + 1,
    endCol: endCol0 + 1,
  };
}
