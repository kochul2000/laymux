import { describe, expect, it } from "vitest";
import { filePreviewKind, isDocumentPreviewKind, isSvgPath } from "./file-preview-kind";

describe("filePreviewKind", () => {
  it("keeps the document kinds the sandboxed iframe already handled", () => {
    expect(filePreviewKind("/tmp/report.HTML")).toBe("html");
    expect(filePreviewKind("/tmp/a.htm")).toBe("html");
    expect(filePreviewKind("/tmp/readme.md")).toBe("markdown");
    expect(filePreviewKind("/tmp/readme.markdown")).toBe("markdown");
  });

  it("routes each structured extension to its own renderer", () => {
    expect(filePreviewKind("/tmp/package.json")).toBe("json");
    expect(filePreviewKind("/tmp/tsconfig.jsonc")).toBe("json");
    expect(filePreviewKind("/tmp/session.jsonl")).toBe("jsonl");
    expect(filePreviewKind("/tmp/events.ndjson")).toBe("jsonl");
    expect(filePreviewKind("/tmp/fix.diff")).toBe("diff");
    expect(filePreviewKind("/tmp/fix.patch")).toBe("diff");
    expect(filePreviewKind("/tmp/rows.csv")).toBe("csv");
    expect(filePreviewKind("/tmp/rows.tsv")).toBe("csv");
    expect(filePreviewKind("/tmp/build.log")).toBe("log");
  });

  it("falls back to syntax highlighting for source files", () => {
    expect(filePreviewKind("/tmp/main.rs")).toBe("code");
    expect(filePreviewKind("/tmp/App.tsx")).toBe("code");
    expect(filePreviewKind("/tmp/script.PY")).toBe("code");
  });

  it("does not claim .json5, whose syntax the relaxed parser cannot read", () => {
    // Claiming it would mean reporting a valid JSON5 file as invalid JSON:
    // unquoted keys, single-quoted strings and `Infinity` are all beyond what
    // stripping comments and trailing commas can rescue.
    expect(filePreviewKind("/tmp/a.json5")).toBeNull();
  });

  it("returns null when nothing claims the file", () => {
    // Plain text and unknown extensions keep the bare source view — the code
    // renderer only claims a file when a grammar actually exists for it.
    expect(filePreviewKind("/tmp/notes.txt")).toBeNull();
    expect(filePreviewKind("/tmp/archive.bin")).toBeNull();
    expect(filePreviewKind("/tmp/LICENSE")).toBeNull();
  });

  it("prefers the document kind over highlighting for html", () => {
    // `.html` has a grammar too, so ordering decides which renderer wins. The
    // document family must win: an HTML file is more useful rendered.
    expect(filePreviewKind("/tmp/page.html")).toBe("html");
  });
});

describe("isDocumentPreviewKind", () => {
  it("separates the sanitized-iframe family from the React family", () => {
    expect(isDocumentPreviewKind("html")).toBe(true);
    expect(isDocumentPreviewKind("markdown")).toBe(true);
    for (const kind of ["json", "jsonl", "diff", "csv", "log", "code"] as const) {
      expect(isDocumentPreviewKind(kind)).toBe(false);
    }
  });
});

describe("isSvgPath", () => {
  it("identifies svg regardless of case", () => {
    expect(isSvgPath("/tmp/icon.svg")).toBe(true);
    expect(isSvgPath("/tmp/icon.SVG")).toBe(true);
    expect(isSvgPath("/tmp/icon.png")).toBe(false);
  });
});
