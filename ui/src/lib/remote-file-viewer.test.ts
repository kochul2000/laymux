import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./tauri-api", () => ({
  readFileForViewer: vi.fn(),
  statPath: vi.fn(),
}));

import { useSettingsStore } from "@/stores/settings-store";
import { useTerminalStore } from "@/stores/terminal-store";
import { readFileForViewer, statPath } from "./tauri-api";
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
    vi.mocked(statPath).mockResolvedValue({ exists: true, isDirectory: false });

    const result = await handleRemoteFileViewerRequest("pathLink", {
      terminalId: "terminal-1",
      selection: '("ui/src/main.ts:42:5")',
    });

    expect(statPath).toHaveBeenCalledWith("C:\\work\\ui\\src\\main.ts");
    expect(result).toEqual({
      success: true,
      data: {
        valid: true,
        token: "ui/src/main.ts",
        path: "C:\\work\\ui\\src\\main.ts",
      },
    });
  });

  it("desktop과 같은 MSYS CWD 정규화를 재사용한다", async () => {
    registerTerminal("/d/PycharmProjects/laymux");
    vi.mocked(statPath).mockResolvedValue({ exists: true, isDirectory: false });

    const result = await handleRemoteFileViewerRequest("pathLink", {
      terminalId: "terminal-1",
      selection: "src/main.rs",
    });

    expect(statPath).toHaveBeenCalledWith("D:\\PycharmProjects\\laymux\\src\\main.rs");
    expect(result).toMatchObject({ success: true, data: { valid: true, token: "src/main.rs" } });
  });

  it.each([
    ["없는 파일", { exists: false, isDirectory: false }],
    ["디렉터리", { exists: true, isDirectory: true }],
  ])("%s은 Remote viewer 링크로 활성화하지 않는다", async (_label, info) => {
    registerTerminal("/work");
    vi.mocked(statPath).mockResolvedValue(info);

    const result = await handleRemoteFileViewerRequest("pathLink", {
      terminalId: "terminal-1",
      selection: "src",
    });

    expect(result).toEqual({ success: true, data: { valid: false } });
  });

  it("desktop path-link 설정과 최대 길이를 그대로 적용한다", async () => {
    registerTerminal("/work");
    useSettingsStore.getState().setTerminal({ pathLinkEnabled: false });

    const disabled = await handleRemoteFileViewerRequest("pathLink", {
      terminalId: "terminal-1",
      selection: "src/main.rs",
    });

    useSettingsStore.getState().setTerminal({ pathLinkEnabled: true, pathLinkMaxLength: 8 });
    const tooLong = await handleRemoteFileViewerRequest("pathLink", {
      terminalId: "terminal-1",
      selection: "src/main.rs",
    });

    expect(disabled).toEqual({ success: true, data: { valid: false } });
    expect(tooLong).toEqual({ success: true, data: { valid: false } });
    expect(statPath).not.toHaveBeenCalled();
  });

  it("URL·알 수 없는 terminal·CWD 없는 terminal은 stat 전에 거른다", async () => {
    registerTerminal();

    const url = await handleRemoteFileViewerRequest("pathLink", {
      terminalId: "terminal-1",
      selection: "https://example.com/a.ts",
    });
    const noTerminal = await handleRemoteFileViewerRequest("pathLink", {
      terminalId: "terminal-missing",
      selection: "src/main.rs",
    });
    const noCwd = await handleRemoteFileViewerRequest("pathLink", {
      terminalId: "terminal-1",
      selection: "src/main.rs",
    });

    expect(url).toEqual({ success: true, data: { valid: false } });
    expect(noTerminal).toEqual({ success: true, data: { valid: false } });
    expect(noCwd).toEqual({ success: true, data: { valid: false } });
    expect(statPath).not.toHaveBeenCalled();
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
