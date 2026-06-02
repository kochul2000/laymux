import { render, screen, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FileViewer } from "./FileViewer";
import { readFileForViewer } from "@/lib/tauri-api";
import { useSettingsStore } from "@/stores/settings-store";

vi.mock("@/lib/tauri-api", () => ({
  readFileForViewer: vi
    .fn()
    .mockResolvedValue({ kind: "text", content: "file content", truncated: false }),
}));

// Terminal viewer branch renders TerminalView — mock it to inspect props.
vi.mock("@/components/views/TerminalView", () => ({
  TerminalView: (props: Record<string, unknown>) => (
    <div
      data-testid="mock-terminal-view"
      data-startup-command={props.startupCommandOverride}
      data-profile={props.profile}
    />
  ),
}));

const baseProps = {
  profile: "WSL",
  viewerInstanceId: "test-viewer",
  isFocused: true,
};

describe("FileViewer", () => {
  beforeEach(() => {
    vi.mocked(readFileForViewer).mockClear();
    vi.mocked(readFileForViewer).mockResolvedValue({
      kind: "text",
      content: "file content",
      truncated: false,
    });
    useSettingsStore.setState(useSettingsStore.getInitialState());
  });

  it("renders text content for a web viewer", async () => {
    vi.mocked(readFileForViewer).mockResolvedValue({
      kind: "text",
      content: "hello world",
      truncated: false,
    });
    await act(async () => {
      render(<FileViewer {...baseProps} path="/home/user/a.txt" />);
    });
    expect(readFileForViewer).toHaveBeenCalledWith("/home/user/a.txt");
    expect(screen.getByTestId("file-viewer-text")).toHaveTextContent("hello world");
  });

  it("renders an image for image content", async () => {
    vi.mocked(readFileForViewer).mockResolvedValue({
      kind: "image",
      dataUrl: "data:image/png;base64,abc123",
    });
    await act(async () => {
      render(<FileViewer {...baseProps} path="/home/user/photo.png" />);
    });
    expect(screen.getByTestId("file-viewer-image")).toBeInTheDocument();
  });

  it("renders a binary placeholder for binary content", async () => {
    vi.mocked(readFileForViewer).mockResolvedValue({ kind: "binary", size: 2048 });
    await act(async () => {
      render(<FileViewer {...baseProps} path="/home/user/blob.bin" />);
    });
    expect(screen.getByTestId("file-viewer-binary")).toHaveTextContent("2.0 KB");
  });

  it("shows an error message when reading fails", async () => {
    vi.mocked(readFileForViewer).mockRejectedValue("boom");
    await act(async () => {
      render(<FileViewer {...baseProps} path="/home/user/a.txt" />);
    });
    expect(screen.getByTestId("file-viewer-text")).toHaveTextContent("Error reading file: boom");
  });

  it("uses a terminal viewer with the configured command for matching extensions", async () => {
    useSettingsStore.setState({
      fileExplorer: {
        ...useSettingsStore.getState().fileExplorer,
        extensionViewers: [{ extensions: [".txt"], command: "vi" }],
      },
    });
    await act(async () => {
      render(<FileViewer {...baseProps} path="/home/user/a.txt" />);
    });
    // Terminal viewer path is taken — readFileForViewer is NOT called.
    expect(readFileForViewer).not.toHaveBeenCalled();
    const term = screen.getByTestId("mock-terminal-view");
    expect(term).toHaveAttribute("data-startup-command", "vi '/home/user/a.txt'");
  });

  it("picks a WSL profile for unix paths in the terminal viewer", async () => {
    useSettingsStore.setState({
      profiles: [
        {
          name: "PowerShell",
          commandLine: "powershell.exe",
          startingDirectory: "",
          startupCommand: "",
          syncCwd: "default",
        },
        {
          name: "WSL",
          commandLine: "wsl.exe",
          startingDirectory: "",
          startupCommand: "",
          syncCwd: "default",
        },
      ],
      fileExplorer: {
        ...useSettingsStore.getState().fileExplorer,
        extensionViewers: [{ extensions: [".txt"], command: "vi" }],
      },
    });
    await act(async () => {
      render(<FileViewer {...baseProps} profile="PowerShell" path="/home/user/a.txt" />);
    });
    expect(screen.getByTestId("mock-terminal-view")).toHaveAttribute("data-profile", "WSL");
  });
});
