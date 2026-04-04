import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FileExplorerView } from "./FileExplorerView";
import {
  createTerminalSession,
  writeToTerminal,
  closeTerminalSession,
  clipboardWriteText,
  readFileForViewer,
} from "@/lib/tauri-api";
import { useSettingsStore } from "@/stores/settings-store";

// --- Mocks ---

let outputCallback: ((data: Uint8Array) => void) | null = null;
let cwdCallback: ((data: { terminalId: string; cwd: string }) => void) | null = null;

vi.mock("@/lib/tauri-api", () => ({
  createTerminalSession: vi.fn().mockResolvedValue({ id: "test" }),
  writeToTerminal: vi.fn().mockResolvedValue(undefined),
  closeTerminalSession: vi.fn().mockResolvedValue(undefined),
  onTerminalOutput: vi.fn().mockImplementation((_id: string, cb: (data: Uint8Array) => void) => {
    outputCallback = cb;
    return Promise.resolve(vi.fn());
  }),
  onTerminalCwdChanged: vi
    .fn()
    .mockImplementation((cb: (data: { terminalId: string; cwd: string }) => void) => {
      cwdCallback = cb;
      return Promise.resolve(vi.fn());
    }),
  clipboardWriteText: vi.fn().mockResolvedValue(undefined),
  readFileForViewer: vi
    .fn()
    .mockResolvedValue({ kind: "text", content: "file content", truncated: false }),
  handleLxMessage: vi.fn().mockResolvedValue({ success: true, error: null }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: vi.fn((p: string) => `asset://${p}`),
}));

function sendOutput(text: string) {
  if (outputCallback) {
    outputCallback(new TextEncoder().encode(text));
  }
}

function sendCwdChange(terminalId: string, cwd: string) {
  if (cwdCallback) {
    cwdCallback({ terminalId, cwd });
  }
}

const defaultProps = {
  instanceId: "file-explorer-test-1",
  profile: "WSL",
  syncGroup: "ws-1",
  cwdReceive: true,
  isFocused: true,
  lastCwd: "/home/user",
};

const lsSentinel = "___LXFE_END___";

function simulateLsResponse(files: string) {
  sendOutput(`ls; echo "${lsSentinel}"\n${files}\n${lsSentinel}\n`);
}

describe("FileExplorerView", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    outputCallback = null;
    cwdCallback = null;
    vi.mocked(createTerminalSession).mockClear();
    vi.mocked(writeToTerminal).mockClear();
    vi.mocked(closeTerminalSession).mockClear();
    vi.mocked(clipboardWriteText).mockClear();
    vi.mocked(readFileForViewer).mockClear();
    useSettingsStore.setState(useSettingsStore.getInitialState());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders with data-testid", async () => {
    render(<FileExplorerView {...defaultProps} />);
    expect(screen.getByTestId("file-explorer-view")).toBeInTheDocument();
  });

  it("creates background shell session on mount", async () => {
    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(createTerminalSession).toHaveBeenCalledWith(
      "file-explorer-test-1",
      "WSL",
      200,
      50,
      "ws-1",
      true,
      "/home/user",
    );
  });

  it("closes shell session on unmount", async () => {
    const { unmount } = render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    unmount();
    expect(closeTerminalSession).toHaveBeenCalledWith("file-explorer-test-1");
  });

  it("shows path bar with current cwd", async () => {
    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(screen.getByTestId("file-explorer-path-bar")).toHaveTextContent("/home/user");
  });

  it("parses ls output and shows file entries", async () => {
    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    act(() => {
      simulateLsResponse("dir1/\nfile.txt\nscript.sh*");
    });

    expect(screen.getByTestId("file-explorer-item-0")).toHaveTextContent("dir1/");
    expect(screen.getByTestId("file-explorer-item-1")).toHaveTextContent("file.txt");
    expect(screen.getByTestId("file-explorer-item-2")).toHaveTextContent("script.sh*");
  });

  it("click selects single item", async () => {
    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    act(() => simulateLsResponse("a.txt\nb.txt\nc.txt"));

    fireEvent.click(screen.getByTestId("file-explorer-item-1"));
    expect(screen.getByTestId("file-explorer-item-1").dataset.selected).toBe("true");
    expect(screen.getByTestId("file-explorer-item-0").dataset.selected).toBe("false");
  });

  it("ctrl+click toggles selection", async () => {
    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    act(() => simulateLsResponse("a.txt\nb.txt\nc.txt"));

    fireEvent.click(screen.getByTestId("file-explorer-item-0"));
    fireEvent.click(screen.getByTestId("file-explorer-item-2"), { ctrlKey: true });
    expect(screen.getByTestId("file-explorer-item-0").dataset.selected).toBe("true");
    expect(screen.getByTestId("file-explorer-item-2").dataset.selected).toBe("true");
    expect(screen.getByTestId("file-explorer-item-1").dataset.selected).toBe("false");
  });

  it("shift+click selects range", async () => {
    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    act(() => simulateLsResponse("a.txt\nb.txt\nc.txt\nd.txt"));

    fireEvent.click(screen.getByTestId("file-explorer-item-1"));
    fireEvent.click(screen.getByTestId("file-explorer-item-3"), { shiftKey: true });
    expect(screen.getByTestId("file-explorer-item-0").dataset.selected).toBe("false");
    expect(screen.getByTestId("file-explorer-item-1").dataset.selected).toBe("true");
    expect(screen.getByTestId("file-explorer-item-2").dataset.selected).toBe("true");
    expect(screen.getByTestId("file-explorer-item-3").dataset.selected).toBe("true");
  });

  it("arrow down moves focus", async () => {
    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    act(() => simulateLsResponse("a.txt\nb.txt\nc.txt"));

    const view = screen.getByTestId("file-explorer-view");
    fireEvent.keyDown(view, { key: "ArrowDown" });
    expect(screen.getByTestId("file-explorer-item-1").dataset.focused).toBe("true");
    expect(screen.getByTestId("file-explorer-item-1").dataset.selected).toBe("true");
  });

  it("arrow up moves focus", async () => {
    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    act(() => simulateLsResponse("a.txt\nb.txt\nc.txt"));

    const view = screen.getByTestId("file-explorer-view");
    // Move down first, then up
    fireEvent.keyDown(view, { key: "ArrowDown" });
    fireEvent.keyDown(view, { key: "ArrowDown" });
    fireEvent.keyDown(view, { key: "ArrowUp" });
    expect(screen.getByTestId("file-explorer-item-1").dataset.focused).toBe("true");
  });

  it("Enter activates directory (navigates)", async () => {
    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    act(() => simulateLsResponse("subdir/\nfile.txt"));
    vi.mocked(writeToTerminal).mockClear();

    const view = screen.getByTestId("file-explorer-view");
    // Focus is on index 0 (subdir/), press Enter
    fireEvent.keyDown(view, { key: "Enter" });

    // Should send cd command
    expect(writeToTerminal).toHaveBeenCalledWith(
      "file-explorer-test-1",
      expect.stringContaining("cd"),
    );
  });

  it("Enter activates file (opens viewer)", async () => {
    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    act(() => simulateLsResponse("subdir/\nfile.txt"));

    const view = screen.getByTestId("file-explorer-view");
    // Move to file.txt (index 1)
    fireEvent.keyDown(view, { key: "ArrowDown" });
    fireEvent.keyDown(view, { key: "Enter" });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(readFileForViewer).toHaveBeenCalledWith("/home/user/file.txt");
    expect(screen.getByTestId("file-explorer-viewer-titlebar")).toHaveTextContent(
      "/home/user/file.txt",
    );
  });

  it("double-click directory navigates", async () => {
    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    act(() => simulateLsResponse("subdir/\nfile.txt"));
    vi.mocked(writeToTerminal).mockClear();

    fireEvent.doubleClick(screen.getByTestId("file-explorer-item-0"));
    expect(writeToTerminal).toHaveBeenCalledWith(
      "file-explorer-test-1",
      expect.stringContaining("cd"),
    );
  });

  it("double-click file opens viewer", async () => {
    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    act(() => simulateLsResponse("subdir/\nfile.txt"));

    fireEvent.doubleClick(screen.getByTestId("file-explorer-item-1"));

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(readFileForViewer).toHaveBeenCalled();
    expect(screen.getByTestId("file-explorer-viewer-titlebar")).toBeInTheDocument();
  });

  it("Ctrl+C copies selected paths", async () => {
    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    act(() => simulateLsResponse("a.txt\nb.txt\nc.txt"));

    fireEvent.click(screen.getByTestId("file-explorer-item-0"));
    fireEvent.click(screen.getByTestId("file-explorer-item-2"), { ctrlKey: true });

    const view = screen.getByTestId("file-explorer-view");
    fireEvent.keyDown(view, { key: "c", ctrlKey: true });

    expect(clipboardWriteText).toHaveBeenCalledWith("/home/user/a.txt\n/home/user/c.txt");
  });

  it("right-click copies selected paths", async () => {
    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    act(() => simulateLsResponse("a.txt\nb.txt"));

    fireEvent.click(screen.getByTestId("file-explorer-item-0"));
    vi.mocked(clipboardWriteText).mockClear();

    const view = screen.getByTestId("file-explorer-view");
    fireEvent.contextMenu(view);

    expect(clipboardWriteText).toHaveBeenCalledWith("/home/user/a.txt");
  });

  it("sync-cwd event refreshes listing", async () => {
    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    act(() => simulateLsResponse("a.txt"));
    vi.mocked(writeToTerminal).mockClear();

    act(() => {
      sendCwdChange("file-explorer-test-1", "/home/user/other");
    });

    // Should trigger a new ls command
    expect(writeToTerminal).toHaveBeenCalledWith(
      "file-explorer-test-1",
      expect.stringContaining("ls"),
    );
  });

  it("viewer close button returns to listing", async () => {
    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    act(() => simulateLsResponse("file.txt"));

    // Open viewer
    fireEvent.doubleClick(screen.getByTestId("file-explorer-item-0"));
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(screen.getByTestId("file-explorer-viewer-titlebar")).toBeInTheDocument();

    // Close viewer
    fireEvent.click(screen.getByTestId("file-explorer-viewer-close"));
    expect(screen.getByTestId("file-explorer-list")).toBeInTheDocument();
  });

  it("Escape closes viewer", async () => {
    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    act(() => simulateLsResponse("file.txt"));

    // Open viewer
    fireEvent.doubleClick(screen.getByTestId("file-explorer-item-0"));
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const view = screen.getByTestId("file-explorer-view");
    fireEvent.keyDown(view, { key: "Escape" });
    expect(screen.getByTestId("file-explorer-list")).toBeInTheDocument();
  });

  it("web viewer shows text content", async () => {
    vi.mocked(readFileForViewer).mockResolvedValue({
      kind: "text",
      content: "hello world",
      truncated: false,
    });
    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    act(() => simulateLsResponse("readme.txt"));

    fireEvent.doubleClick(screen.getByTestId("file-explorer-item-0"));
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(screen.getByTestId("file-explorer-viewer-text")).toHaveTextContent("hello world");
  });

  it("web viewer shows image", async () => {
    vi.mocked(readFileForViewer).mockResolvedValue({
      kind: "image",
      path: "/home/user/photo.png",
    });
    render(<FileExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    act(() => simulateLsResponse("photo.png"));

    fireEvent.doubleClick(screen.getByTestId("file-explorer-item-0"));
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(screen.getByTestId("file-explorer-viewer-image")).toBeInTheDocument();
  });
});
