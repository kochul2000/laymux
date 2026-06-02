import { describe, it, expect } from "vitest";
import {
  shellEscape,
  joinPath,
  parentPath,
  normalizeAddressInput,
  resolveAddressNavigation,
} from "./file-explorer-parse";

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

describe("normalizeAddressInput", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeAddressInput("  /home/user  ")).toBe("/home/user");
  });

  it("strips a single pair of wrapping double quotes", () => {
    expect(normalizeAddressInput('"C:\\Users\\me"')).toBe("C:\\Users\\me");
  });

  it("strips a single pair of wrapping single quotes", () => {
    expect(normalizeAddressInput("'/home/user/file name.txt'")).toBe("/home/user/file name.txt");
  });

  it("strips quotes after trimming whitespace", () => {
    expect(normalizeAddressInput('  "/home/user"  ')).toBe("/home/user");
  });

  it("removes a single trailing path separator (but keeps roots)", () => {
    expect(normalizeAddressInput("/home/user/")).toBe("/home/user");
    expect(normalizeAddressInput("C:\\Users\\me\\")).toBe("C:\\Users\\me");
  });

  it("preserves unix root", () => {
    expect(normalizeAddressInput("/")).toBe("/");
  });

  it("preserves windows drive root trailing separator", () => {
    expect(normalizeAddressInput("C:\\")).toBe("C:\\");
  });

  it("returns empty string for blank input", () => {
    expect(normalizeAddressInput("   ")).toBe("");
    expect(normalizeAddressInput("")).toBe("");
  });
});

describe("resolveAddressNavigation", () => {
  it("rejects empty input", () => {
    expect(resolveAddressNavigation("", { exists: true, isDirectory: true })).toEqual({
      kind: "invalid",
    });
  });

  it("rejects a non-existent path", () => {
    expect(
      resolveAddressNavigation("/no/such/path", { exists: false, isDirectory: false }),
    ).toEqual({ kind: "invalid" });
  });

  it("navigates to a directory", () => {
    expect(resolveAddressNavigation("/home/user", { exists: true, isDirectory: true })).toEqual({
      kind: "navigate",
      dir: "/home/user",
    });
  });

  it("navigates to the parent and opens the file when input is a file", () => {
    expect(
      resolveAddressNavigation("/home/user/notes.txt", { exists: true, isDirectory: false }),
    ).toEqual({ kind: "open-file", dir: "/home/user", file: "/home/user/notes.txt" });
  });

  it("opens a windows file, navigating to its directory", () => {
    expect(
      resolveAddressNavigation("C:\\Users\\me\\notes.txt", { exists: true, isDirectory: false }),
    ).toEqual({
      kind: "open-file",
      dir: "C:\\Users\\me",
      file: "C:\\Users\\me\\notes.txt",
    });
  });

  it("normalizes the input before deciding (quoted file)", () => {
    expect(
      resolveAddressNavigation('  "/home/user/a.txt"  ', { exists: true, isDirectory: false }),
    ).toEqual({ kind: "open-file", dir: "/home/user", file: "/home/user/a.txt" });
  });
});
