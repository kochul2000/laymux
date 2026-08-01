import { describe, expect, it } from "vitest";
import { MAX_JSONL_RECORDS, parseJsonl, summarizeJsonlValue } from "./jsonl";

describe("parseJsonl", () => {
  it("parses every line on its own so one broken line costs only that line", () => {
    const result = parseJsonl(
      ['{"type":"user"}', '{"type":"assistant"', '{"type":"result","ok":true}'].join("\n"),
    );

    expect(result.records).toHaveLength(3);
    expect(result.totalRecords).toBe(3);
    expect(result.invalidCount).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.records[0].value).toEqual({ type: "user" });
    expect(result.records[0].error).toBeUndefined();
    expect(result.records[1].value).toBeUndefined();
    expect(result.records[1].error).toBeTruthy();
    expect(result.records[1].raw).toBe('{"type":"assistant"');
    expect(result.records[2].value).toEqual({ type: "result", ok: true });
  });

  it("numbers records by their source line", () => {
    const result = parseJsonl(['{"a":1}', "not json", '{"b":2}'].join("\n"));

    expect(result.records.map((record) => record.line)).toEqual([1, 2, 3]);
  });

  it("skips blank lines without shifting the line numbers", () => {
    const result = parseJsonl(['{"a":1}', "", "   ", '{"b":2}', "\t"].join("\n"));

    expect(result.records.map((record) => record.line)).toEqual([1, 4]);
    expect(result.totalRecords).toBe(2);
    expect(result.invalidCount).toBe(0);
  });

  it("handles CRLF line endings", () => {
    const result = parseJsonl('{"a":1}\r\n{"b":2}\r\n');

    expect(result.totalRecords).toBe(2);
    expect(result.invalidCount).toBe(0);
    expect(result.records[1].raw).toBe('{"b":2}');
    expect(result.records[1].value).toEqual({ b: 2 });
  });

  it("treats a missing final newline the same as a trailing one", () => {
    const withNewline = parseJsonl('{"a":1}\n{"b":2}\n');
    const withoutNewline = parseJsonl('{"a":1}\n{"b":2}');

    expect(withoutNewline).toEqual(withNewline);
    expect(withNewline.totalRecords).toBe(2);
  });

  it("returns an empty result for empty input", () => {
    expect(parseJsonl("")).toEqual({
      records: [],
      totalRecords: 0,
      truncated: false,
      invalidCount: 0,
    });
  });

  it("keeps null and other bare scalars as values", () => {
    const result = parseJsonl(["null", "42", '"text"', "true"].join("\n"));

    expect(result.invalidCount).toBe(0);
    expect(result.records.map((record) => record.value)).toEqual([null, 42, "text", true]);
  });

  it("caps records but still counts the whole file", () => {
    const result = parseJsonl(
      ['{"a":1}', "broken", '{"b":2}', "also broken {", '{"c":3}'].join("\n"),
      { maxRecords: 2 },
    );

    expect(result.records).toHaveLength(2);
    expect(result.records.map((record) => record.line)).toEqual([1, 2]);
    expect(result.truncated).toBe(true);
    expect(result.totalRecords).toBe(5);
    expect(result.invalidCount).toBe(2);
  });

  it("does not flag truncation when the file fits the cap exactly", () => {
    const result = parseJsonl(['{"a":1}', '{"b":2}'].join("\n"), { maxRecords: 2 });

    expect(result.truncated).toBe(false);
    expect(result.records).toHaveLength(2);
  });

  it("defaults the cap to MAX_JSONL_RECORDS", () => {
    const lines = Array.from({ length: MAX_JSONL_RECORDS + 5 }, (_, i) => `{"i":${i}}`);
    const result = parseJsonl(lines.join("\n"));

    expect(result.records).toHaveLength(MAX_JSONL_RECORDS);
    expect(result.totalRecords).toBe(MAX_JSONL_RECORDS + 5);
    expect(result.truncated).toBe(true);
  });
});

describe("summarizeJsonlValue", () => {
  it("renders each value shape compactly", () => {
    expect(summarizeJsonlValue({ a: 1, b: "x" })).toBe('{"a":1,"b":"x"}');
    expect(summarizeJsonlValue([1, 2, 3])).toBe("[1,2,3]");
    expect(summarizeJsonlValue("plain")).toBe('"plain"');
    expect(summarizeJsonlValue(42)).toBe("42");
    expect(summarizeJsonlValue(true)).toBe("true");
    expect(summarizeJsonlValue(null)).toBe("null");
  });

  it("keeps a multi-line string on a single line", () => {
    expect(summarizeJsonlValue("a\nb")).toBe('"a\\nb"');
  });

  it("truncates past maxLength with an ellipsis", () => {
    const long = summarizeJsonlValue({ text: "x".repeat(500) });

    expect(long).toHaveLength(200);
    expect(long.endsWith("…")).toBe(true);
    expect(long.startsWith('{"text":"xxx')).toBe(true);
  });

  it("honors a custom maxLength and leaves short values untouched", () => {
    expect(summarizeJsonlValue("abcdefghij", 6)).toBe('"abcd…');
    expect(summarizeJsonlValue("abc", 200)).toBe('"abc"');
  });

  it("does not throw on values JSON.parse could never produce", () => {
    expect(() => summarizeJsonlValue(undefined)).not.toThrow();
    expect(() => summarizeJsonlValue(10n)).not.toThrow();
    expect(summarizeJsonlValue(Infinity)).toBe("null");
  });
});
