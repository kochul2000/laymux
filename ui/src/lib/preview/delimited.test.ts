import { describe, expect, it } from "vitest";
import { detectDelimiter, parseDelimited } from "./delimited";

describe("parseDelimited", () => {
  it("returns an empty result for empty input", () => {
    expect(parseDelimited("", ",")).toEqual({
      rows: [],
      columnCount: 0,
      truncated: false,
      totalRows: 0,
    });
  });

  it("unwraps quoted fields and collapses doubled quotes", () => {
    const result = parseDelimited('plain,"quoted","say ""hi""",""', ",");

    expect(result.rows).toEqual([["plain", "quoted", 'say "hi"', ""]]);
    expect(result.columnCount).toBe(4);
  });

  it("keeps delimiters, CR, and LF inside a quoted field as content", () => {
    const result = parseDelimited('x,"a,b\r\nc\nd",y', ",");

    expect(result.rows).toEqual([["x", "a,b\r\nc\nd", "y"]]);
    expect(result.totalRows).toBe(1);
  });

  it("accepts CRLF and bare LF row endings mixed in one file", () => {
    const result = parseDelimited("a,b\r\nc,d\ne,f", ",");

    expect(result.rows).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
    ]);
  });

  it("does not emit a final empty row for a trailing newline", () => {
    expect(parseDelimited("a,b\n", ",").rows).toEqual([["a", "b"]]);
    expect(parseDelimited("a,b\r\n", ",").rows).toEqual([["a", "b"]]);
    expect(parseDelimited("a,b\n", ",").totalRows).toBe(1);
  });

  it("keeps a trailing line whose fields are all empty", () => {
    const result = parseDelimited("a,b,c\n,,", ",");

    expect(result.rows).toEqual([
      ["a", "b", "c"],
      ["", "", ""],
    ]);
    expect(result.totalRows).toBe(2);
  });

  it("treats a stray quote inside an unquoted field as literal text", () => {
    const result = parseDelimited('a"b,5" tall,c', ",");

    expect(result.rows).toEqual([['a"b', '5" tall', "c"]]);
  });

  it("gives an unterminated quoted field the rest of the file", () => {
    const result = parseDelimited('a,"unclosed,b\nstill inside', ",");

    expect(result.rows).toEqual([["a", "unclosed,b\nstill inside"]]);
    expect(result.totalRows).toBe(1);
  });

  it("strips a leading UTF-8 BOM from the first field", () => {
    const result = parseDelimited("\uFEFFname,age\nkim,7", ",");

    expect(result.rows[0][0]).toBe("name");
    expect(result.rows).toEqual([
      ["name", "age"],
      ["kim", "7"],
    ]);
  });

  it("keeps ragged rows and reports the widest column count", () => {
    const result = parseDelimited("a,b,c\nd\ne,f", ",");

    expect(result.rows).toEqual([["a", "b", "c"], ["d"], ["e", "f"]]);
    expect(result.columnCount).toBe(3);
  });

  it("splits on a tab delimiter", () => {
    const result = parseDelimited("a\tb\nc\td", "\t");

    expect(result.rows).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("caps rows at maxRows while still reporting the source total", () => {
    const text = "1\n2\n3\n4\n5";

    expect(parseDelimited(text, ",")).toMatchObject({ truncated: false, totalRows: 5 });
    expect(parseDelimited(text, ",", { maxRows: 2 })).toEqual({
      rows: [["1"], ["2"]],
      columnCount: 1,
      truncated: true,
      totalRows: 5,
    });
  });
});

describe("detectDelimiter", () => {
  it("maps tsv and tab extensions to a tab", () => {
    expect(detectDelimiter("/data/report.TSV", "a,b,c")).toBe("\t");
    expect(detectDelimiter("/data/report.tab", "a;b;c")).toBe("\t");
  });

  it("sniffs the most frequent candidate in the first non-empty line", () => {
    expect(detectDelimiter("/data/x.csv", "\n\na;b;c;d\n1;2;3;4")).toBe(";");
    expect(detectDelimiter("/data/x.txt", "a|b|c\n1|2|3")).toBe("|");
    expect(detectDelimiter("/data/x.txt", "a\tb\tc")).toBe("\t");
    expect(detectDelimiter("/data/x.csv", "a,b,c")).toBe(",");
  });

  it("ignores candidates that appear inside quotes", () => {
    // Without quote awareness the three quoted semicolons would beat the two
    // real commas and pick the wrong separator.
    expect(detectDelimiter("/data/x.csv", '"a;b;c;d",e,f')).toBe(",");
  });

  it("falls back to a comma on a tie or when no candidate appears", () => {
    expect(detectDelimiter("/data/x.csv", "a;b|c")).toBe(",");
    expect(detectDelimiter("/data/x.csv", "single column")).toBe(",");
    expect(detectDelimiter("/data/x.csv", "")).toBe(",");
  });
});
