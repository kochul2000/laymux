/**
 * 터미널 출력에 찍힌 (상대/절대) 파일 경로를 Ctrl+클릭으로 viewer 에서
 * 여는 기능(issue #363)의 순수 로직.
 *
 * 기존 URL 링크 처리(`terminal-link-click.ts` / `indented-link-provider.ts`)는
 * `https?://` 스킴만 다룬다. 이 모듈은 그 옆에서 "스킴 없는 파일 경로"
 * (예: `ui/src/index.css`, `Cargo.toml`, `/etc/hosts`)를 감지한다.
 *
 * 책임 분리:
 *   - 경로처럼 보이는지 판별(false positive 최소화)과 클릭 셀에서 토큰
 *     추출은 여기(순수 함수)에서 한다.
 *   - cwd 와 조합한 절대 경로의 *실제 존재 여부*는 백엔드 `stat_path`
 *     커맨드가 판정한다(여기서는 fs 접근하지 않는다).
 *
 * 휴리스틱(임의 단어를 경로로 오인하지 않도록):
 *   1. URL 스킴(`scheme://`)이 있으면 경로 아님 → URL provider 담당.
 *   2. 절대 경로(`/...`, `C:\...`, `\\server\...`)는 경로로 본다.
 *   3. 상대 경로는 다음 중 하나를 만족해야 한다:
 *      - 디렉토리 구분자(`/` 또는 `\`)가 1개 이상 + 파일 확장자가 있거나
 *      - 디렉토리 구분자가 2개 이상(확장자 없는 디렉토리 경로 허용) 이거나
 *      - 구분자가 없어도 알려진 파일명(확장자 보유, 예: `package.json`).
 */

/** 한 줄에서 추출한 경로 후보(1-based 컬럼 범위 포함). */
export interface PathCandidate {
  /** 따옴표/괄호/후행 구두점을 제거한 경로 텍스트. */
  text: string;
  /** 1-based 시작 컬럼(`text` 의 첫 글자가 줄에서 차지하는 컬럼). */
  startCol: number;
  /** 1-based 끝 컬럼(`text` 의 마지막 글자). */
  endCol: number;
}

/** 흔한 URL/프로토콜 스킴 — 이 스킴이 붙어 있으면 경로가 아니다. */
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/**
 * 파일 확장자: 마지막 세그먼트 끝의 `.ext`.
 * 첫 글자는 반드시 영문자여야 한다 — 그래야 `v1.2.3` 의 `.3` 같은
 * 버전 번호 꼬리를 확장자로 오인하지 않는다(false positive 방지).
 */
const EXT_RE = /\.[A-Za-z][A-Za-z0-9]{0,7}$/;

/** 절대 경로 판별: POSIX `/`, Windows 드라이브 `C:\`/`C:/`, UNC `\\`. */
export function isAbsolutePath(path: string): boolean {
  if (path.startsWith("/")) return true;
  if (/^[A-Za-z]:[\\/]/.test(path)) return true;
  if (path.startsWith("\\\\")) return true;
  return false;
}

/**
 * 토큰 하나가 "파일/디렉토리 경로처럼" 보이는지 판별한다.
 * fs 접근 없이 형태만 본다(실제 존재는 백엔드가 검증).
 */
export function looksLikePath(token: string): boolean {
  if (!token) return false;
  // URL 은 별도 provider 가 처리한다.
  if (SCHEME_RE.test(token)) return false;

  if (isAbsolutePath(token)) return true;

  const sepCount = (token.match(/[\\/]/g) ?? []).length;
  // 의도된 트레이드오프(리뷰 F): 슬래시 1개만 있어도 경로 후보로 본다.
  // `n/a`, `TODO/FIXME`, `and/or` 같은 비경로도 후보가 되지만, 실제 밑줄/링크는
  // 백엔드 stat_path 존재 검증을 통과해야만 켜진다(provider 의 "valid" 게이트).
  // 즉 형태 판별은 느슨해도 false underline 은 나지 않는다. 존재하지 않는 토큰은
  // invalid 로 캐시되어 재검증 비용도 TTL 동안 들지 않는다.
  if (sepCount >= 1) return true; // a/b, a/b.ext — 슬래시가 있으면 경로

  // 구분자 없음: 확장자 있는 단일 파일명만 허용(예: package.json).
  // `name.ext` 형태여야 하므로 확장자 앞에 1글자 이상 이름이 있어야 한다.
  const extMatch = EXT_RE.exec(token);
  if (!extMatch) return false;
  return token.length > extMatch[0].length;
}

/** 경로 토큰을 자를 때 경계로 쓰는 문자(공백/따옴표/괄호 등). */
const TOKEN_BOUNDARY_RE = /[\s"'`()<>[\]{}|]/;

/** 토큰(비경계 문자의 연속) 추출용. `TOKEN_BOUNDARY_RE` 의 여집합. */
const TOKEN_RE = /[^\s"'`()<>[\]{}|]+/g;

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
 * 한 줄 텍스트에서, 주어진 1-based 컬럼을 포함하는 경로 후보를 찾는다.
 * 경로처럼 보이지 않으면 null.
 *
 * @param lineText 줄 전체 문자열(끝쪽 패딩 공백 포함 가능)
 * @param col 1-based 컬럼(클릭/hover 한 셀)
 */
export function findPathCandidateAtCol(lineText: string, col: number): PathCandidate | null {
  const zeroBased = col - 1;
  if (zeroBased < 0 || zeroBased >= lineText.length) return null;

  // 공백·인용·괄호 경계로 토큰을 자른다.
  let start = zeroBased;
  while (start > 0 && !TOKEN_BOUNDARY_RE.test(lineText[start - 1])) start--;
  let end = zeroBased; // inclusive
  while (end < lineText.length - 1 && !TOKEN_BOUNDARY_RE.test(lineText[end + 1])) end++;

  const rawToken = lineText.slice(start, end + 1);
  if (rawToken.trim().length === 0) return null;

  const { text, leading } = trimPathToken(rawToken);
  if (!text) return null;
  if (!looksLikePath(text)) return null;

  // NOTE(와이드 문자 제약, 리뷰 E): 여기서 컬럼은 `translateToString()` 의
  // *문자열 인덱스* 기준이다. CJK/이모지 같은 와이드 문자는 xterm 셀을 2칸
  // 차지하므로(IBufferCellPosition.x), 줄에 와이드 문자가 앞서 있으면 밑줄
  // 범위가 실제 셀 위치에서 어긋날 수 있다. 이는 기존 `indented-link-provider.ts`
  // (offsetToPos 도 문자열 오프셋을 그대로 셀 컬럼으로 사용)와 동일한 알려진
  // 제약이며, 두 provider 의 셀 매핑을 함께 고치는 것은 후속 이슈로 추적한다.
  const startCol = start + leading + 1; // 1-based
  const endCol = startCol + text.length - 1;

  // 클릭 셀이 실제 경로 텍스트 범위 안인지 확인(떼어낸 장식 위 클릭은 제외).
  if (col < startCol || col > endCol) return null;

  return { text, startCol, endCol };
}

/**
 * 한 줄 전체에서 경로처럼 보이는 토큰을 모두 추출한다.
 * xterm link provider 가 줄 단위로 링크 후보를 등록할 때 사용한다.
 * 공백·인용·괄호 경계로 토큰을 나눈 뒤 각 토큰을 `findPathCandidateAtCol`
 * 과 동일한 정리/판별 로직으로 거른다.
 */
export function findPathCandidatesInLine(lineText: string): PathCandidate[] {
  const results: PathCandidate[] = [];
  const re = new RegExp(TOKEN_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(lineText)) !== null) {
    // 토큰의 첫 글자 1-based 컬럼으로 후보를 재계산(장식 제거·범위 보정 일관).
    const candidate = findPathCandidateAtCol(lineText, m.index + 1);
    if (candidate) results.push(candidate);
  }
  return results;
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
 * 기존 트림/판별 로직(`trimPathToken`/`looksLikePath`)으로 거른다. 선택은
 * 보통 한 토큰이지만, 양끝 공백/따옴표/괄호/grep 꼬리(`:line:col`)는 정리한다.
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
  if (!looksLikePath(text)) return null;
  return text;
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
): MappedPathRange {
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
