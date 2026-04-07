import { describe, it, expect, vi } from "vitest";
import {
  findIndentedUrls,
  createIndentedLinkProvider,
  type IndentedLineInfo,
} from "./indented-link-provider";
import { RAW_XTERM_SELECTION, CLEAN_URL } from "./__fixtures__/right-pane-fixture";

function makeLines(texts: string[], wrappedIndices: number[] = []): IndentedLineInfo[] {
  return texts.map((text, i) => ({
    text,
    isWrapped: wrappedIndices.includes(i),
    lineNumber: i + 1,
  }));
}

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

describe("createIndentedLinkProvider", () => {
  it("returns undefined when isEnabled returns false", () => {
    const mockTerminal = {
      buffer: {
        active: {
          length: 2,
          getLine: (y: number) => ({
            translateToString: () => ["  https://example.com/long-pa", "  ram=value"][y] ?? "",
            isWrapped: false,
          }),
        },
      },
    };

    const provider = createIndentedLinkProvider(mockTerminal as never, vi.fn(), () => false);

    const callback = vi.fn();
    provider.provideLinks(1, callback);
    expect(callback).toHaveBeenCalledWith(undefined);
  });
});
