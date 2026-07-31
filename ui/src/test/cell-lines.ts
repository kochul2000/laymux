/**
 * 테스트용 셀 격자 생성기 — 평문 문자열을 `CellInfo[]` / `IndentedLineInfo[]` 로
 * 바꾼다.
 *
 * 왜 근사인가. 문자 폭 판정은 xterm 의 Unicode provider 소관이고(ADR-0058)
 * 여기서 재구현할 대상이 아니다. 이 헬퍼는 "오프셋↔컬럼 산술이 맞는가"만
 * 증명하고, **실제 xterm 이 이 바이트를 어떤 셀에 놓는가**는
 * `*.screen.test.ts`(ADR-0074) 가 진짜 버퍼로 확인한다. 두 계층이 짝을 이룰
 * 때만 링크 좌표를 믿을 수 있다(#441, #691, #696).
 */

import type { CellInfo } from "@/lib/terminal-cell-map";
import { reconstructLine } from "@/lib/terminal-cell-map";
import type { IndentedLineInfo } from "@/lib/indented-link-provider";

/** 대표적인 폭 2 구간만 덮는 근사 — 정본은 xterm 의 Unicode provider 다. */
function widthOf(codePoint: number): number {
  if (codePoint >= 0x1100 && codePoint <= 0x115f) return 2; // Hangul Jamo
  if (codePoint >= 0x2e80 && codePoint <= 0xa4cf) return 2; // CJK Radicals ~ Yi
  if (codePoint >= 0xac00 && codePoint <= 0xd7a3) return 2; // Hangul syllables
  if (codePoint >= 0xf900 && codePoint <= 0xfaff) return 2; // CJK compat ideographs
  if (codePoint >= 0xfe30 && codePoint <= 0xfe6f) return 2; // CJK compat forms
  if (codePoint >= 0xff00 && codePoint <= 0xff60) return 2; // Fullwidth forms
  if (codePoint >= 0xffe0 && codePoint <= 0xffe6) return 2; // Fullwidth signs
  if (codePoint >= 0x1f300 && codePoint <= 0x1faff) return 2; // Emoji
  return 1;
}

/**
 * 문자열을 셀 배열로 — 폭 2 문자는 리드 셀(width 2) + 트레일 셀(width 0) 쌍.
 * 이모지처럼 UTF-16 2칸인 문자도 셀 쌍 하나로 들어간다.
 */
export function textCells(text: string): CellInfo[] {
  const cells: CellInfo[] = [];
  for (const char of text) {
    const width = widthOf(char.codePointAt(0)!);
    cells.push({ chars: char, width });
    if (width === 2) cells.push({ chars: "", width: 0 });
  }
  return cells;
}

/**
 * 들여쓰기 하드랩 URL 탐지용 줄 정보. 텍스트와 컬럼 맵을 프로덕션과 같은
 * `reconstructLine` 으로 만든다.
 */
export function makeIndentedLines(
  texts: string[],
  wrappedIndices: number[] = [],
): IndentedLineInfo[] {
  return texts.map((text, i) => ({
    ...reconstructLine(textCells(text)),
    isWrapped: wrappedIndices.includes(i),
    lineNumber: i + 1,
  }));
}
