import { describe, it, expect } from "vitest";
import { shellEscape, joinPath, parentPath } from "./file-explorer-parse";

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

describe("parentPath", () => {
  it("returns parent of unix path", () => {
    expect(parentPath("/home/user/project")).toBe("/home/user");
  });

  it("returns root for single-level path", () => {
    expect(parentPath("/home")).toBe("/");
  });

  it("returns root for root", () => {
    expect(parentPath("/")).toBe("/");
  });

  it("handles trailing slash", () => {
    expect(parentPath("/home/user/")).toBe("/home");
  });

  it("returns empty for empty input", () => {
    expect(parentPath("")).toBe("");
  });

  it("handles windows paths", () => {
    expect(parentPath("C:\\Users\\me\\project")).toBe("C:\\Users\\me");
  });
});
