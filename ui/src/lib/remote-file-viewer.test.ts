import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./tauri-api", () => ({
  readFileForViewer: vi.fn(),
  readFileForDownload: vi.fn(),
  statPaths: vi.fn(),
}));

import { useSettingsStore } from "@/stores/settings-store";
import { useTerminalStore } from "@/stores/terminal-store";
import { readFileForDownload, readFileForViewer, statPaths } from "./tauri-api";
import { handleRemoteFileViewerRequest } from "./remote-file-viewer";

function registerTerminal(cwd?: string) {
  useTerminalStore.getState().registerInstance({
    id: "terminal-1",
    profile: "PowerShell",
    syncGroup: "main",
    workspaceId: "workspace-1",
  });
  if (cwd !== undefined) {
    useTerminalStore.getState().updateInstanceInfo("terminal-1", { cwd });
  }
}

describe("Remote FileViewer path-link bridge", () => {
  beforeEach(() => {
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useTerminalStore.setState(useTerminalStore.getInitialState());
    vi.clearAllMocks();
  });

  it("desktop parser로 선택을 정리하고 terminal CWD와 조합한 파일만 검증한다", async () => {
    registerTerminal("C:\\work");
    vi.mocked(statPaths).mockResolvedValue([{ exists: true, isDirectory: false }]);

    const result = await handleRemoteFileViewerRequest("pathLink", {
      terminalId: "terminal-1",
      mode: "selection",
      lines: ['("ui/src/main.ts:42:5")'],
    });

    expect(statPaths).toHaveBeenCalledWith(["C:\\work\\ui\\src\\main.ts"]);
    expect(result).toEqual({
      success: true,
      data: {
        valid: true,
        matches: [
          {
            token: "ui/src/main.ts",
            path: "C:\\work\\ui\\src\\main.ts",
            lineIndex: 0,
            startIndex: 2,
            endIndex: 16,
          },
        ],
      },
    });
  });

  it("desktop과 같은 MSYS CWD 정규화를 재사용한다", async () => {
    registerTerminal("/d/PycharmProjects/laymux");
    vi.mocked(statPaths).mockResolvedValue([{ exists: true, isDirectory: false }]);

    const result = await handleRemoteFileViewerRequest("pathLink", {
      terminalId: "terminal-1",
      mode: "selection",
      lines: ["src/main.rs"],
    });

    expect(statPaths).toHaveBeenCalledWith(["D:\\PycharmProjects\\laymux\\src\\main.rs"]);
    expect(result).toMatchObject({
      success: true,
      data: { valid: true, matches: [{ token: "src/main.rs" }] },
    });
  });

  it("슬래시가 앞에 붙은 Windows 절대경로를 CWD와 조합하지 않고 검증한다", async () => {
    registerTerminal("C:\\ignored");
    vi.mocked(statPaths).mockResolvedValue([{ exists: true, isDirectory: false }]);

    const result = await handleRemoteFileViewerRequest("pathLink", {
      terminalId: "terminal-1",
      mode: "selection",
      lines: ["/D:/PycharmProjects/laymux-dev/apps/android/app/src/main/assets/index.html:17"],
    });

    const path = "D:/PycharmProjects/laymux-dev/apps/android/app/src/main/assets/index.html";
    expect(statPaths).toHaveBeenCalledWith([path]);
    expect(result).toEqual({
      success: true,
      data: {
        valid: true,
        matches: [{ token: path, path, lineIndex: 0, startIndex: 1, endIndex: 74 }],
      },
    });
  });

  it.each([
    ["없는 파일", { exists: false, isDirectory: false }],
    ["디렉터리", { exists: true, isDirectory: true }],
  ])("%s은 Remote viewer 링크로 활성화하지 않는다", async (_label, info) => {
    registerTerminal("/work");
    vi.mocked(statPaths).mockResolvedValue([info]);

    const result = await handleRemoteFileViewerRequest("pathLink", {
      terminalId: "terminal-1",
      mode: "selection",
      lines: ["src"],
    });

    expect(result).toEqual({ success: true, data: { valid: false } });
  });

  it("desktop path-link 설정과 최대 길이를 그대로 적용한다", async () => {
    registerTerminal("/work");
    useSettingsStore.getState().setTerminal({ pathLinkEnabled: false });

    const disabled = await handleRemoteFileViewerRequest("pathLink", {
      terminalId: "terminal-1",
      mode: "selection",
      lines: ["src/main.rs"],
    });

    useSettingsStore.getState().setTerminal({ pathLinkEnabled: true, pathLinkMaxLength: 8 });
    const tooLong = await handleRemoteFileViewerRequest("pathLink", {
      terminalId: "terminal-1",
      mode: "selection",
      lines: ["src/main.rs"],
    });

    expect(disabled).toEqual({ success: true, data: { valid: false } });
    expect(tooLong).toEqual({ success: true, data: { valid: false } });
    expect(statPaths).not.toHaveBeenCalled();
  });

  it("URL·알 수 없는 terminal·CWD 없는 terminal은 stat 전에 거른다", async () => {
    registerTerminal();

    const url = await handleRemoteFileViewerRequest("pathLink", {
      terminalId: "terminal-1",
      mode: "selection",
      lines: ["https://example.com/a.ts"],
    });
    const noTerminal = await handleRemoteFileViewerRequest("pathLink", {
      terminalId: "terminal-missing",
      mode: "selection",
      lines: ["src/main.rs"],
    });
    const noCwd = await handleRemoteFileViewerRequest("pathLink", {
      terminalId: "terminal-1",
      mode: "selection",
      lines: ["src/main.rs"],
    });

    expect(url).toEqual({ success: true, data: { valid: false } });
    expect(noTerminal).toEqual({ success: true, data: { valid: false } });
    expect(noCwd).toEqual({ success: true, data: { valid: false } });
    expect(statPaths).not.toHaveBeenCalled();
  });

  it("넓은 선택의 복수 파일을 maximal 범위 그대로 한 배치로 검증한다", async () => {
    registerTerminal("C:\\work");
    vi.mocked(statPaths).mockResolvedValue([
      { exists: true, isDirectory: false },
      { exists: true, isDirectory: false },
    ]);

    const result = await handleRemoteFileViewerRequest("pathLink", {
      terminalId: "terminal-1",
      mode: "selection",
      lines: ["diff ui/src/App.tsx against ui/src/App.test.tsx"],
    });

    expect(statPaths).toHaveBeenCalledWith([
      "C:\\work\\ui\\src\\App.tsx",
      "C:\\work\\ui\\src\\App.test.tsx",
    ]);
    expect(result).toEqual({
      success: true,
      data: {
        valid: true,
        matches: [
          {
            token: "ui/src/App.tsx",
            path: "C:\\work\\ui\\src\\App.tsx",
            lineIndex: 0,
            startIndex: 5,
            endIndex: 19,
          },
          {
            token: "ui/src/App.test.tsx",
            path: "C:\\work\\ui\\src\\App.test.tsx",
            lineIndex: 0,
            startIndex: 28,
            endIndex: 47,
          },
        ],
      },
    });
  });

  it("디렉터리는 Remote 링크에서 제외하고 중복 절대경로는 한 번만 stat한다", async () => {
    registerTerminal("/work");
    vi.mocked(statPaths).mockResolvedValue([
      { exists: true, isDirectory: false },
      { exists: true, isDirectory: true },
    ]);

    const result = await handleRemoteFileViewerRequest("pathLink", {
      terminalId: "terminal-1",
      mode: "selection",
      lines: ["src/a.ts src/a.ts src/dir/"],
    });

    expect(statPaths).toHaveBeenCalledWith(["/work/src/a.ts", "/work/src/dir/"]);
    expect(result).toMatchObject({
      success: true,
      data: {
        valid: true,
        matches: [{ token: "src/a.ts" }, { token: "src/a.ts" }],
      },
    });
  });

  it("point 모드는 caret 이 가리키는 토큰 하나만 검증한다 (ADR-0188)", async () => {
    registerTerminal("/work");
    vi.mocked(statPaths).mockResolvedValue([{ exists: true, isDirectory: false }]);

    const result = await handleRemoteFileViewerRequest("pathLink", {
      terminalId: "terminal-1",
      mode: "point",
      lines: ["diff src/a.ts src/b.ts"],
      caret: { lineIndex: 0, index: 7 },
    });

    expect(statPaths).toHaveBeenCalledWith(["/work/src/a.ts"]);
    expect(result).toEqual({
      success: true,
      data: {
        valid: true,
        matches: [
          { token: "src/a.ts", path: "/work/src/a.ts", lineIndex: 0, startIndex: 5, endIndex: 13 },
        ],
      },
    });
  });

  it("point 모드의 caret 이 없거나 범위를 벗어나면 조회하지 않는다", async () => {
    registerTerminal("/work");

    const missing = await handleRemoteFileViewerRequest("pathLink", {
      terminalId: "terminal-1",
      mode: "point",
      lines: ["src/a.ts"],
    });
    const outOfRange = await handleRemoteFileViewerRequest("pathLink", {
      terminalId: "terminal-1",
      mode: "point",
      lines: ["src/a.ts"],
      caret: { lineIndex: 3, index: 0 },
    });
    const onWhitespace = await handleRemoteFileViewerRequest("pathLink", {
      terminalId: "terminal-1",
      mode: "point",
      lines: ["a src/a.ts"],
      caret: { lineIndex: 0, index: 1 },
    });

    expect(missing).toEqual({ success: true, data: { valid: false } });
    expect(outOfRange).toEqual({ success: true, data: { valid: false } });
    expect(onWhitespace).toEqual({ success: true, data: { valid: false } });
    expect(statPaths).not.toHaveBeenCalled();
  });

  it("screen 모드는 화면 여러 줄의 strong candidate 를 한 배치로 검증한다 (ADR-0188)", async () => {
    registerTerminal("/work");
    vi.mocked(statPaths).mockResolvedValue([
      { exists: true, isDirectory: false },
      { exists: true, isDirectory: false },
    ]);

    const result = await handleRemoteFileViewerRequest("pathLink", {
      terminalId: "terminal-1",
      mode: "screen",
      lines: ["edit src/a.ts now", "cd laymux", "cat Cargo.toml"],
    });

    expect(statPaths).toHaveBeenCalledWith(["/work/src/a.ts", "/work/Cargo.toml"]);
    expect(result).toMatchObject({
      success: true,
      data: {
        valid: true,
        matches: [
          { token: "src/a.ts", lineIndex: 0 },
          { token: "Cargo.toml", lineIndex: 2 },
        ],
      },
    });
  });

  it("point 모드는 공백이 든 절대경로의 확장 접두를 한 배치로 검증하고 최장 후보만 낸다 (ADR-0191)", async () => {
    registerTerminal("/work");
    const byPath = new Map([
      ["/work/b/x.exe", { exists: false, isDirectory: false }],
      ["G:/a b/x.exe", { exists: true, isDirectory: false }],
      ["G:/a b/x.exe now", { exists: false, isDirectory: false }],
    ]);
    vi.mocked(statPaths).mockImplementation(async (paths: string[]) =>
      paths.map((path) => byPath.get(path) ?? { exists: false, isDirectory: false }),
    );

    const result = await handleRemoteFileViewerRequest("pathLink", {
      terminalId: "terminal-1",
      mode: "point",
      lines: ["run G:/a b/x.exe now"],
      caret: { lineIndex: 0, index: 11 },
    });

    expect(statPaths).toHaveBeenCalledTimes(1);
    expect(statPaths).toHaveBeenCalledWith(["/work/b/x.exe", "G:/a b/x.exe", "G:/a b/x.exe now"]);
    expect(result).toEqual({
      success: true,
      data: {
        valid: true,
        matches: [
          { token: "G:/a b/x.exe", path: "G:/a b/x.exe", lineIndex: 0, startIndex: 4, endIndex: 16 },
        ],
      },
    });
  });

  it("screen 모드도 공백 확장 후보를 찾아 존재하는 파일만 낸다 (ADR-0191)", async () => {
    registerTerminal("/work");
    const byPath = new Map([
      ["G:/내 드라이브", { exists: true, isDirectory: true }],
      ["G:/내 드라이브/Advisor/setup.exe", { exists: true, isDirectory: false }],
    ]);
    vi.mocked(statPaths).mockImplementation(async (paths: string[]) =>
      paths.map((path) => byPath.get(path) ?? { exists: false, isDirectory: false }),
    );

    const result = await handleRemoteFileViewerRequest("pathLink", {
      terminalId: "terminal-1",
      mode: "screen",
      lines: ["다운로드: G:/내 드라이브/Advisor/setup.exe 완료"],
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        valid: true,
        matches: [{ token: "G:/내 드라이브/Advisor/setup.exe", lineIndex: 0, startIndex: 6 }],
      },
    });
    const matches = (result.data as { matches: Array<{ token: string }> }).matches;
    expect(matches).toHaveLength(1);
  });

  it("알 수 없는 mode 나 잘못된 lines 는 fail-closed 다", async () => {
    registerTerminal("/work");

    const badMode = await handleRemoteFileViewerRequest("pathLink", {
      terminalId: "terminal-1",
      mode: "hover",
      lines: ["src/main.rs"],
    });
    const badLines = await handleRemoteFileViewerRequest("pathLink", {
      terminalId: "terminal-1",
      mode: "selection",
      lines: "src/main.rs",
    });
    const emptyLines = await handleRemoteFileViewerRequest("pathLink", {
      terminalId: "terminal-1",
      mode: "selection",
      lines: [],
    });

    expect(badMode).toEqual({ success: true, data: { valid: false } });
    expect(badLines).toEqual({ success: true, data: { valid: false } });
    expect(emptyLines).toEqual({ success: true, data: { valid: false } });
    expect(statPaths).not.toHaveBeenCalled();
  });

  it("stat 대기 중 terminal CWD가 바뀌면 이전 CWD의 결과를 폐기한다", async () => {
    registerTerminal("/work/a");
    let resolveStat!: (value: Array<{ exists: boolean; isDirectory: boolean }>) => void;
    vi.mocked(statPaths).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStat = resolve;
        }),
    );

    const pending = handleRemoteFileViewerRequest("pathLink", {
      terminalId: "terminal-1",
      mode: "selection",
      lines: ["src/main.rs"],
    });
    useTerminalStore.getState().updateInstanceInfo("terminal-1", { cwd: "/work/b" });
    resolveStat([{ exists: true, isDirectory: false }]);

    await expect(pending).resolves.toEqual({ success: true, data: { valid: false } });
    expect(statPaths).toHaveBeenCalledWith(["/work/a/src/main.rs"]);
  });
});

describe("Remote FileViewer render payload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("structured preview 종류는 previewDocument 없이 원문 텍스트로 내려간다", async () => {
    // ADR-0109: only the document family may become a sanitized preview
    // document. JSON/CSV/diff/log/source render as React DOM on the desktop and
    // Remote keeps showing their source, exactly as it did before those
    // renderers existed. Routing them through the sanitizer here would create
    // an HTML string the design says never exists.
    for (const path of [
      "C:\\work\\package.json",
      "C:\\work\\rows.csv",
      "C:\\work\\fix.diff",
      "C:\\work\\build.log",
      "C:\\work\\main.rs",
    ]) {
      vi.mocked(readFileForViewer).mockResolvedValue({
        kind: "text",
        content: "raw source",
        truncated: false,
      });

      const result = await handleRemoteFileViewerRequest("render", {
        source: "path",
        path,
        maxBytes: 1024,
      });

      expect(result).toEqual({
        success: true,
        data: { path, kind: "text", content: "raw source", truncated: false },
      });
    }
  });

  it("markdown 은 기존대로 previewDocument 로 내려간다", async () => {
    vi.mocked(readFileForViewer).mockResolvedValue({
      kind: "text",
      content: "# title",
      truncated: false,
    });

    const result = await handleRemoteFileViewerRequest("render", {
      source: "path",
      path: "C:\\work\\README.md",
      maxBytes: 1024,
    });

    expect(result.data).toMatchObject({ kind: "text", previewKind: "markdown" });
    expect(result.data).toHaveProperty("previewDocument");
    expect(result.data).not.toHaveProperty("content");
  });

  it("pdf 와 archive 는 분류 그대로 전달된다", async () => {
    vi.mocked(readFileForViewer).mockResolvedValue({
      kind: "archive",
      format: "zip",
      entries: [{ name: "a.txt", size: 3, compressedSize: 3, isDirectory: false }],
      totalEntries: 1,
      truncated: false,
    });

    const result = await handleRemoteFileViewerRequest("render", {
      source: "path",
      path: "C:\\work\\bundle.zip",
      maxBytes: 1024,
    });

    expect(result.data).toMatchObject({ kind: "archive", format: "zip", totalEntries: 1 });
  });
});

describe("Remote FileViewer download payload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("document 종류도 sanitize된 preview가 아니라 원본 바이트를 내려준다", async () => {
    // ADR-0185: `render` replaces an HTML/Markdown source with a preview
    // document, so a download built from that payload would save the wrong
    // bytes. The download path must never touch the viewer classifier.
    vi.mocked(readFileForDownload).mockResolvedValue({
      name: "notes.html",
      mediaType: "text/html",
      base64: "PGgxPnNvdXJjZTwvaDE+",
      size: 20,
    });

    const result = await handleRemoteFileViewerRequest("download", {
      path: "C:\\work\\notes.html",
      maxBytes: 1024,
    });

    expect(readFileForViewer).not.toHaveBeenCalled();
    expect(readFileForDownload).toHaveBeenCalledWith("C:\\work\\notes.html", 1024);
    expect(result).toEqual({
      success: true,
      data: {
        path: "C:\\work\\notes.html",
        name: "notes.html",
        mediaType: "text/html",
        base64: "PGgxPnNvdXJjZTwvaDE+",
        size: 20,
      },
    });
  });

  it("경로와 maxBytes를 검증하고 실패는 error로 내려간다", async () => {
    expect(await handleRemoteFileViewerRequest("download", { path: "  ", maxBytes: 1024 })).toEqual(
      { success: false, error: "path is required" },
    );
    expect(
      await handleRemoteFileViewerRequest("download", { path: "C:\\a.txt", maxBytes: 0 }),
    ).toEqual({ success: false, error: "maxBytes must be a positive integer" });

    vi.mocked(readFileForDownload).mockRejectedValue(
      new Error("File exceeds the 8388608 byte viewer limit"),
    );
    expect(
      await handleRemoteFileViewerRequest("download", { path: "C:\\big.bin", maxBytes: 1024 }),
    ).toEqual({ success: false, error: "File exceeds the 8388608 byte viewer limit" });
  });
});
