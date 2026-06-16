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
function trimPathToken(raw: string): { text: string; leading: number } {
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
 * cwd 와 (상대) 경로를 조합해 절대 경로 문자열을 만든다.
 * - 입력이 이미 절대 경로면 그대로 반환.
 * - cwd 가 Windows 스타일(`C:\` 또는 `\\`)이면 백슬래시로, 아니면 슬래시로 조합.
 * - cwd 가 비어 있으면 null.
 *
 * 실제 경로 정규화(`..`, WSL/Windows 변환)는 백엔드 `resolve_address_path`
 * 가 담당하므로 여기서는 단순 결합만 한다.
 */
export function joinCwdPath(cwd: string | undefined, relativePath: string): string | null {
  if (isAbsolutePath(relativePath)) return relativePath;
  if (!cwd || cwd.length === 0) return null;

  const cwdIsWindows = /^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith("\\\\");
  const sep = cwdIsWindows ? "\\" : "/";

  // cwd 후행 구분자 제거.
  const base = cwd.replace(/[\\/]+$/, "");
  // 상대경로의 구분자를 대상 OS 구분자로 통일.
  const rel = cwdIsWindows ? relativePath.replace(/\//g, "\\") : relativePath.replace(/\\/g, "/");

  return `${base}${sep}${rel}`;
}
