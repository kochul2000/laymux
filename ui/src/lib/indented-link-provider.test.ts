import { describe, it, expect } from "vitest";
import { findIndentedUrls, type IndentedLineInfo } from "./indented-link-provider";

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
});
