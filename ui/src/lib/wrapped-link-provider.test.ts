import { describe, it, expect } from "vitest";
import { findUrlsInWrappedText, type WrappedLineInfo } from "./wrapped-link-provider";

/**
 * Helper: build WrappedLineInfo from simple strings.
 * Each string becomes one buffer line.  If `wrappedIndices` is provided,
 * those lines are marked as isWrapped (continuation of previous line).
 */
function makeLines(texts: string[], wrappedIndices: number[] = []): WrappedLineInfo[] {
  return texts.map((text, i) => ({
    text,
    isWrapped: wrappedIndices.includes(i),
    lineNumber: i + 1, // 1-based like xterm buffer
  }));
}

describe("findUrlsInWrappedText", () => {
  it("detects a simple URL on a single line", () => {
    const lines = makeLines(["Visit https://example.com/path for info"]);
    const result = findUrlsInWrappedText(lines, 1);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("https://example.com/path");
    expect(result[0].range.start).toEqual({ x: 7, y: 1 });
    expect(result[0].range.end).toEqual({ x: 30, y: 1 });
  });

  it("detects URL that wraps across two soft-wrapped lines", () => {
    // Line 1: starts URL, Line 2: continues (isWrapped=true)
    const lines = makeLines(
      ["Click https://example.com/very-long-pa", "th?query=value&foo=bar to continue"],
      [1], // line index 1 is wrapped
    );
    const result = findUrlsInWrappedText(lines, 1);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("https://example.com/very-long-path?query=value&foo=bar");
    // URL starts on line 1 at position 7
    expect(result[0].range.start).toEqual({ x: 7, y: 1 });
    // URL ends on line 2
    expect(result[0].range.end.y).toBe(2);
  });

  it("detects URL that wraps across three soft-wrapped lines", () => {
    const lines = makeLines(
      [
        "Go to https://mcp.notion.com/authorize",
        "?code_challenge=abc&code_challenge_met",
        "hod=S256&redirect_uri=http%3A%2F%2Ffoo",
      ],
      [1, 2],
    );
    const result = findUrlsInWrappedText(lines, 1);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe(
      "https://mcp.notion.com/authorize?code_challenge=abc&code_challenge_method=S256&redirect_uri=http%3A%2F%2Ffoo",
    );
    expect(result[0].range.start.y).toBe(1);
    expect(result[0].range.end.y).toBe(3);
  });

  it("does not detect URL on a hard-wrapped (non-wrapped) line below", () => {
    const lines = makeLines(
      [
        "https://example.com/first-pa",
        "https://example.com/second", // NOT wrapped — new line
      ],
      [], // no wrapping
    );
    const result = findUrlsInWrappedText(lines, 1);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("https://example.com/first-pa");
  });

  it("returns empty array when no URL present", () => {
    const lines = makeLines(["just some text without urls"]);
    const result = findUrlsInWrappedText(lines, 1);
    expect(result).toHaveLength(0);
  });

  it("detects multiple URLs on the same joined line", () => {
    const lines = makeLines(["See https://a.com and https://b.com/path"]);
    const result = findUrlsInWrappedText(lines, 1);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe("https://a.com");
    expect(result[1].text).toBe("https://b.com/path");
  });

  it("provides links for queried line from wrapped continuation", () => {
    // When queried for line 2 (which is wrapped), should still return the URL
    const lines = makeLines(["Go to https://example.com/very-long-pa", "th?query=value end"], [1]);
    const result = findUrlsInWrappedText(lines, 2);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("https://example.com/very-long-path?query=value");
  });

  it("handles http:// scheme", () => {
    const lines = makeLines(["Visit http://example.com/page"]);
    const result = findUrlsInWrappedText(lines, 1);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("http://example.com/page");
  });
});
