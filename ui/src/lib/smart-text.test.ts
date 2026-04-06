import { describe, it, expect } from "vitest";
import {
  smartRemoveIndent,
  smartRemoveLineBreak,
  applySmartTextTransforms,
  transformPasteContent,
} from "./smart-text";

// ============================================================
// smartRemoveIndent
// ============================================================
describe("smartRemoveIndent", () => {
  it("removes common leading spaces from all lines", () => {
    const input = "  hello\n  world";
    expect(smartRemoveIndent(input)).toBe("hello\nworld");
  });

  it("removes common leading spaces preserving relative indent", () => {
    const input = "    line1\n      line2\n    line3";
    expect(smartRemoveIndent(input)).toBe("line1\n  line2\nline3");
  });

  it("handles tabs as indent", () => {
    const input = "\t\thello\n\t\tworld";
    expect(smartRemoveIndent(input)).toBe("hello\nworld");
  });

  it("does nothing when there is no common indent", () => {
    const input = "hello\n  world";
    expect(smartRemoveIndent(input)).toBe("hello\n  world");
  });

  it("returns single line unchanged if no indent", () => {
    expect(smartRemoveIndent("hello")).toBe("hello");
  });

  it("removes indent from single line", () => {
    expect(smartRemoveIndent("  hello")).toBe("hello");
  });

  it("skips blank lines when computing common indent", () => {
    const input = "  hello\n\n  world";
    expect(smartRemoveIndent(input)).toBe("hello\n\nworld");
  });

  it("returns empty string for empty input", () => {
    expect(smartRemoveIndent("")).toBe("");
  });

  it("handles all blank lines", () => {
    expect(smartRemoveIndent("\n\n")).toBe("\n\n");
  });

  it("handles mixed space and tab (treats as different chars)", () => {
    // When indent chars are mixed, common prefix stops at first difference
    const input = " \thello\n \tworld";
    expect(smartRemoveIndent(input)).toBe("hello\nworld");
  });

  it("preserves trailing newline", () => {
    const input = "  hello\n  world\n";
    expect(smartRemoveIndent(input)).toBe("hello\nworld\n");
  });
});

// ============================================================
// smartRemoveLineBreak
// ============================================================
describe("smartRemoveLineBreak", () => {
  it("joins URL split across lines", () => {
    const input = "https://example.com/path?foo=bar&ba\nz=qux";
    expect(smartRemoveLineBreak(input)).toBe("https://example.com/path?foo=bar&baz=qux");
  });

  it("joins URL split across multiple lines", () => {
    const input = "https://example.com/pa\nth?foo=bar&ba\nz=qux";
    expect(smartRemoveLineBreak(input)).toBe("https://example.com/path?foo=bar&baz=qux");
  });

  it("does not touch non-URL multi-line text", () => {
    const input = "hello\nworld\nfoo";
    expect(smartRemoveLineBreak(input)).toBe("hello\nworld\nfoo");
  });

  it("does not touch single line URL", () => {
    const input = "https://example.com/path";
    expect(smartRemoveLineBreak(input)).toBe("https://example.com/path");
  });

  it("handles the issue example: indented URL with linebreaks", () => {
    // After indent removal, the URL still has linebreaks that should be joined
    const input =
      "https://mcp.notion.com/authorize?response_type=code&client_id=nmy47PjpHdZy7dgr&code_challenge=1eVfRYoFxEoIOGh0CaAF30mz9UXYTgDXr7tXeGI-I2M&cod\ne_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A52516%2Fcallback&state=AHKfcaYPBT9Ndx-qH1TQKKbbBL7YaCg7tRJ2NeLROFE&resource=htt\nps%3A%2F%2Fmcp.notion.com%2Fmcp";
    const expected =
      "https://mcp.notion.com/authorize?response_type=code&client_id=nmy47PjpHdZy7dgr&code_challenge=1eVfRYoFxEoIOGh0CaAF30mz9UXYTgDXr7tXeGI-I2M&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A52516%2Fcallback&state=AHKfcaYPBT9Ndx-qH1TQKKbbBL7YaCg7tRJ2NeLROFE&resource=https%3A%2F%2Fmcp.notion.com%2Fmcp";
    expect(smartRemoveLineBreak(input)).toBe(expected);
  });

  it("returns empty string for empty input", () => {
    expect(smartRemoveLineBreak("")).toBe("");
  });

  it("handles URL with http:// scheme", () => {
    const input = "http://example.com/pa\nth";
    expect(smartRemoveLineBreak(input)).toBe("http://example.com/path");
  });

  it("does not join lines when text has mixed URL and non-URL content", () => {
    const input = "Check this:\nhttps://example.com/path";
    expect(smartRemoveLineBreak(input)).toBe("Check this:\nhttps://example.com/path");
  });

  it("joins URL that is the only content (all lines form one URL)", () => {
    const input = "https://example.com/very-long-\npath?query=value";
    expect(smartRemoveLineBreak(input)).toBe("https://example.com/very-long-path?query=value");
  });
});

// ============================================================
// applySmartTextTransforms (composition)
// ============================================================
describe("applySmartTextTransforms", () => {
  it("applies both indent removal and linebreak removal in order", () => {
    // The exact issue scenario: 2-space indented URL with linebreaks
    const input =
      "  https://mcp.notion.com/authorize?response_type=code&client_id=nmy47PjpHdZy7dgr&code_challenge=1eVfRYoFxEoIOGh0CaAF30mz9UXYTgDXr7tXeGI-I2M&cod\n  e_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A52516%2Fcallback&state=AHKfcaYPBT9Ndx-qH1TQKKbbBL7YaCg7tRJ2NeLROFE&resource=htt\n  ps%3A%2F%2Fmcp.notion.com%2Fmcp";
    const expected =
      "https://mcp.notion.com/authorize?response_type=code&client_id=nmy47PjpHdZy7dgr&code_challenge=1eVfRYoFxEoIOGh0CaAF30mz9UXYTgDXr7tXeGI-I2M&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A52516%2Fcallback&state=AHKfcaYPBT9Ndx-qH1TQKKbbBL7YaCg7tRJ2NeLROFE&resource=https%3A%2F%2Fmcp.notion.com%2Fmcp";
    expect(applySmartTextTransforms(input, { removeIndent: true, removeLineBreak: true })).toBe(
      expected,
    );
  });

  it("applies only indent removal when removeLineBreak is false", () => {
    const input = "  hello\n  world";
    expect(applySmartTextTransforms(input, { removeIndent: true, removeLineBreak: false })).toBe(
      "hello\nworld",
    );
  });

  it("applies only linebreak removal when removeIndent is false", () => {
    const input = "https://example.com/pa\nth";
    expect(applySmartTextTransforms(input, { removeIndent: false, removeLineBreak: true })).toBe(
      "https://example.com/path",
    );
  });

  it("applies nothing when both are false", () => {
    const input = "  hello\n  world";
    expect(
      applySmartTextTransforms(input, {
        removeIndent: false,
        removeLineBreak: false,
      }),
    ).toBe("  hello\n  world");
  });

  it("order matters: indent first, then linebreak", () => {
    // If linebreak ran first on indented text, indent spaces would be in the URL
    const input = "  https://example.com/pa\n  th";
    // indent removal: "https://example.com/pa\nth"
    // linebreak removal: "https://example.com/path"
    expect(applySmartTextTransforms(input, { removeIndent: true, removeLineBreak: true })).toBe(
      "https://example.com/path",
    );
  });

  it("normalizes CRLF to LF before processing", () => {
    const input = "  hello\r\n  world";
    expect(applySmartTextTransforms(input, { removeIndent: true, removeLineBreak: false })).toBe(
      "hello\nworld",
    );
  });

  it("normalizes CRLF in URL before joining lines", () => {
    const input = "https://example.com/pa\r\nth";
    expect(applySmartTextTransforms(input, { removeIndent: false, removeLineBreak: true })).toBe(
      "https://example.com/path",
    );
  });
});

// ============================================================
// transformPasteContent
// ============================================================
describe("transformPasteContent", () => {
  const opts = { removeIndent: true, removeLineBreak: true };

  it("applies transforms for text paste type", () => {
    const input = "  https://example.com/pa\n  th";
    expect(transformPasteContent(input, "text", opts)).toBe("https://example.com/path");
  });

  it("returns content unchanged for non-text paste type", () => {
    const input = "  some image data";
    expect(transformPasteContent(input, "image", opts)).toBe("  some image data");
  });
});
