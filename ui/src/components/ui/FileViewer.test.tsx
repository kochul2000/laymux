import { render, screen, act, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FileViewer } from "./FileViewer";
import { openExternal, readFileForViewer } from "@/lib/tauri-api";
import { useSettingsStore } from "@/stores/settings-store";

vi.mock("@/lib/tauri-api", () => ({
  openExternal: vi.fn().mockResolvedValue(undefined),
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
      data-viewer-command={(props.viewerStartup as { command?: string } | undefined)?.command}
      data-viewer-path={(props.viewerStartup as { path?: string } | undefined)?.path}
    />
  ),
}));

const baseProps = {
  viewerInstanceId: "test-viewer",
  isFocused: true,
};

describe("FileViewer", () => {
  beforeEach(() => {
    vi.mocked(openExternal).mockClear();
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

  it("renders html files in preview mode by default and can switch to source", async () => {
    vi.mocked(readFileForViewer).mockResolvedValue({
      kind: "text",
      content: "<h1>Report</h1><script>window.__ran = true</script>",
      truncated: false,
    });
    await act(async () => {
      render(<FileViewer {...baseProps} path="/home/user/report.html" />);
    });

    const iframe = screen.getByTestId("file-viewer-preview") as HTMLIFrameElement;
    expect(iframe).toHaveAttribute("sandbox", "allow-same-origin");
    expect(iframe.getAttribute("srcdoc")).toContain("<h1>Report</h1>");
    expect(iframe.getAttribute("srcdoc")).not.toContain("<script");

    fireEvent.click(screen.getByTestId("file-viewer-source-mode"));
    expect(screen.getByTestId("file-viewer-text")).toHaveTextContent("<h1>Report</h1>");
  });

  it("opens preview links through the host shell", async () => {
    vi.mocked(readFileForViewer).mockResolvedValue({
      kind: "text",
      content: '<a href="https://example.com/docs">Docs</a>',
      truncated: false,
    });
    await act(async () => {
      render(<FileViewer {...baseProps} path="/home/user/report.html" />);
    });

    const iframe = screen.getByTestId("file-viewer-preview") as HTMLIFrameElement;
    const doc = iframe.contentDocument!;
    doc.body.innerHTML = '<a href="https://example.com/docs">Docs</a>';
    fireEvent.load(iframe);
    doc
      .querySelector("a")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(openExternal).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("renders markdown files in preview mode by default", async () => {
    vi.mocked(readFileForViewer).mockResolvedValue({
      kind: "text",
      content: "# Notes\n\n- one\n\n| A | B |\n| --- | --- |\n| C | D |",
      truncated: false,
    });
    await act(async () => {
      render(<FileViewer {...baseProps} path="/home/user/README.md" />);
    });

    const iframe = screen.getByTestId("file-viewer-preview") as HTMLIFrameElement;
    expect(iframe.getAttribute("srcdoc")).toContain("<h1>Notes</h1>");
    expect(iframe.getAttribute("srcdoc")).toContain("<li>one</li>");
    expect(iframe.getAttribute("srcdoc")).toContain("<table>");
  });

  it("starts the vi terminal viewer when vi is configured for .md", async () => {
    useSettingsStore.setState({
      fileExplorer: {
        ...useSettingsStore.getState().fileExplorer,
        extensionViewers: [{ extensions: [".md"], command: "vi", profile: "WSL" }],
      },
    });
    await act(async () => {
      render(<FileViewer {...baseProps} path="/home/user/README.md" />);
    });

    expect(readFileForViewer).not.toHaveBeenCalled();
    expect(screen.getByTestId("file-viewer-terminal")).toHaveClass("h-full", "min-w-0", "flex-1");
    expect(screen.getByTestId("mock-terminal-view")).toHaveAttribute("data-profile", "WSL");
    expect(screen.getByTestId("mock-terminal-view")).not.toHaveAttribute("data-startup-command");
    expect(screen.getByTestId("mock-terminal-view")).toHaveAttribute("data-viewer-command", "vi");
    expect(screen.getByTestId("mock-terminal-view")).toHaveAttribute(
      "data-viewer-path",
      "/home/user/README.md",
    );
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
        extensionViewers: [{ extensions: [".txt"], command: "vi", profile: "WSL" }],
      },
    });
    await act(async () => {
      render(<FileViewer {...baseProps} path="/home/user/a.txt" />);
    });
    // Terminal viewer path is taken — readFileForViewer is NOT called.
    expect(readFileForViewer).not.toHaveBeenCalled();
    const term = screen.getByTestId("mock-terminal-view");
    expect(term).toHaveAttribute("data-profile", "WSL");
    expect(term).toHaveAttribute("data-viewer-command", "vi");
    expect(term).toHaveAttribute("data-viewer-path", "/home/user/a.txt");
  });

  it("uses the explicitly selected Windows profile without inferring from the path", async () => {
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
        extensionViewers: [{ extensions: [".txt"], command: "notepad", profile: "PowerShell" }],
      },
    });
    await act(async () => {
      render(<FileViewer {...baseProps} path="/home/user/a.txt" />);
    });
    expect(screen.getByTestId("mock-terminal-view")).toHaveAttribute("data-profile", "PowerShell");
    expect(screen.getByTestId("mock-terminal-view")).toHaveAttribute(
      "data-viewer-path",
      "/home/user/a.txt",
    );
  });

  it("shows an explicit error instead of inferring a missing viewer profile", async () => {
    useSettingsStore.setState({
      fileExplorer: {
        ...useSettingsStore.getState().fileExplorer,
        extensionViewers: [{ extensions: [".md"], command: "vi", profile: "" }],
      },
    });

    await act(async () => {
      render(<FileViewer {...baseProps} path="/home/user/README.md" />);
    });

    expect(screen.queryByTestId("mock-terminal-view")).not.toBeInTheDocument();
    expect(screen.getByTestId("file-viewer-error")).toHaveTextContent(
      "Select a terminal profile for the .md viewer.",
    );
  });

  it("shows an explicit error when the configured viewer profile no longer exists", async () => {
    useSettingsStore.setState({
      fileExplorer: {
        ...useSettingsStore.getState().fileExplorer,
        extensionViewers: [{ extensions: [".md"], command: "vi", profile: "Deleted" }],
      },
    });

    await act(async () => {
      render(<FileViewer {...baseProps} path="/home/user/README.md" />);
    });

    expect(screen.queryByTestId("mock-terminal-view")).not.toBeInTheDocument();
    expect(screen.getByTestId("file-viewer-error")).toHaveTextContent(
      'Terminal profile "Deleted" does not exist.',
    );
  });
});
