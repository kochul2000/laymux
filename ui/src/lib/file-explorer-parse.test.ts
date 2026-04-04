import { describe, it, expect } from "vitest";
import { parseLsOutput, stripAnsi, shellEscape, joinPath } from "./file-explorer-parse";

describe("shellEscape", () => {
  it("wraps simple string in single quotes", () => {
    expect(shellEscape("hello")).toBe("'hello'");
  });

  it("escapes embedded single quotes", () => {
    expect(shellEscape("it's")).toBe("'it'\\''s'");
  });

  it("prevents command injection via $(...)", () => {
    const malicious = "$(rm -rf /)";
    const escaped = shellEscape(malicious);
    // Inside single quotes, $() is literal — no expansion occurs
    expect(escaped).toBe("'$(rm -rf /)'");
  });

  it("prevents backtick injection", () => {
    expect(shellEscape("`whoami`")).toBe("'`whoami`'");
  });

  it("handles empty string", () => {
    expect(shellEscape("")).toBe("''");
  });
});

describe("joinPath", () => {
  it("joins unix paths with /", () => {
    expect(joinPath("/home/user", "file.txt")).toBe("/home/user/file.txt");
  });

  it("does not double-slash when base ends with /", () => {
    expect(joinPath("/home/user/", "file.txt")).toBe("/home/user/file.txt");
  });

  it("joins windows paths with \\", () => {
    expect(joinPath("C:\\Users\\me", "file.txt")).toBe("C:\\Users\\me\\file.txt");
  });

  it("does not double-backslash when base ends with \\", () => {
    expect(joinPath("C:\\Users\\me\\", "file.txt")).toBe("C:\\Users\\me\\file.txt");
  });
});

describe("stripAnsi", () => {
  it("strips CSI sequences", () => {
    expect(stripAnsi("\x1b[32mhello\x1b[0m")).toBe("hello");
  });

  it("strips OSC sequences", () => {
    expect(stripAnsi("\x1b]0;title\x07text")).toBe("text");
  });

  it("passes through plain text", () => {
    expect(stripAnsi("plain text")).toBe("plain text");
  });
});

describe("parseLsOutput", () => {
  it("parses basic ls -F output", () => {
    const output = "dir1/\nfile.txt\nscript.sh*\nlink@\n";
    const entries = parseLsOutput(output);
    expect(entries).toHaveLength(4);

    expect(entries[0]).toEqual({
      name: "dir1",
      isDirectory: true,
      isSymlink: false,
      isExecutable: false,
      rawLine: "dir1/",
    });
    expect(entries[1]).toEqual({
      name: "file.txt",
      isDirectory: false,
      isSymlink: false,
      isExecutable: false,
      rawLine: "file.txt",
    });
    expect(entries[2]).toEqual({
      name: "script.sh",
      isDirectory: false,
      isSymlink: false,
      isExecutable: true,
      rawLine: "script.sh*",
    });
    expect(entries[3]).toEqual({
      name: "link",
      isDirectory: false,
      isSymlink: true,
      isExecutable: false,
      rawLine: "link@",
    });
  });

  it("skips empty lines", () => {
    const output = "\nfile.txt\n\n";
    const entries = parseLsOutput(output);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("file.txt");
  });

  it("skips total header from ls -l", () => {
    const output = "total 42\nfile.txt\n";
    const entries = parseLsOutput(output);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("file.txt");
  });

  it("strips ANSI colors before parsing", () => {
    const output = "\x1b[34mdir/\x1b[0m\n\x1b[32mfile.txt\x1b[0m\n";
    const entries = parseLsOutput(output);
    expect(entries).toHaveLength(2);
    expect(entries[0].name).toBe("dir");
    expect(entries[0].isDirectory).toBe(true);
    expect(entries[1].name).toBe("file.txt");
  });

  it("handles .. directory", () => {
    const output = "../\n./\nfile.txt\n";
    const entries = parseLsOutput(output);
    expect(entries).toHaveLength(3);
    expect(entries[0].name).toBe("..");
    expect(entries[0].isDirectory).toBe(true);
    expect(entries[1].name).toBe(".");
    expect(entries[1].isDirectory).toBe(true);
  });

  it("returns empty array for empty input", () => {
    expect(parseLsOutput("")).toEqual([]);
    expect(parseLsOutput("\n\n")).toEqual([]);
  });
});
