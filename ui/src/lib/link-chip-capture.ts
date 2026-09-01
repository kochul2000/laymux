/**
 * 액션 칩 대상의 **좌표 캡처와 수명 좌표** ([ADR-0224](../../../docs/adr/0224-link-activation-chip-gate.md)).
 *
 * 칩은 "캡처한 (버퍼 라인, 컬럼 범위, 원문)이 아직 그 자리에 있는가"로 살고
 * 죽는다. 그 판정은 밑줄의 판정과 **같은 규칙**이어야 하므로(ADR-0224 Decision 3),
 * 규칙 자체를 여기 순수 함수로 두고 desktop `TerminalView` 가 배선만 한다.
 * Remote 는 모듈 경계를 넘지 못해 같은 규칙을 손으로 옮겨 갖는다.
 */

import type { CellInfo } from "./terminal-cell-map";
import { findTokenCellRange, readCellRangeText } from "./terminal-cell-map";

/** 라인을 따라가는 xterm 마커에서 이 모듈이 읽는 부분만. */
export interface ChipLineMarker {
  /** 0-based 절대 버퍼 라인. */
  line: number;
  isDisposed?: boolean;
}

/**
 * 칩 대상의 현재 1-based 절대 버퍼 라인. 없으면 null(= 좌표 무효 → 칩 소멸).
 *
 * **마커가 정본이다.** scrollback trim 은 절대 라인 번호를 밀어내므로 캡처 시점의
 * 번호로 재검사하면 밑줄(마커를 따라간다)과 칩(동결된 번호)이 서로 다른 줄을
 * 본다 — `path-link-provider.tokenStillAtRange` 가 마커의 현재 라인을 믿는 것과
 * 같은 이유다. 마커가 이미 폐기됐으면 xterm 이 그 좌표를 무효화한 것이므로
 * 캡처 번호로 되돌아가지 않고 fail closed 한다.
 */
export function liveChipBufferLine(target: {
  bufferLine: number;
  marker?: ChipLineMarker;
}): number | null {
  const marker = target.marker;
  if (marker) {
    if (marker.isDisposed === true || !Number.isFinite(marker.line)) return null;
    return marker.line + 1;
  }
  return target.bufferLine >= 1 ? target.bufferLine : null;
}

/** 캡처한 셀 범위와 그 자리의 원문. */
export interface ChipCellCapture {
  /** 1-based 절대 버퍼 라인. */
  bufferLine: number;
  /** 1-based 시작 셀. */
  startCol: number;
  /** 1-based 끝 셀(포함). */
  endCol: number;
  /** 캡처 시점에 그 범위에 쓰여 있던 문자열. */
  token: string;
}

export interface UrlChipCaptureInput {
  /** 활성화된 URL. `WebLinksAddon` 경로에서는 화면 원문과 같다고 가정한다. */
  uri: string;
  /** 터미널 폭(셀). 여러 줄 링크의 중간 줄 끝을 정할 때 쓴다. */
  cols: number;
  /** 클릭·탭한 셀(1-based 라인/컬럼). 좌표 변환에 실패했으면 생략. */
  clicked?: { bufferLine: number; col: number };
  /** xterm 이 준 링크 범위(1-based, `end.x` 포함). 없으면 생략. */
  range?: { start: { x: number; y: number }; end: { x: number; y: number } };
  /** 1-based 버퍼 라인의 셀을 읽는다. 라인이 없으면 null. */
  readCells: (bufferLine: number) => CellInfo[] | null;
}

/**
 * URL 칩의 대상 범위를 캡처한다. 확정하지 못하면 **null** 이고 호출부는 칩을
 * 띄우지 않는다.
 *
 * URL 은 밑줄 엔트리가 없으므로 이 캡처가 엔트리를 대신한다. 그래서 캡처가
 * 느슨하면 수명 판정 전체가 느슨해진다 — 특히 `WebLinksAddon` 은 범위를 주지
 * 않아 클릭한 줄에서 URL 을 되찾는데, 화면 원문과 uri 가 다르면(줄바꿈 결합 등)
 * 못 찾는다. 그때 **클릭한 셀 한 칸만 캡처하면** 그 한 글자가 아무 줄에서나
 * 우연히 일치해 재검사를 통과하고, URL 이 지워진 화면에서도 칩이 살아남는다.
 * 한 칸짜리 가짜 캡처를 만드느니 null 을 돌려준다 — 클릭이 아무것도 실행하지
 * 않는 것이 `chip` 모드의 계약이고, 즉시 열고 싶으면 #352 Shift/Alt 우회가
 * 모드와 무관하게 남아 있다.
 *
 * 여러 줄에 걸친 링크는 **클릭한 줄의 구간만** 캡처한다 — 사용자가 본 그 줄이
 * 재검사의 기준이다.
 */
export function captureUrlChipRange(input: UrlChipCaptureInput): ChipCellCapture | null {
  const { uri, cols, clicked, range, readCells } = input;
  let bufferLine = range?.start.y ?? 0;
  let startCol = range?.start.x ?? 1;
  let endCol = range?.end.x ?? cols;

  if (clicked) {
    if (range) {
      if (clicked.bufferLine >= range.start.y && clicked.bufferLine <= range.end.y) {
        bufferLine = clicked.bufferLine;
        startCol = clicked.bufferLine === range.start.y ? range.start.x : 1;
        endCol = clicked.bufferLine === range.end.y ? range.end.x : cols;
      }
    } else {
      const cells = readCells(clicked.bufferLine);
      const found = cells ? findTokenCellRange(cells, uri, clicked.col) : null;
      if (!found) return null;
      bufferLine = clicked.bufferLine;
      startCol = found.startCol;
      endCol = found.endCol;
    }
  } else if (!range) {
    // 좌표도 범위도 없다 — 나중에 다시 볼 자리를 특정할 수 없다.
    return null;
  }

  if (bufferLine < 1) return null;
  const cells = readCells(bufferLine);
  if (!cells) return null;
  const token = readCellRangeText(cells, startCol, endCol);
  if (token.length === 0) return null;
  return { bufferLine, startCol, endCol, token };
}
