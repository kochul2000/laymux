import { describe, it, expect } from "vitest";
import { captureUrlChipRange, liveChipBufferLine } from "./link-chip-capture";
import type { CellInfo } from "./terminal-cell-map";

/** ASCII 한 글자 = 1셀. */
function ascii(text: string): CellInfo[] {
  return [...text].map((c) => ({ chars: c, width: 1 }));
}

/** 1-based 버퍼 라인 → 줄 텍스트 맵으로 readCells 를 만든다. */
function reader(lines: Record<number, string>) {
  return (bufferLine: number) => {
    const text = lines[bufferLine];
    return text === undefined ? null : ascii(text);
  };
}

describe("liveChipBufferLine — 마커가 라인의 정본", () => {
  it("마커가 살아 있으면 마커의 현재 라인을 쓴다", () => {
    // scrollback trim 으로 캡처한 12행이 5행으로 밀려 내려온 상태.
    expect(liveChipBufferLine({ bufferLine: 12, marker: { line: 4 } })).toBe(5);
  });

  it("마커가 폐기됐으면 캡처 번호로 되돌아가지 않고 fail closed", () => {
    // xterm 이 좌표를 무효화한 것이므로(전체 화면 지움 등) 칩도 죽어야 한다 —
    // 동결된 번호로 계속 읽으면 엉뚱한 줄을 대상으로 삼는다.
    expect(
      liveChipBufferLine({ bufferLine: 12, marker: { line: 4, isDisposed: true } }),
    ).toBeNull();
    expect(liveChipBufferLine({ bufferLine: 12, marker: { line: NaN } })).toBeNull();
  });

  it("마커가 아예 없으면 캡처한 번호를 쓴다", () => {
    expect(liveChipBufferLine({ bufferLine: 12 })).toBe(12);
    expect(liveChipBufferLine({ bufferLine: 0 })).toBeNull();
  });
});

describe("captureUrlChipRange — 범위가 있을 때", () => {
  const readCells = reader({ 7: "see https://a.io end" });

  it("한 줄 링크는 범위를 그대로 캡처한다", () => {
    const capture = captureUrlChipRange({
      uri: "https://a.io",
      cols: 80,
      clicked: { bufferLine: 7, col: 6 },
      range: { start: { x: 5, y: 7 }, end: { x: 16, y: 7 } },
      readCells,
    });
    expect(capture).toEqual({ bufferLine: 7, startCol: 5, endCol: 16, token: "https://a.io" });
  });

  it("여러 줄 링크는 클릭한 줄의 구간만 캡처한다", () => {
    const multi = reader({ 7: "start https://a.io/x", 8: "yz done" });
    const range = { start: { x: 7, y: 7 }, end: { x: 2, y: 8 } };

    const first = captureUrlChipRange({
      uri: "https://a.io/xyz",
      cols: 20,
      clicked: { bufferLine: 7, col: 9 },
      range,
      readCells: multi,
    });
    expect(first).toEqual({ bufferLine: 7, startCol: 7, endCol: 20, token: "https://a.io/x" });

    const second = captureUrlChipRange({
      uri: "https://a.io/xyz",
      cols: 20,
      clicked: { bufferLine: 8, col: 1 },
      range,
      readCells: multi,
    });
    expect(second).toEqual({ bufferLine: 8, startCol: 1, endCol: 2, token: "yz" });
  });

  it("클릭 좌표가 없으면 범위의 시작 줄을 쓴다", () => {
    const capture = captureUrlChipRange({
      uri: "https://a.io",
      cols: 80,
      range: { start: { x: 5, y: 7 }, end: { x: 16, y: 7 } },
      readCells,
    });
    expect(capture?.bufferLine).toBe(7);
    expect(capture?.token).toBe("https://a.io");
  });
});

describe("captureUrlChipRange — 범위가 없을 때(WebLinksAddon)", () => {
  it("클릭한 줄에서 URL 을 되찾아 셀 범위를 만든다", () => {
    const capture = captureUrlChipRange({
      uri: "https://a.io",
      cols: 80,
      clicked: { bufferLine: 7, col: 6 },
      readCells: reader({ 7: "see https://a.io end" }),
    });
    expect(capture).toEqual({ bufferLine: 7, startCol: 5, endCol: 16, token: "https://a.io" });
  });

  it("되찾지 못하면 한 글자 캡처를 만들지 않고 null 을 돌려준다", () => {
    // 화면 원문과 uri 가 다른 경우(줄바꿈 결합 등). 클릭 셀 한 칸만 캡처하면
    // 그 한 글자가 아무 줄에서나 우연히 일치해 재검사를 통과한다.
    const capture = captureUrlChipRange({
      uri: "https://a.io/very/long/joined",
      cols: 80,
      clicked: { bufferLine: 7, col: 6 },
      readCells: reader({ 7: "see https://a.io/very end" }),
    });
    expect(capture).toBeNull();
  });

  it("클릭 좌표도 범위도 없으면 null", () => {
    expect(
      captureUrlChipRange({
        uri: "https://a.io",
        cols: 80,
        readCells: reader({ 7: "see https://a.io end" }),
      }),
    ).toBeNull();
  });
});

describe("captureUrlChipRange — 읽을 수 없는 자리", () => {
  it("라인을 못 읽으면 null", () => {
    expect(
      captureUrlChipRange({
        uri: "https://a.io",
        cols: 80,
        range: { start: { x: 1, y: 99 }, end: { x: 12, y: 99 } },
        readCells: reader({ 7: "see https://a.io end" }),
      }),
    ).toBeNull();
  });

  it("빈 범위(원문 없음)는 null — 무엇과도 비교할 수 없는 캡처는 만들지 않는다", () => {
    expect(
      captureUrlChipRange({
        uri: "https://a.io",
        cols: 80,
        range: { start: { x: 30, y: 7 }, end: { x: 40, y: 7 } },
        readCells: reader({ 7: "short" }),
      }),
    ).toBeNull();
  });
});
