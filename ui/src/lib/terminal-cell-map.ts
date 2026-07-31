/**
 * 터미널 버퍼 라인의 **문자열 오프셋 ↔ 셀 컬럼** 매핑 (issue #441, #691).
 *
 * xterm 의 링크·데코레이션 좌표는 전부 *셀* 단위인데, 정규식·`indexOf` 로 찾은
 * 토큰 위치는 UTF-16 오프셋이다. 한글/CJK/전각 문자는 셀 2칸을 차지하면서
 * UTF-16 으로는 1칸이고, 이모지는 반대로 UTF-16 2칸(서로게이트 페어)이므로
 * 둘은 와이드 문자가 끼는 순간 어긋난다. 문자열과 컬럼 맵을 한 번에 만들어
 * 두 좌표계가 갈라지지 않게 한다.
 *
 * `pr-link-provider`(`#123` 링크)와 `path-link-detect`(경로 밑줄)가 공유한다.
 */

/**
 * Minimal xterm cell shape needed for offset→column mapping (subset of
 * `IBufferCell`): `chars` = `getCell().getChars()`, `width` =
 * `getCell().getWidth()` (0 = trailing half of a wide char, 1 = normal,
 * 2 = leading half of a wide char).
 */
export interface CellInfo {
  chars: string;
  width: number;
}

/** `reconstructLine` 결과 — 라인 문자열과 두 방향의 컬럼 맵. */
export interface ReconstructedLine {
  text: string;
  /** `columns[o]` = 오프셋 `o` 문자가 **시작**하는 1-based 셀 컬럼. */
  columns: number[];
  /**
   * `endColumns[o]` = 오프셋 `o` 문자가 **끝나는**(포함) 1-based 셀 컬럼.
   * 와이드 문자는 시작 컬럼보다 1 크다 — 밑줄이 뒷칸까지 덮으려면 이 값이
   * 필요하다(#691: 한글 경로 밑줄이 절반만 그어지던 원인).
   */
  endColumns: number[];
}

/**
 * Reconstruct a terminal line's string together with UTF-16-offset →
 * 1-based-cell-column maps from its cells.
 *
 * Empty/unset cells emit a single space (matching `translateToString`), and
 * width-0 trailing cells are skipped (their char lives in the lead cell).
 */
export function reconstructLine(cells: CellInfo[]): ReconstructedLine {
  let text = "";
  const columns: number[] = [];
  const endColumns: number[] = [];
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (cell.width === 0) continue; // trailing half of a wide char — not emitted
    const emitted = cell.chars.length > 0 ? cell.chars : " ";
    // width 0 은 위에서 걸렀고, 알 수 없는 값은 1칸으로 본다.
    const span = cell.width >= 2 ? cell.width : 1;
    text += emitted;
    for (let k = 0; k < emitted.length; k++) {
      columns.push(i + 1); // 1-based 시작 컬럼
      endColumns.push(i + span); // 1-based 끝 컬럼(포함)
    }
  }
  return { text, columns, endColumns };
}

/** xterm `IBufferLine` 에서 필요한 부분만. */
export interface BufferLineLike {
  length: number;
  getCell: (x: number) => { getChars: () => string; getWidth: () => number } | undefined;
}

/** 버퍼 라인의 셀을 `CellInfo[]` 로 읽는다. 빈 셀은 공백 1칸으로 채운다. */
export function readLineCells(line: BufferLineLike): CellInfo[] {
  const cells: CellInfo[] = [];
  for (let i = 0; i < line.length; i++) {
    const cell = line.getCell(i);
    if (!cell) {
      cells.push({ chars: " ", width: 1 });
      continue;
    }
    cells.push({ chars: cell.getChars(), width: cell.getWidth() });
  }
  return cells;
}
