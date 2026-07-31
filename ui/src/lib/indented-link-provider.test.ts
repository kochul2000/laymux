import { describe, it, expect, vi } from "vitest";
import { findIndentedUrls, createIndentedLinkProvider } from "./indented-link-provider";
import { RAW_XTERM_SELECTION, CLEAN_URL } from "./__fixtures__/right-pane-fixture";
import { makeIndentedLines as makeLines, textCells } from "@/test/cell-lines";

describe("findIndentedUrls", () => {
  it("detects Claude Code OAuth URL split across indented lines", () => {
    const lines = makeLines([
      "  https://claude.com/authorize?client_id=abc&redirect_uri",
      "  =https%3A%2F%2Fplatform.claude.com%2Fcallback&scope=org",
      "  %3Acreate_api_key&code_challenge=M_9abywp&state=zbsbfs",
    ]);
    const result = findIndentedUrls(lines, 1);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe(
      "https://claude.com/authorize?client_id=abc&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Fcallback&scope=org%3Acreate_api_key&code_challenge=M_9abywp&state=zbsbfs",
    );
  });

  it("returns matches when queried from a continuation line", () => {
    const lines = makeLines([
      "  https://example.com/very-long-path?q=1&foo=ba",
      "  r&baz=qux&end=true",
    ]);
    // Query from line 2 (continuation)
    const result = findIndentedUrls(lines, 2);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("https://example.com/very-long-path?q=1&foo=bar&baz=qux&end=true");
  });

  it("ignores single-line URLs (WebLinksAddon handles those)", () => {
    const lines = makeLines(["  https://example.com/short"]);
    const result = findIndentedUrls(lines, 1);
    expect(result).toHaveLength(0);
  });

  it("stops at a line with different indent", () => {
    const lines = makeLines([
      "  https://example.com/path?q=1&foo=ba",
      "  r&baz=qux",
      "    different indent line",
    ]);
    const result = findIndentedUrls(lines, 1);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("https://example.com/path?q=1&foo=bar&baz=qux");
  });

  it("stops at a line starting with a new URL", () => {
    const lines = makeLines([
      "  https://first.com/path?long-param=va",
      "  lue&more=data",
      "  https://second.com/other",
    ]);
    const result = findIndentedUrls(lines, 1);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("https://first.com/path?long-param=value&more=data");
  });

  it("ignores soft-wrapped lines (handled by WebLinksAddon)", () => {
    const lines = makeLines(
      ["  https://example.com/very-long", "  -path?q=1"],
      [1], // line 2 is soft-wrapped
    );
    const result = findIndentedUrls(lines, 1);
    expect(result).toHaveLength(0);
  });

  it("handles text before the URL on the first line", () => {
    const lines = makeLines(["  Visit https://example.com/path?q=1&f", "  oo=bar&baz=qux"]);
    const result = findIndentedUrls(lines, 1);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("https://example.com/path?q=1&foo=bar&baz=qux");
  });

  it("handles zero-indent URLs", () => {
    const lines = makeLines(["https://example.com/path?very-long-par", "am=value&another=data"]);
    const result = findIndentedUrls(lines, 1);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("https://example.com/path?very-long-param=value&another=data");
  });

  it("returns empty for non-URL lines", () => {
    const lines = makeLines(["  some regular text here", "  more regular text"]);
    const result = findIndentedUrls(lines, 1);
    expect(result).toHaveLength(0);
  });

  it("does not match when queried line is outside the URL group", () => {
    const lines = makeLines([
      "  some text",
      "  https://example.com/path?very-long-pa",
      "  ram=value",
      "  other text",
    ]);
    const result = findIndentedUrls(lines, 1);
    expect(result).toHaveLength(0);
  });

  it("stops at an empty line", () => {
    const lines = makeLines(["  https://example.com/path?very-long-pa", "", "  ram=value"]);
    const result = findIndentedUrls(lines, 1);
    expect(result).toHaveLength(0); // single line → ignored
  });

  it("handles tab indentation", () => {
    const lines = makeLines([
      "\thttps://example.com/path?very-long-par",
      "\tam=value&another=data",
    ]);
    const result = findIndentedUrls(lines, 1);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("https://example.com/path?very-long-param=value&another=data");
  });

  it("handles http:// scheme across indented lines", () => {
    const lines = makeLines(["  http://example.com/very-long-path?par", "  am=value&end=true"]);
    const result = findIndentedUrls(lines, 1);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("http://example.com/very-long-path?param=value&end=true");
  });

  it("strips trailing URL delimiters (parentheses, quotes)", () => {
    // URL followed by closing paren on the last continuation line
    const lines = makeLines(["  (https://example.com/path?very-long-p", '  aram=value)"']);
    const result = findIndentedUrls(lines, 1);
    expect(result).toHaveLength(1);
    // URL regex stops before ) and "
    expect(result[0].text).toBe("https://example.com/path?very-long-param=value");
  });

  it("real-world Claude Code OAuth URL (4+ lines)", () => {
    const lines = makeLines([
      "  https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri",
      "  =https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3A",
      "  sessions%3Aclaude_code+user%3Amcp_servers+user%3Afile_upload&code_challenge=M_9abywp-1WkuoWIZtP5ZOosVWRTuM05vLxN6s6Xbe8&code_ch",
      "  allenge_method=S256&state=zbsbfsAvsyT1epOdDbFrGPwWr6N7YYtQ2VHdy7b8D8I",
    ]);
    const result = findIndentedUrls(lines, 2);
    expect(result).toHaveLength(1);
    expect(result[0].text).toContain("claude.com/cai/oauth/authorize");
    expect(result[0].text).toContain("code_challenge_method=S256");
    expect(result[0].text).toContain("state=zbsbfsAvsyT1epOdDbFrGPwWr6N7YYtQ2VHdy7b8D8I");
    // Should be one continuous URL with no spaces
    expect(result[0].text).not.toContain(" ");
  });

  it("handles URL ending mid-line with trailing text on last line", () => {
    const lines = makeLines(["  https://example.com/path?very-long-pa", "  ram=value to continue"]);
    const result = findIndentedUrls(lines, 1);
    expect(result).toHaveLength(1);
    // URL stops at the space before "to"
    expect(result[0].text).toBe("https://example.com/path?very-long-param=value");
  });
});

// ============================================================
// Real terminal buffer: Claude Code OAuth URL (75-col padded lines)
// ============================================================
describe("findIndentedUrls — right-pane fixture (terminal-padded lines)", () => {
  const PADDED_LINES = makeLines(RAW_XTERM_SELECTION.split("\n"));

  it("trailing space가 있어도 전체 URL을 감지", () => {
    const result = findIndentedUrls(PADDED_LINES, 1);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe(CLEAN_URL);
  });

  it("continuation line에서 쿼리해도 전체 URL 반환", () => {
    const result = findIndentedUrls(PADDED_LINES, 4);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe(CLEAN_URL);
  });
});

// ============================================================
// 셀 좌표 (issue #696)
// ============================================================
describe("findIndentedUrls — 셀 좌표", () => {
  /** 결합 URL 하나를 찾아 그 range 를 돌려준다. */
  function rangeOf(texts: string[], queriedLine = 1) {
    const result = findIndentedUrls(makeLines(texts), queriedLine);
    expect(result).toHaveLength(1);
    return result[0].range;
  }

  it("ASCII 는 문자열 오프셋과 셀 컬럼이 일치한다", () => {
    const range = rangeOf(["  https://example.com/path?q=1&foo=ba", "  r&baz=qux&end=true"]);
    expect(range.start).toEqual({ x: 3, y: 1 });
    // 마지막 문자 'e' 는 둘째 줄 20번째 셀
    expect(range.end).toEqual({ x: 20, y: 2 });
  });

  it("앞선 한글이 시작 컬럼을 밀어낸다", () => {
    // "메모 " 는 문자 3개지만 셀 5칸 — 오프셋으로 계산하면 밑줄이 2칸 왼쪽으로 샌다.
    const range = rangeOf(["  메모 https://example.com/path?q=1&foo=ba", "  r&baz=qux&end=true"]);
    expect(range.start).toEqual({ x: 8, y: 1 });
    expect(range.end).toEqual({ x: 20, y: 2 });
  });

  it("URL 안의 와이드 문자만큼 끝 컬럼이 밀린다", () => {
    const range = rangeOf(["  https://example.com/문서와", "  보고서?q=1"]);
    expect(range.start).toEqual({ x: 3, y: 1 });
    // 둘째 줄: 보(3-4) 고(5-6) 서(7-8) ?(9) q(10) =(11) 1(12)
    expect(range.end).toEqual({ x: 12, y: 2 });
  });

  it("와이드 문자로 끝나면 끝 컬럼이 뒷칸까지 덮는다", () => {
    const range = rangeOf(["  https://example.com/pathpath", "  /문서"]);
    // 둘째 줄: /(3) 문(4-5) 서(6-7) → 끝 셀은 7 이어야 밑줄이 절반만 그이지 않는다
    expect(range.end).toEqual({ x: 7, y: 2 });
  });

  it("이모지(서로게이트 페어)로 끝나도 두 셀을 덮는다", () => {
    const range = rangeOf(["  https://example.com/pathpath", "  /x😀"]);
    // 둘째 줄: /(3) x(4) 😀(5-6)
    expect(range.end).toEqual({ x: 6, y: 2 });
  });

  it("앞선 이모지 뒤의 URL 도 셀 컬럼이 맞는다", () => {
    const range = rangeOf(["  😀 https://example.com/path?q=1&foo=ba", "  r&baz=qux&end=true"]);
    // 😀(3-4) 공백(5) → URL 은 셀 6 에서 시작
    expect(range.start).toEqual({ x: 6, y: 1 });
    expect(range.end).toEqual({ x: 20, y: 2 });
  });

  it("한글·이모지가 섞인 접두사에서도 어긋나지 않는다", () => {
    const range = rangeOf([
      "  🔗 열기 https://example.com/path?q=1&foo=ba",
      "  r&baz=qux&end=true",
    ]);
    // 🔗(3-4) 공백(5) 열(6-7) 기(8-9) 공백(10) → URL 은 셀 11
    expect(range.start).toEqual({ x: 11, y: 1 });
    expect(range.end).toEqual({ x: 20, y: 2 });
  });

  it("끝쪽 패딩 공백이 있는 실제 버퍼 줄에서도 행·컬럼이 맞는다", () => {
    // 버퍼 줄은 터미널 폭만큼 공백으로 채워져 있다. 패딩을 길이 계산에 넣으면
    // 결합 문자열의 오프셋이 첫 줄 안에 다 들어가 버려 끝점이 엉뚱한 행에 찍힌다.
    const range = rangeOf([
      "  https://example.com/path?q=1&foo=ba".padEnd(55, " "),
      "  r&baz=qux&end=true".padEnd(55, " "),
    ]);
    expect(range.start).toEqual({ x: 3, y: 1 });
    expect(range.end).toEqual({ x: 20, y: 2 });
  });
});

describe("createIndentedLinkProvider", () => {
  /** 셀 배열을 돌려주는 최소 xterm 버퍼 목. */
  function mockTerminal(texts: string[]) {
    const rows = texts.map((t) => textCells(t));
    return {
      buffer: {
        active: {
          length: rows.length,
          getLine: (y: number) => {
            const cells = rows[y];
            if (!cells) return undefined;
            return {
              length: cells.length,
              getCell: (x: number) => {
                const cell = cells[x];
                return cell
                  ? { getChars: () => cell.chars, getWidth: () => cell.width }
                  : undefined;
              },
              isWrapped: false,
            };
          },
        },
      },
    } as never;
  }

  it("returns undefined when isEnabled returns false", () => {
    const terminal = mockTerminal(["  https://example.com/long-pa", "  ram=value"]);
    const provider = createIndentedLinkProvider(terminal, vi.fn(), () => false);

    const callback = vi.fn();
    provider.provideLinks(1, callback);
    expect(callback).toHaveBeenCalledWith(undefined);
  });

  it("한글이 앞선 줄에서도 링크 range 가 실제 셀을 가리킨다", () => {
    const terminal = mockTerminal([
      "  메모 https://example.com/path?q=1&foo=ba",
      "  r&baz=qux&end=true",
    ]);
    const onClick = vi.fn();
    const provider = createIndentedLinkProvider(terminal, onClick);

    const callback = vi.fn();
    provider.provideLinks(1, callback);
    const links = callback.mock.calls[0][0];
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe("https://example.com/path?q=1&foo=bar&baz=qux&end=true");
    expect(links[0].range).toEqual({ start: { x: 8, y: 1 }, end: { x: 20, y: 2 } });

    links[0].activate();
    expect(onClick).toHaveBeenCalledWith(links[0].text);
  });
});
