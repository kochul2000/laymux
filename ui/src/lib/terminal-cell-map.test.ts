import { describe, it, expect } from "vitest";
import {
  findTokenCellRange,
  readCellRangeText,
  reconstructLine,
  readLineCells,
  type CellInfo,
} from "./terminal-cell-map";

/** ASCII 한 글자 = 1셀. */
function ascii(text: string): CellInfo[] {
  return [...text].map((c) => ({ chars: c, width: 1 }));
}

/** 와이드 한 글자 = 리드 셀(width 2) + 트레일 셀(width 0). */
function wide(char: string): CellInfo[] {
  return [
    { chars: char, width: 2 },
    { chars: "", width: 0 },
  ];
}

describe("reconstructLine", () => {
  it("ASCII 는 오프셋과 컬럼이 1:1", () => {
    const { text, columns, endColumns } = reconstructLine(ascii("abc"));
    expect(text).toBe("abc");
    expect(columns).toEqual([1, 2, 3]);
    expect(endColumns).toEqual([1, 2, 3]);
  });

  it("와이드 문자는 두 셀을 차지하고 끝 컬럼이 시작보다 1 크다", () => {
    // "한글" → 셀 1..4, 오프셋 0..1
    const { text, columns, endColumns } = reconstructLine([...wide("한"), ...wide("글")]);
    expect(text).toBe("한글");
    expect(columns).toEqual([1, 3]);
    expect(endColumns).toEqual([2, 4]);
  });

  it("와이드 문자 뒤의 ASCII 는 셀 컬럼이 밀린다", () => {
    const { text, columns, endColumns } = reconstructLine([...wide("한"), ...ascii("ab")]);
    expect(text).toBe("한ab");
    expect(columns).toEqual([1, 3, 4]);
    expect(endColumns).toEqual([2, 3, 4]);
  });

  it("서로게이트 페어(이모지)는 UTF-16 2칸이 같은 셀 범위를 가리킨다", () => {
    const { text, columns, endColumns } = reconstructLine([...wide("😀"), ...ascii("x")]);
    expect(text).toBe("😀x");
    // 오프셋 0,1 이 모두 셀 1~2, 그 뒤 x 는 셀 3
    expect(columns).toEqual([1, 1, 3]);
    expect(endColumns).toEqual([2, 2, 3]);
  });

  it("빈 셀은 공백 한 칸으로 채운다", () => {
    const { text, columns } = reconstructLine([{ chars: "", width: 1 }, ...ascii("a")]);
    expect(text).toBe(" a");
    expect(columns).toEqual([1, 2]);
  });
});

describe("readLineCells", () => {
  it("셀 객체 재사용에 대비해 chars/width 를 즉시 읽는다", () => {
    // xterm 은 getCell 이 같은 객체를 돌려줄 수 있다 — 값 스냅샷이어야 한다.
    const values = [
      { chars: "한", width: 2 },
      { chars: "", width: 0 },
      { chars: "a", width: 1 },
    ];
    const shared = { chars: "", width: 0 };
    const line = {
      length: values.length,
      getCell: (x: number) => {
        shared.chars = values[x].chars;
        shared.width = values[x].width;
        return { getChars: () => shared.chars, getWidth: () => shared.width };
      },
    };
    expect(readLineCells(line)).toEqual(values);
  });

  it("셀이 없으면 공백 1칸으로 채운다", () => {
    const line = { length: 2, getCell: () => undefined };
    expect(readLineCells(line)).toEqual([
      { chars: " ", width: 1 },
      { chars: " ", width: 1 },
    ]);
  });
});

// -- ADR-0224 액션 칩의 원문 캡처/재검사 --

describe("readCellRangeText", () => {
  it("셀 범위(끝 포함) 안의 문자만 읽는다", () => {
    const cells = ascii("abcdef");
    expect(readCellRangeText(cells, 2, 4)).toBe("bcd");
    expect(readCellRangeText(cells, 1, 6)).toBe("abcdef");
  });

  it("와이드 문자는 두 셀을 모두 덮어야 포함된다", () => {
    // "a한b" → a(1) 한(2~3) b(4)
    const cells = [...ascii("a"), ...wide("한"), ...ascii("b")];
    expect(readCellRangeText(cells, 1, 4)).toBe("a한b");
    expect(readCellRangeText(cells, 2, 3)).toBe("한");
    // 뒷셀이 범위 밖이면 그 글자는 빠진다 — 절반만 캡처된 범위를 원문으로
    // 인정하지 않는다.
    expect(readCellRangeText(cells, 2, 2)).toBe("");
  });

  it("범위 밖이면 빈 문자열", () => {
    expect(readCellRangeText(ascii("abc"), 10, 20)).toBe("");
  });
});

describe("findTokenCellRange", () => {
  it("클릭 지점을 덮는 출현의 셀 범위를 돌려준다", () => {
    const cells = ascii("see https://a.io and https://a.io end");
    // 첫 출현: offset 4..15 → 셀 5..16
    expect(findTokenCellRange(cells, "https://a.io", 6)).toEqual({ startCol: 5, endCol: 16 });
    // 두 번째 출현: offset 21..32 → 셀 22..33
    expect(findTokenCellRange(cells, "https://a.io", 25)).toEqual({ startCol: 22, endCol: 33 });
  });

  it("어떤 출현도 덮지 않으면 null", () => {
    const cells = ascii("see https://a.io end");
    expect(findTokenCellRange(cells, "https://a.io", 2)).toBeNull();
    expect(findTokenCellRange(cells, "https://b.io", 6)).toBeNull();
    expect(findTokenCellRange(cells, "", 6)).toBeNull();
  });

  it("와이드 문자가 앞서면 셀 컬럼으로 보정한다", () => {
    // "한 http://a.io" → 한(1~2) 공백(3) URL(4~14)
    const cells = [...wide("한"), ...ascii(" http://a.io")];
    expect(findTokenCellRange(cells, "http://a.io", 5)).toEqual({ startCol: 4, endCol: 14 });
  });
});
