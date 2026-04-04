import { describe, it, expect } from "vitest";
import { splitParagraphs, type Paragraph } from "./memo-paragraphs";

describe("splitParagraphs", () => {
  it("returns the entire text as one paragraph when no blank lines", () => {
    const result = splitParagraphs("abc\ndef\nghi", 2);
    expect(result).toEqual<Paragraph[]>([{ text: "abc\ndef\nghi", startLine: 0, endLine: 2 }]);
  });

  it("splits on 2+ consecutive blank lines when minBlankLines=2", () => {
    // "abc\n\n\ndef\n\nggg"
    // Lines: abc(0), ""(1), ""(2), def(3), ""(4), ggg(5)
    // 2 consecutive blanks at lines 1-2 => split
    // 1 blank at line 4 => no split
    const result = splitParagraphs("abc\n\n\ndef\n\nggg", 2);
    expect(result).toEqual<Paragraph[]>([
      { text: "abc", startLine: 0, endLine: 0 },
      { text: "def\n\nggg", startLine: 3, endLine: 5 },
    ]);
  });

  it("returns one paragraph when minBlankLines=3 and only 2 consecutive blanks exist", () => {
    const result = splitParagraphs("abc\n\n\ndef\n\nggg", 3);
    expect(result).toEqual<Paragraph[]>([
      { text: "abc\n\n\ndef\n\nggg", startLine: 0, endLine: 5 },
    ]);
  });

  it("handles empty text", () => {
    const result = splitParagraphs("", 2);
    expect(result).toEqual<Paragraph[]>([]);
  });

  it("handles text with only blank lines", () => {
    const result = splitParagraphs("\n\n\n", 2);
    // Lines: ""(0), ""(1), ""(2), ""(3)
    // All blank - should return empty paragraphs trimmed away or a single empty paragraph
    expect(result).toEqual<Paragraph[]>([]);
  });

  it("handles multiple paragraph splits", () => {
    const result = splitParagraphs("a\n\n\nb\n\n\nc", 2);
    expect(result).toEqual<Paragraph[]>([
      { text: "a", startLine: 0, endLine: 0 },
      { text: "b", startLine: 3, endLine: 3 },
      { text: "c", startLine: 6, endLine: 6 },
    ]);
  });

  it("handles minBlankLines=1", () => {
    const result = splitParagraphs("a\n\nb", 1);
    expect(result).toEqual<Paragraph[]>([
      { text: "a", startLine: 0, endLine: 0 },
      { text: "b", startLine: 2, endLine: 2 },
    ]);
  });

  it("trims leading/trailing blank lines from paragraphs", () => {
    const result = splitParagraphs("\n\n\nabc\n\n\n\ndef", 2);
    expect(result).toEqual<Paragraph[]>([
      { text: "abc", startLine: 3, endLine: 3 },
      { text: "def", startLine: 7, endLine: 7 },
    ]);
  });
});
