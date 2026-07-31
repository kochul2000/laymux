import { describe, it, expect } from "vitest";
import { reconstructLine, readLineCells, type CellInfo } from "./terminal-cell-map";

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
