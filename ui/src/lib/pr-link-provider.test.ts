import { describe, it, expect, vi } from "vitest";
import { findPrTokens, createPrLinkProvider } from "./pr-link-provider";
import type { CellInfo } from "./terminal-cell-map";

describe("findPrTokens", () => {
  it("detects a bare #number token", () => {
    const result = findPrTokens("see #123 for details");
    expect(result).toEqual([{ number: 123, startCol: 5, endCol: 8 }]);
  });

  it("detects a token at the start of the line", () => {
    const result = findPrTokens("#42 opened");
    expect(result).toEqual([{ number: 42, startCol: 1, endCol: 3 }]);
  });

  it("detects multiple tokens on one line", () => {
    const result = findPrTokens("#1 and #22 plus #333");
    expect(result).toEqual([
      { number: 1, startCol: 1, endCol: 2 },
      { number: 22, startCol: 8, endCol: 10 },
      { number: 333, startCol: 17, endCol: 20 },
    ]);
  });

  it("detects a token inside parentheses", () => {
    const result = findPrTokens("Fixes (#7).");
    expect(result).toEqual([{ number: 7, startCol: 8, endCol: 9 }]);
  });

  // -- false-positive avoidance --

  it("ignores a hex color like #fff", () => {
    expect(findPrTokens("color: #fff;")).toEqual([]);
  });

  it("ignores a hex color like #1a2b3c (letters mixed in)", () => {
    // #1a2b3c: digits followed by a letter — \b after digits fails, no clean token.
    expect(findPrTokens("#1a2b3c")).toEqual([]);
  });

  it("ignores a version anchor like v1.2#3 (word char before #)", () => {
    expect(findPrTokens("v1.2#3")).toEqual([]);
  });

  it("ignores #number glued to a preceding word (abc#12)", () => {
    expect(findPrTokens("abc#12")).toEqual([]);
  });

  it("ignores a lone hash with no digits", () => {
    expect(findPrTokens("# heading")).toEqual([]);
  });

  it("returns empty for text without any token", () => {
    expect(findPrTokens("nothing to see here")).toEqual([]);
  });

  it("handles a token after a hard-wrap padded line (trailing spaces)", () => {
    const result = findPrTokens("PR #99 merged            ");
    expect(result).toEqual([{ number: 99, startCol: 4, endCol: 6 }]);
  });
});

// ASCII helper: one cell per code unit, all width 1 (offset == column).
function asciiCells(text: string): CellInfo[] {
  return [...text].map((ch) => ({ chars: ch, width: 1 }));
}

describe("createPrLinkProvider", () => {
  function makeTerminalFromCells(cells: CellInfo[]) {
    return {
      buffer: {
        active: {
          length: 1,
          getLine: (_y: number) => ({
            length: cells.length,
            getCell: (x: number) =>
              cells[x]
                ? { getChars: () => cells[x].chars, getWidth: () => cells[x].width }
                : undefined,
          }),
        },
      },
    };
  }

  function makeTerminal(lineText: string) {
    return makeTerminalFromCells(asciiCells(lineText));
  }

  it("produces no links when getRepoBase returns null", () => {
    const terminal = makeTerminal("see #123");
    const onClick = vi.fn();
    const provider = createPrLinkProvider(terminal as never, onClick, () => null);

    const callback = vi.fn();
    provider.provideLinks(1, callback);
    expect(callback).toHaveBeenCalledWith(undefined);
  });

  it("produces a clickable link when repoBase is present", () => {
    const terminal = makeTerminal("see #123 now");
    const onClick = vi.fn();
    const provider = createPrLinkProvider(
      terminal as never,
      onClick,
      () => "https://github.com/owner/repo",
    );

    const callback = vi.fn();
    provider.provideLinks(1, callback);

    expect(callback).toHaveBeenCalledTimes(1);
    const links = callback.mock.calls[0][0];
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe("#123");
    // 1-based, inclusive coordinates on the queried buffer line.
    expect(links[0].range).toEqual({
      start: { x: 5, y: 1 },
      end: { x: 8, y: 1 },
    });

    // ADR-0224: 활성화 이벤트와 버퍼 범위도 함께 넘긴다 — 액션 칩이 뜰 자리와
    // 재검사할 셀 범위를 호출부가 알아야 한다.
    const event = { clientX: 1, clientY: 2 } as MouseEvent;
    links[0].activate(event);
    expect(onClick).toHaveBeenCalledWith(123, event, links[0].range);
  });

  it("returns undefined when the line has no token", () => {
    const terminal = makeTerminal("nothing here");
    const provider = createPrLinkProvider(
      terminal as never,
      vi.fn(),
      () => "https://github.com/owner/repo",
    );

    const callback = vi.fn();
    provider.provideLinks(1, callback);
    expect(callback).toHaveBeenCalledWith(undefined);
  });

  it("shifts link range past a preceding wide char (#441)", () => {
    // "가 #123": 가(width 2, cells 0+1), space(cell 2), #(cell 3)…
    const cells: CellInfo[] = [
      { chars: "가", width: 2 },
      { chars: "", width: 0 },
      { chars: " ", width: 1 },
      { chars: "#", width: 1 },
      { chars: "1", width: 1 },
      { chars: "2", width: 1 },
      { chars: "3", width: 1 },
    ];
    const terminal = makeTerminalFromCells(cells);
    const onClick = vi.fn();
    const provider = createPrLinkProvider(
      terminal as never,
      onClick,
      () => "https://github.com/owner/repo",
    );

    const callback = vi.fn();
    provider.provideLinks(1, callback);
    const links = callback.mock.calls[0][0];
    expect(links).toHaveLength(1);
    // `#` is on cell column 4 (not string offset 3), last digit on column 7.
    expect(links[0].range).toEqual({
      start: { x: 4, y: 1 },
      end: { x: 7, y: 1 },
    });
    links[0].activate();
    expect(onClick).toHaveBeenCalledWith(123, undefined, links[0].range);
  });
});
