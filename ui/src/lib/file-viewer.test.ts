import { describe, it, expect } from "vitest";
import {
  normalizeViewerPath,
  isOpenablePath,
  fileExtension,
  resolveViewer,
  resolveViewerProfile,
  viewerInstanceId,
} from "./file-viewer";
import type { ExtensionViewer } from "@/lib/tauri-api";

describe("normalizeViewerPath", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeViewerPath("  /tmp/a.txt  ")).toBe("/tmp/a.txt");
  });

  it("returns empty string for blank input", () => {
    expect(normalizeViewerPath("")).toBe("");
    expect(normalizeViewerPath("   ")).toBe("");
  });

  it("strips a single pair of wrapping double quotes", () => {
    expect(normalizeViewerPath('"C:\\Users\\me\\a b.txt"')).toBe("C:\\Users\\me\\a b.txt");
  });

  it("strips a single pair of wrapping single quotes", () => {
    expect(normalizeViewerPath("'/tmp/a.txt'")).toBe("/tmp/a.txt");
  });

  it("does not strip mismatched quotes", () => {
    expect(normalizeViewerPath("'/tmp/a.txt")).toBe("'/tmp/a.txt");
  });

  it("handles non-string input defensively", () => {
    // @ts-expect-error testing runtime robustness
    expect(normalizeViewerPath(null)).toBe("");
  });
});

describe("isOpenablePath", () => {
  it("true for a real path", () => {
    expect(isOpenablePath("/tmp/a.txt")).toBe(true);
  });
  it("false for blank/whitespace", () => {
    expect(isOpenablePath("")).toBe(false);
    expect(isOpenablePath("   ")).toBe(false);
  });
});

describe("fileExtension", () => {
  it("returns lowercased extension with dot", () => {
    expect(fileExtension("/tmp/Report.PDF")).toBe(".pdf");
  });
  it("uses the last path segment only", () => {
    expect(fileExtension("/a.b.c/file")).toBe("");
    expect(fileExtension("C:\\my.dir\\notes.md")).toBe(".md");
  });
  it("returns empty for dotfiles and extensionless files", () => {
    expect(fileExtension("/home/me/.bashrc")).toBe("");
    expect(fileExtension("/usr/bin/ls")).toBe("");
  });
});

describe("resolveViewer", () => {
  const viewers: ExtensionViewer[] = [
    { extensions: [".pdf"], command: "evince" },
    { extensions: [".mp4", ".mkv"], command: "mpv" },
    { extensions: [".empty"], command: "   " },
  ];

  it("returns web viewer when no extension matches", () => {
    expect(resolveViewer("/tmp/a.txt", viewers)).toEqual({ viewerType: "web" });
  });

  it("returns terminal viewer with command for a matched extension", () => {
    expect(resolveViewer("/tmp/movie.MKV", viewers)).toEqual({
      viewerType: "terminal",
      command: "mpv",
    });
  });

  it("matches case-insensitively", () => {
    expect(resolveViewer("/docs/x.pdf", viewers)).toEqual({
      viewerType: "terminal",
      command: "evince",
    });
  });

  it("falls back to web when the matched viewer command is blank", () => {
    expect(resolveViewer("/tmp/x.empty", viewers)).toEqual({ viewerType: "web" });
  });

  it("returns web for files with no extension", () => {
    expect(resolveViewer("/usr/bin/ls", viewers)).toEqual({ viewerType: "web" });
  });
});

describe("viewerInstanceId", () => {
  // The id is the suffix of the Tauri output channel `terminal-output-<id>`,
  // and Tauri v2 only allows [a-zA-Z0-9-/:_] in event names. Any other char
  // (notably the `.` in a file extension) made `listen()` throw, so the viewer
  // terminal received no PTY output and opened to a black screen.
  const EVENT_NAME_SAFE = /^[a-zA-Z0-9/:_-]+$/;

  it("strips the dot of a file extension so the event name is valid", () => {
    const id = viewerInstanceId("/home/me/notes.txt");
    expect(EVENT_NAME_SAFE.test(`terminal-output-${id}`)).toBe(true);
    expect(id).toMatch(/^global-file-viewer:\/home\/me\/notes_txt:[0-9a-f]+$/);
  });

  it("replaces spaces and other disallowed characters", () => {
    const id = viewerInstanceId("C:\\Users\\me\\my report (final).md");
    expect(EVENT_NAME_SAFE.test(`terminal-output-${id}`)).toBe(true);
  });

  it("keeps slashes and colons (allowed by Tauri)", () => {
    expect(viewerInstanceId("/a/b/c")).toMatch(/^global-file-viewer:\/a\/b\/c:[0-9a-f]+$/);
  });

  it("produces valid event names for unicode paths", () => {
    const id = viewerInstanceId("/home/사용자/메모.txt");
    expect(EVENT_NAME_SAFE.test(`terminal-output-${id}`)).toBe(true);
  });

  it("stays distinct for paths that differ before sanitization", () => {
    expect(viewerInstanceId("/a/x.txt")).not.toBe(viewerInstanceId("/a/y.txt"));
  });

  it("stays distinct when two paths sanitize to the same string", () => {
    // `notes.txt` and `notes_txt` both sanitize to `notes_txt`; the appended
    // hash of the original path must keep their ids distinct so a path change
    // still tears down the previous viewer PTY.
    expect(viewerInstanceId("/a/notes.txt")).not.toBe(viewerInstanceId("/a/notes_txt"));
  });

  it("is deterministic for the same path", () => {
    expect(viewerInstanceId("/a/notes.txt")).toBe(viewerInstanceId("/a/notes.txt"));
  });
});

describe("resolveViewerProfile", () => {
  const profiles = [
    { name: "PowerShell", commandLine: "powershell.exe" },
    { name: "Ubuntu", commandLine: "wsl.exe -d Ubuntu" },
  ];

  it("keeps the active profile for Windows paths", () => {
    expect(resolveViewerProfile("C:\\tmp\\a.txt", "PowerShell", profiles)).toBe("PowerShell");
  });

  it("switches to a WSL profile for unix paths when active is non-WSL", () => {
    expect(resolveViewerProfile("/home/me/a.txt", "PowerShell", profiles)).toBe("Ubuntu");
  });

  it("keeps the active profile for unix paths when it is already WSL", () => {
    expect(resolveViewerProfile("/home/me/a.txt", "Ubuntu", profiles)).toBe("Ubuntu");
  });

  it("falls back to the active profile when no WSL profile exists", () => {
    const onlyWin = [{ name: "PowerShell", commandLine: "powershell.exe" }];
    expect(resolveViewerProfile("/home/me/a.txt", "PowerShell", onlyWin)).toBe("PowerShell");
  });
});
