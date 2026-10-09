import { describe, it, expect, vi } from "vitest";
import { findIndentedUrls, createIndentedLinkProvider } from "./indented-link-provider";
import { RAW_XTERM_SELECTION, CLEAN_URL } from "./__fixtures__/right-pane-fixture";
import { makeIndentedLines as makeLines, makePaddedLines, textCells } from "@/test/cell-lines";
import { CAPTURE_COLS, CLAUDE, CODEX } from "./__fixtures__/tui-wrap-capture";

describe("findIndentedUrls — dev 실측(88 cols)", () => {
  const urlsAt = (rows: Parameters<typeof makePaddedLines>[0], queried: number) =>
    findIndentedUrls(makePaddedLines(rows, CAPTURE_COLS), queried).map((m) => m.text);

  it("Claude 목록: 마커 뒤 4칸 내어쓰기로 이어진 URL 을 한 링크로 잇는다", () => {
    const full =
      "https://github.com/kochul2000/laymux/blob/main/docs/architecture/data-flow.md#terminal-view-osc-pipeline-and-renderer-reflow-details";
    expect(urlsAt(CLAUDE.list, 1)).toEqual([full]);
    expect(urlsAt(CLAUDE.list, 2)).toEqual([full]);
    // 다음 항목의 URL 은 한 행 안에 있으므로 WebLinksAddon 몫이다.
    expect(urlsAt(CLAUDE.list, 3)).toEqual([]);
  });

  it("Claude: 행 끝에서 잘린 URL 의 링크에 한글 조사를 넣지 않는다", () => {
    expect(urlsAt(CLAUDE.urlWithParticle, 1)).toEqual([
      "https://example.com/very/long/path/segment/that/should/wrap/across/the/terminal/width/because/it/is/really/long?query=value&another=thing",
    ]);
  });

  it("Codex 입력창 에코: URL 이 끝난 행 다음 산문의 첫 글자를 붙이지 않는다", () => {
    expect(urlsAt(CODEX.promptEchoUrl, 2)).toEqual([
      "https://github.com/kochul2000/laymux/blob/main/docs/architecture/data-flow.md#terminal-view-osc-pipeline-and-renderer-reflow-details",
    ]);
  });

  it("URL 로 끝난 짧은 행 다음 같은 들여쓰기 산문은 잇지 않는다", () => {
    const rows = ["  자세한 내용: https://github.com/a/b/pull/12", "  를 참고하세요."];
    expect(urlsAt(rows, 1)).toEqual([]);
    expect(urlsAt(["  See https://github.com/a/b/pull/12", "  for details."], 1)).toEqual([]);
  });

  it("Codex soft-wrap URL 은 WebLinksAddon 몫으로 남긴다", () => {
    expect(urlsAt(CODEX.urlSoftWrapped, 2)).toEqual([]);
  });
});

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
    // 이 헬퍼는 탭을 1셀로 본다. 실제 xterm 버퍼에는 탭 문자가 남지 않고
    // 다음 탭 스톱까지 빈 셀로 채워지므로, 진짜 컬럼은 화면 테스트가 잰다.
    expect(result[0].range.start).toEqual({ x: 2, y: 1 });
    expect(result[0].range.end).toEqual({ x: 22, y: 2 });
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

  it("URL 은 바로 붙은 와이드 문자(조사) 앞에서 끝난다", () => {
    const range = rangeOf(["  https://example.com/pathpath", "  /docs에서 보기"]);
    expect(range.start).toEqual({ x: 3, y: 1 });
    // 둘째 줄: /(3) d(4) o(5) c(6) s(7) 에(8-9) — URL 은 셀 7 에서 끝난다
    expect(range.end).toEqual({ x: 7, y: 2 });
  });

  it("와이드 문자 뒤 둘째 줄 URL 꼬리도 셀 컬럼이 맞는다", () => {
    const range = rangeOf(["  문서 https://example.com/path?q=1&f", "  oo=bar"]);
    // 문(3-4) 서(5-6) 공백(7) → URL 은 셀 8 에서 시작, 둘째 줄 'r' 은 셀 8
    expect(range.start).toEqual({ x: 8, y: 1 });
    expect(range.end).toEqual({ x: 8, y: 2 });
  });

  it("URL 뒤 이모지(서로게이트 페어)는 링크에 들지 않는다", () => {
    const range = rangeOf(["  https://example.com/pathpath", "  /x😀"]);
    // 둘째 줄: /(3) x(4) 😀(5-6)
    expect(range.end).toEqual({ x: 4, y: 2 });
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
    // 첫 줄은 오른쪽 여백 2칸(줄바꿈 폭 cols-2)까지 찬 TUI 행이다.
    const range = rangeOf([
      "  https://example.com/path?q=1&foo=ba".padEnd(39, " "),
      "  r&baz=qux&end=true".padEnd(39, " "),
    ]);
    expect(range.start).toEqual({ x: 3, y: 1 });
    expect(range.end).toEqual({ x: 20, y: 2 });
  });

  it("soft-wrap 된 URL 줄 다음 행의 단어를 URL 에 붙이지 않는다", () => {
    // `  u: https://…` 가 soft-wrap 되고 꼬리 행이 끝 칸까지 찼다. 다음 키는
    // 같은 들여쓰기지만 URL 의 연속이 아니다 — 한 논리 줄 URL 은 WebLinksAddon 몫.
    const lines = makePaddedLines(
      [
        "  u: https://example.com/" + "a".repeat(15),
        { text: "b".repeat(40), wrapped: true },
        "  name: foo",
      ],
      40,
    );
    expect(findIndentedUrls(lines, 3)).toEqual([]);
  });

  it("다음 행이 새 URL 로 시작하면 두 URL 을 한 링크로 합치지 않는다", () => {
    const lines = makePaddedLines(
      ["  https://example.com/" + "a".repeat(17), "  https://example.com/b"],
      40,
    );
    expect(findIndentedUrls(lines, 1)).toEqual([]);
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

    // ADR-0224: 액션 칩을 띄우려면 활성화 이벤트와 버퍼 범위가 함께 필요하다.
    links[0].activate();
    expect(onClick).toHaveBeenCalledWith(links[0].text, undefined, links[0].range);
  });
});
