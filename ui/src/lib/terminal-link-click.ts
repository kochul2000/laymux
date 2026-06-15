/**
 * 풀스크린 TUI(codex 등) 안에서 Shift/Alt+클릭으로 링크를 여는 로직.
 *
 * 배경(issue #352): 앱이 마우스 트래킹(mouse reporting)을 켜면 xterm 의
 * 링크 활성화(linkHandler / WebLinksAddon / registerLinkProvider)가 더 이상
 * 트리거되지 않는다. 클릭이 그대로 앱(codex)으로 전달되기 때문이다. 다수
 * 터미널(iTerm2, Windows Terminal, kitty)의 관례대로 Shift(또는 Alt)를 누른
 * 채 클릭하면 마우스 리포팅을 우회하여 터미널이 로컬에서 링크를 처리한다.
 *
 * 이 모듈은 그 "로컬 링크 탐지" 부분을 순수 함수로 떼어내 테스트 가능하게
 * 만든 것이다. DOM/xterm 접근(좌표→셀 변환, OSC 8 hyperlink 조회)은
 * TerminalView 쪽 래퍼가 담당하고, 여기서는 다음 우선순위로 클릭 셀의
 * 링크 URL 을 도출한다.
 *
 *   1. OSC 8 hyperlink — 클릭한 셀에 hyperlink uri 가 있으면 그대로 사용
 *   2. 평문 URL — 해당 줄에서 WebLinksAddon 과 동일한 정규식으로 탐지
 *   3. 들여쓰기 하드랩 URL — indented-link-provider 와 같은 방식(여러 줄 결합)
 */

import { findIndentedUrls, type IndentedLineInfo } from "./indented-link-provider";

/**
 * WebLinksAddon 이 쓰는 기본 URL 정규식과 동일하게 유지한다.
 * (`@xterm/addon-web-links` lib 내부 상수를 그대로 복제)
 * 평문 URL 클릭 시 WebLinksAddon 과 같은 경계로 URL 을 잘라야 일반 셸과
 * TUI 우회 경로의 동작이 일치한다.
 */
export const WEB_LINK_REGEX =
  /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/;

/**
 * 한 줄 텍스트에서, 주어진 1-based 컬럼을 포함하는 평문 URL 을 찾는다.
 * WebLinksAddon 과 동일한 정규식·경계를 사용한다.
 *
 * @param lineText 줄 전체 문자열(끝쪽 패딩 공백 포함 가능)
 * @param col 1-based 컬럼(클릭한 셀)
 * @returns 매칭된 URL 문자열, 없으면 null
 */
export function findPlainUrlAtCol(lineText: string, col: number): string | null {
  const re = new RegExp(WEB_LINK_REGEX.source, (WEB_LINK_REGEX.flags || "") + "g");
  const zeroBased = col - 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lineText)) !== null) {
    const start = m.index;
    const end = m.index + m[0].length; // exclusive
    if (zeroBased >= start && zeroBased < end) {
      return m[0];
    }
    // 빈 매칭 방어(이론상 발생 안 하지만 무한 루프 방지)
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return null;
}

/** 클릭 셀에서 링크를 도출할 때 호출자가 제공하는 입력. */
export interface LinkAtCellInput {
  /**
   * 클릭한 셀의 OSC 8 hyperlink uri. xterm 버퍼 셀의 hyperlink 정보가
   * 있으면 그 값을, 없으면 undefined. (TerminalView 가 셀에서 조회해 주입)
   */
  oscLinkUri?: string;
  /** 클릭한 줄(들여쓰기 탐지용 윈도우 포함)의 라인 정보. */
  lines: IndentedLineInfo[];
  /** 클릭한 줄의 1-based 버퍼 라인 번호. */
  clickedLineNumber: number;
  /** 클릭한 셀의 1-based 컬럼. */
  col: number;
  /** 들여쓰기 하드랩 URL 결합을 시도할지(설정: paste.linkJoin). */
  enableIndentedJoin: boolean;
}

/**
 * 클릭한 셀에 대응하는 링크 URL 을 우선순위에 따라 도출한다.
 * OSC 8 → 평문 URL → 들여쓰기 하드랩 URL 순. 없으면 null.
 */
export function resolveLinkAtCell(input: LinkAtCellInput): string | null {
  // 1) OSC 8 hyperlink 우선
  if (input.oscLinkUri) {
    return input.oscLinkUri;
  }

  // 2) 들여쓰기 하드랩 URL(여러 줄 결합) — 평문보다 먼저 시도한다.
  //    findIndentedUrls 는 "여러 줄에 걸쳐 결합되는" URL 만 반환하므로,
  //    단일 줄 URL 은 여기서 잡히지 않고 아래 평문 경로로 떨어진다. 반대로
  //    하드랩 URL 의 첫 줄을 클릭하면 평문 정규식이 그 줄에서 잘린 조각만
  //    매칭하므로(예: `...&redirect_uri`), 먼저 결합 URL 을 확인해야 전체
  //    URL 이 열린다.
  if (input.enableIndentedJoin) {
    const matches = findIndentedUrls(input.lines, input.clickedLineNumber);
    for (const match of matches) {
      // 클릭한 셀이 링크 범위 안에 있는지 확인
      const { start, end } = match.range;
      const inRange =
        (input.clickedLineNumber > start.y ||
          (input.clickedLineNumber === start.y && input.col >= start.x)) &&
        (input.clickedLineNumber < end.y ||
          (input.clickedLineNumber === end.y && input.col <= end.x));
      if (inRange) return match.text;
    }
  }

  // 3) 같은 줄의 평문 URL
  const clicked = input.lines.find((l) => l.lineNumber === input.clickedLineNumber);
  if (clicked) {
    const plain = findPlainUrlAtCol(clicked.text, input.col);
    if (plain) return plain;
  }

  return null;
}

/**
 * mousedown/click 이벤트가 "수정자키+클릭"으로 링크 우회를 트리거해야
 * 하는지 판정한다. Shift 또는 Alt 를 누른 좌클릭(주 버튼)만 대상.
 * Ctrl 은 IDE 단축키와 충돌하므로 제외한다.
 */
export function isModifierLinkClick(e: {
  button: number;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  if (e.button !== 0) return false;
  return e.shiftKey || e.altKey;
}
