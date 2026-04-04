import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ExplorerView } from "./ExplorerView";
import { clipboardWriteText, readFileForViewer, listDirectory } from "@/lib/tauri-api";
import { useSettingsStore } from "@/stores/settings-store";
import { useTerminalStore } from "@/stores/terminal-store";

// --- Mocks ---

vi.mock("@/lib/tauri-api", () => ({
  clipboardWriteText: vi.fn().mockResolvedValue(undefined),
  readFileForViewer: vi
    .fn()
    .mockResolvedValue({ kind: "text", content: "file content", truncated: false }),
  listDirectory: vi.fn().mockResolvedValue([]),
  handleLxMessage: vi.fn().mockResolvedValue({ success: true, error: null }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const defaultProps = {
  instanceId: "explorer-test-1",
  profile: "WSL",
  syncGroup: "ws-1",
  cwdReceive: true,
  isFocused: true,
  lastCwd: "/home/user",
};

/** Mock directory entries for testing. */
const mockDirEntries = [
  { name: "subdir", isDirectory: true, isSymlink: false, isExecutable: false, size: 0 },
  { name: "a.txt", isDirectory: false, isSymlink: false, isExecutable: false, size: 100 },
  { name: "b.txt", isDirectory: false, isSymlink: false, isExecutable: false, size: 200 },
  { name: "c.txt", isDirectory: false, isSymlink: false, isExecutable: false, size: 300 },
];

function mockListDir(entries = mockDirEntries) {
  vi.mocked(listDirectory).mockResolvedValue(entries);
}

describe("ExplorerView", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(clipboardWriteText).mockClear();
    vi.mocked(readFileForViewer).mockClear();
    vi.mocked(listDirectory).mockClear();
    mockListDir();
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useTerminalStore.setState({ instances: [] });
    // jsdom doesn't implement scrollIntoView
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders with data-testid", async () => {
    render(<ExplorerView {...defaultProps} />);
    expect(screen.getByTestId("explorer-view")).toBeInTheDocument();
  });

  it("shows path bar with current cwd", async () => {
    render(<ExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(screen.getByTestId("explorer-path-bar")).toHaveTextContent("/home/user");
  });

  it("calls listDirectory and shows entries", async () => {
    render(<ExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(listDirectory).toHaveBeenCalledWith("/home/user");
    // item-0 is "..", then actual entries
    expect(screen.getByTestId("explorer-item-0")).toHaveTextContent("..");
    expect(screen.getByTestId("explorer-item-1")).toHaveTextContent("subdir/");
    expect(screen.getByTestId("explorer-item-2")).toHaveTextContent("a.txt");
    expect(screen.getByTestId("explorer-item-3")).toHaveTextContent("b.txt");
    expect(screen.getByTestId("explorer-item-4")).toHaveTextContent("c.txt");
  });

  it("click selects single item", async () => {
    render(<ExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    fireEvent.click(screen.getByTestId("explorer-item-1"));
    expect(screen.getByTestId("explorer-item-1").dataset.selected).toBe("true");
    expect(screen.getByTestId("explorer-item-0").dataset.selected).toBe("false");
  });

  it("ctrl+click toggles selection", async () => {
    render(<ExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    fireEvent.click(screen.getByTestId("explorer-item-0"));
    fireEvent.click(screen.getByTestId("explorer-item-2"), { ctrlKey: true });
    expect(screen.getByTestId("explorer-item-0").dataset.selected).toBe("true");
    expect(screen.getByTestId("explorer-item-2").dataset.selected).toBe("true");
    expect(screen.getByTestId("explorer-item-1").dataset.selected).toBe("false");
  });

  it("shift+click selects range", async () => {
    render(<ExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    fireEvent.click(screen.getByTestId("explorer-item-1"));
    fireEvent.click(screen.getByTestId("explorer-item-3"), { shiftKey: true });
    expect(screen.getByTestId("explorer-item-0").dataset.selected).toBe("false");
    expect(screen.getByTestId("explorer-item-1").dataset.selected).toBe("true");
    expect(screen.getByTestId("explorer-item-2").dataset.selected).toBe("true");
    expect(screen.getByTestId("explorer-item-3").dataset.selected).toBe("true");
  });

  it("arrow down moves focus", async () => {
    render(<ExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const view = screen.getByTestId("explorer-view");
    fireEvent.keyDown(view, { key: "ArrowDown" });
    expect(screen.getByTestId("explorer-item-1").dataset.focused).toBe("true");
    expect(screen.getByTestId("explorer-item-1").dataset.selected).toBe("true");
  });

  it("arrow up moves focus", async () => {
    render(<ExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const view = screen.getByTestId("explorer-view");
    fireEvent.keyDown(view, { key: "ArrowDown" });
    fireEvent.keyDown(view, { key: "ArrowDown" });
    fireEvent.keyDown(view, { key: "ArrowUp" });
    expect(screen.getByTestId("explorer-item-1").dataset.focused).toBe("true");
  });

  it("Enter activates directory (navigates)", async () => {
    render(<ExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    vi.mocked(listDirectory).mockClear();

    const view = screen.getByTestId("explorer-view");
    // Focus is on index 0 (..); move to index 1 (subdir), press Enter
    fireEvent.keyDown(view, { key: "ArrowDown" });
    fireEvent.keyDown(view, { key: "Enter" });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(listDirectory).toHaveBeenCalledWith("/home/user/subdir");
  });

  it("Enter activates file (opens viewer)", async () => {
    render(<ExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const view = screen.getByTestId("explorer-view");
    // Move to a.txt (index 2: past ".." and "subdir")
    fireEvent.keyDown(view, { key: "ArrowDown" });
    fireEvent.keyDown(view, { key: "ArrowDown" });
    fireEvent.keyDown(view, { key: "Enter" });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(readFileForViewer).toHaveBeenCalledWith("/home/user/a.txt");
    expect(screen.getByTestId("explorer-viewer-titlebar")).toHaveTextContent("/home/user/a.txt");
  });

  it("double-click directory navigates", async () => {
    render(<ExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    vi.mocked(listDirectory).mockClear();

    fireEvent.doubleClick(screen.getByTestId("explorer-item-1")); // subdir (index 1, after "..")

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(listDirectory).toHaveBeenCalledWith("/home/user/subdir");
  });

  it("double-click file opens viewer", async () => {
    render(<ExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    fireEvent.doubleClick(screen.getByTestId("explorer-item-2")); // a.txt (index 2)

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(readFileForViewer).toHaveBeenCalled();
    expect(screen.getByTestId("explorer-viewer-titlebar")).toBeInTheDocument();
  });

  it("Ctrl+C copies selected paths", async () => {
    render(<ExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    fireEvent.click(screen.getByTestId("explorer-item-2")); // a.txt (index 2)
    fireEvent.click(screen.getByTestId("explorer-item-4"), { ctrlKey: true }); // c.txt (index 4)

    const view = screen.getByTestId("explorer-view");
    fireEvent.keyDown(view, { key: "c", ctrlKey: true });

    expect(clipboardWriteText).toHaveBeenCalledWith("/home/user/a.txt\n/home/user/c.txt");
  });

  it("right-click copies selected paths", async () => {
    render(<ExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    fireEvent.click(screen.getByTestId("explorer-item-2")); // a.txt (index 2)
    vi.mocked(clipboardWriteText).mockClear();

    const view = screen.getByTestId("explorer-view");
    fireEvent.contextMenu(view);

    expect(clipboardWriteText).toHaveBeenCalledWith("/home/user/a.txt");
  });

  it("syncGroup CWD change from terminal store refreshes listing", async () => {
    render(<ExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    vi.mocked(listDirectory).mockClear();

    // Simulate a terminal in the same syncGroup updating its CWD
    act(() => {
      useTerminalStore.getState().registerInstance({
        id: "terminal-1",
        profile: "WSL",
        syncGroup: "ws-1",
        workspaceId: "ws-1",
      });
      useTerminalStore.getState().updateInstanceInfo("terminal-1", {
        cwd: "/home/user/other",
      });
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(listDirectory).toHaveBeenCalledWith("/home/user/other");
  });

  it("viewer close button returns to listing", async () => {
    render(<ExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    fireEvent.doubleClick(screen.getByTestId("explorer-item-2")); // a.txt
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(screen.getByTestId("explorer-viewer-titlebar")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("explorer-viewer-close"));
    expect(screen.getByTestId("explorer-list")).toBeInTheDocument();
  });

  it("Escape closes viewer", async () => {
    render(<ExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    fireEvent.doubleClick(screen.getByTestId("explorer-item-2")); // a.txt
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const view = screen.getByTestId("explorer-view");
    fireEvent.keyDown(view, { key: "Escape" });
    expect(screen.getByTestId("explorer-list")).toBeInTheDocument();
  });

  it("web viewer shows text content", async () => {
    vi.mocked(readFileForViewer).mockResolvedValue({
      kind: "text",
      content: "hello world",
      truncated: false,
    });
    render(<ExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    fireEvent.doubleClick(screen.getByTestId("explorer-item-2")); // a.txt
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(screen.getByTestId("explorer-viewer-text")).toHaveTextContent("hello world");
  });

  it("web viewer shows image", async () => {
    vi.mocked(readFileForViewer).mockResolvedValue({
      kind: "image",
      dataUrl: "data:image/png;base64,abc123",
    });
    mockListDir([
      { name: "photo.png", isDirectory: false, isSymlink: false, isExecutable: false, size: 5000 },
    ]);
    render(<ExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    fireEvent.doubleClick(screen.getByTestId("explorer-item-1")); // photo.png (after "..")
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(screen.getByTestId("explorer-viewer-image")).toBeInTheDocument();
  });

  it("shows empty state when no CWD available", async () => {
    render(<ExplorerView {...defaultProps} lastCwd="" />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // No CWD → should not be stuck at Loading
    expect(screen.getByTestId("explorer-list")).toBeInTheDocument();
  });

  it("shows .. entry at top of file list", async () => {
    render(<ExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // First item should be ".."
    expect(screen.getByTestId("explorer-item-0")).toHaveTextContent("..");
    // Original first entry (subdir) is now at index 1
    expect(screen.getByTestId("explorer-item-1")).toHaveTextContent("subdir/");
  });

  it("double-click .. navigates to parent directory", async () => {
    render(<ExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    vi.mocked(listDirectory).mockClear();

    fireEvent.doubleClick(screen.getByTestId("explorer-item-0")); // ".."

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(listDirectory).toHaveBeenCalledWith("/home");
  });

  it("back button navigates to previous directory", async () => {
    render(<ExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // Navigate to subdir (double-click item-1 which is subdir after ".." at 0)
    fireEvent.doubleClick(screen.getByTestId("explorer-item-1"));
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    vi.mocked(listDirectory).mockClear();
    // Click back button
    fireEvent.click(screen.getByTestId("explorer-back"));
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(listDirectory).toHaveBeenCalledWith("/home/user");
  });

  it("forward button navigates after going back", async () => {
    render(<ExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // Navigate to subdir
    fireEvent.doubleClick(screen.getByTestId("explorer-item-1"));
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // Go back
    fireEvent.click(screen.getByTestId("explorer-back"));
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    vi.mocked(listDirectory).mockClear();
    // Go forward
    fireEvent.click(screen.getByTestId("explorer-forward"));
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(listDirectory).toHaveBeenCalledWith("/home/user/subdir");
  });

  it("Alt+Left goes back, Alt+Right goes forward", async () => {
    render(<ExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // Navigate to subdir
    fireEvent.doubleClick(screen.getByTestId("explorer-item-1"));
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const view = screen.getByTestId("explorer-view");
    vi.mocked(listDirectory).mockClear();

    // Alt+Left = back
    fireEvent.keyDown(view, { key: "ArrowLeft", altKey: true });
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(listDirectory).toHaveBeenCalledWith("/home/user");

    vi.mocked(listDirectory).mockClear();
    // Alt+Right = forward
    fireEvent.keyDown(view, { key: "ArrowRight", altKey: true });
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(listDirectory).toHaveBeenCalledWith("/home/user/subdir");
  });

  it("Backspace navigates to parent", async () => {
    render(<ExplorerView {...defaultProps} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    vi.mocked(listDirectory).mockClear();

    const view = screen.getByTestId("explorer-view");
    fireEvent.keyDown(view, { key: "Backspace" });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(listDirectory).toHaveBeenCalledWith("/home");
  });
});
