import { render, screen, act, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { FileViewerOverlay } from "./FileViewerOverlay";
import { useFileViewerStore } from "@/stores/file-viewer-store";
import { useSettingsStore } from "@/stores/settings-store";
import { viewerInstanceId } from "@/lib/file-viewer";

// Mock FileViewer so the overlay tests stay focused on overlay behaviour
// (dismiss handling + the id it forwards), not on file reading / TerminalView.
vi.mock("@/components/ui/FileViewer", () => ({
  FileViewer: (props: Record<string, unknown>) => (
    <div
      data-testid="mock-file-viewer"
      data-instance-id={props.viewerInstanceId as string}
      data-path={props.path as string}
    />
  ),
}));

function useTerminalViewerFor(ext: string) {
  useSettingsStore.setState({
    fileExplorer: {
      ...useSettingsStore.getState().fileExplorer,
      extensionViewers: [{ extensions: [ext], command: "vi", profile: "WSL" }],
    },
  });
}

describe("FileViewerOverlay", () => {
  beforeEach(() => {
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useFileViewerStore.setState({ open: false, path: "", maximized: false });
  });

  it("renders nothing when closed", () => {
    render(<FileViewerOverlay />);
    expect(screen.queryByTestId("file-viewer-overlay")).not.toBeInTheDocument();
  });

  it("closes on Escape for a web viewer", () => {
    act(() => {
      useFileViewerStore.getState().openFileViewer("/home/user/a.txt");
    });
    render(<FileViewerOverlay />);
    expect(screen.getByTestId("file-viewer-overlay")).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(useFileViewerStore.getState().open).toBe(false);
  });

  it("closes on Escape for a terminal (external command) viewer", () => {
    useTerminalViewerFor(".txt");
    act(() => {
      useFileViewerStore.getState().openFileViewer("/home/user/a.txt");
    });
    render(<FileViewerOverlay />);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(useFileViewerStore.getState().open).toBe(false);
  });

  it("closes on backdrop click for a web viewer", () => {
    act(() => {
      useFileViewerStore.getState().openFileViewer("/home/user/a.txt");
    });
    render(<FileViewerOverlay />);
    fireEvent.click(screen.getByTestId("file-viewer-overlay-backdrop"));
    expect(useFileViewerStore.getState().open).toBe(false);
  });

  it("does NOT close on backdrop click for a terminal viewer (avoid losing a session)", () => {
    useTerminalViewerFor(".txt");
    act(() => {
      useFileViewerStore.getState().openFileViewer("/home/user/a.txt");
    });
    render(<FileViewerOverlay />);
    fireEvent.click(screen.getByTestId("file-viewer-overlay-backdrop"));
    expect(useFileViewerStore.getState().open).toBe(true);
  });

  it("always closes via the explicit close button, even for a terminal viewer", () => {
    useTerminalViewerFor(".txt");
    act(() => {
      useFileViewerStore.getState().openFileViewer("/home/user/a.txt");
    });
    render(<FileViewerOverlay />);
    fireEvent.click(screen.getByTestId("file-viewer-overlay-close"));
    expect(useFileViewerStore.getState().open).toBe(false);
  });

  // --- #283: inline path input (empty / "open anywhere" mode) ---
  it("shows an autofocused inline path input when opened with no path", () => {
    act(() => {
      useFileViewerStore.getState().openEmptyFileViewer();
    });
    render(<FileViewerOverlay />);
    const input = screen.getByTestId("file-viewer-overlay-path-input") as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input).toHaveFocus();
    // No file is loaded yet, so the viewer body must not be mounted.
    expect(screen.queryByTestId("mock-file-viewer")).not.toBeInTheDocument();
  });

  it("loads the file when a path is typed and Enter is pressed", () => {
    act(() => {
      useFileViewerStore.getState().openEmptyFileViewer();
    });
    render(<FileViewerOverlay />);
    const input = screen.getByTestId("file-viewer-overlay-path-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  /home/user/note.txt  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    const s = useFileViewerStore.getState();
    expect(s.open).toBe(true);
    expect(s.path).toBe("/home/user/note.txt");
    // The viewer body now renders the loaded file; the address bar stays at the
    // top showing the loaded path (#327).
    expect(screen.getByTestId("mock-file-viewer")).toBeInTheDocument();
    const bar = screen.getByTestId("file-viewer-overlay-path-input") as HTMLInputElement;
    expect(bar.value).toBe("/home/user/note.txt");
  });

  it("loads the file when the load button is clicked", () => {
    act(() => {
      useFileViewerStore.getState().openEmptyFileViewer();
    });
    render(<FileViewerOverlay />);
    const input = screen.getByTestId("file-viewer-overlay-path-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "/home/user/b.txt" } });
    fireEvent.click(screen.getByTestId("file-viewer-overlay-path-submit"));
    expect(useFileViewerStore.getState().path).toBe("/home/user/b.txt");
  });

  it("does not load a blank path", () => {
    act(() => {
      useFileViewerStore.getState().openEmptyFileViewer();
    });
    render(<FileViewerOverlay />);
    const input = screen.getByTestId("file-viewer-overlay-path-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    // Still empty mode — input remains, nothing loaded.
    expect(useFileViewerStore.getState().path).toBe("");
    expect(screen.getByTestId("file-viewer-overlay-path-input")).toBeInTheDocument();
  });

  it("Escape closes the overlay while in empty (inline input) mode", () => {
    act(() => {
      useFileViewerStore.getState().openEmptyFileViewer();
    });
    render(<FileViewerOverlay />);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(useFileViewerStore.getState().open).toBe(false);
  });

  it("Escape closes the overlay even when the address bar input is focused in prompt mode", () => {
    act(() => {
      useFileViewerStore.getState().openEmptyFileViewer();
    });
    render(<FileViewerOverlay />);
    const input = screen.getByTestId("file-viewer-overlay-path-input") as HTMLInputElement;
    input.focus();
    // In prompt mode there is no draft to revert, so the bar's keydown handler
    // must NOT consume Escape — it bubbles to the global handler and closes.
    fireEvent.keyDown(input, { key: "Escape" });
    expect(useFileViewerStore.getState().open).toBe(false);
  });

  // --- #327 / #326: persistent address bar ---
  it("shows the current path in an editable address bar once a file is loaded (#327)", () => {
    act(() => {
      useFileViewerStore.getState().openFileViewer("/home/user/a.txt");
    });
    render(<FileViewerOverlay />);
    const input = screen.getByTestId("file-viewer-overlay-path-input") as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.value).toBe("/home/user/a.txt");
    // The bar must not steal focus from the loaded viewer (terminal apps etc.).
    expect(input).not.toHaveFocus();
    expect(screen.getByTestId("mock-file-viewer")).toBeInTheDocument();
  });

  it("navigates to another file when a new path is typed and Enter is pressed (#326)", () => {
    act(() => {
      useFileViewerStore.getState().openFileViewer("/home/user/a.txt");
    });
    render(<FileViewerOverlay />);
    const input = screen.getByTestId("file-viewer-overlay-path-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "/home/user/b.txt" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(useFileViewerStore.getState().path).toBe("/home/user/b.txt");
    expect(screen.getByTestId("mock-file-viewer").getAttribute("data-path")).toBe(
      "/home/user/b.txt",
    );
  });

  it("preserves maximized state when navigating via the address bar", () => {
    act(() => {
      useFileViewerStore.getState().openFileViewer("/home/user/a.txt", { maximized: true });
    });
    render(<FileViewerOverlay />);
    const input = screen.getByTestId("file-viewer-overlay-path-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "/home/user/b.txt" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(useFileViewerStore.getState().path).toBe("/home/user/b.txt");
    expect(useFileViewerStore.getState().maximized).toBe(true);
  });

  it("keeps the current file and restores the bar when a blank path is submitted", () => {
    act(() => {
      useFileViewerStore.getState().openFileViewer("/home/user/a.txt");
    });
    render(<FileViewerOverlay />);
    const input = screen.getByTestId("file-viewer-overlay-path-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(useFileViewerStore.getState().path).toBe("/home/user/a.txt");
    expect(input.value).toBe("/home/user/a.txt");
  });

  it("Escape inside the address bar reverts the draft without closing the overlay", () => {
    act(() => {
      useFileViewerStore.getState().openFileViewer("/home/user/a.txt");
    });
    render(<FileViewerOverlay />);
    const input = screen.getByTestId("file-viewer-overlay-path-input") as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: "/tmp/draft.txt" } });
    fireEvent.keyDown(input, { key: "Escape" });

    // The overlay stays open (Escape was consumed by the bar) and the draft is
    // reverted to the currently loaded path.
    expect(useFileViewerStore.getState().open).toBe(true);
    expect(input.value).toBe("/home/user/a.txt");
  });

  it("updates the address bar when the path is swapped externally (MCP re-open)", () => {
    act(() => {
      useFileViewerStore.getState().openFileViewer("/home/user/a.txt");
    });
    const { rerender } = render(<FileViewerOverlay />);
    act(() => {
      useFileViewerStore.getState().openFileViewer("/home/user/b.txt");
    });
    rerender(<FileViewerOverlay />);
    const input = screen.getByTestId("file-viewer-overlay-path-input") as HTMLInputElement;
    expect(input.value).toBe("/home/user/b.txt");
  });

  it("forwards a per-path viewer instance id so a new path remounts the viewer terminal", () => {
    const eventNameSafe = /^[a-zA-Z0-9/:_-]+$/;
    act(() => {
      useFileViewerStore.getState().openFileViewer("/home/user/a.txt");
    });
    const { rerender } = render(<FileViewerOverlay />);
    const idA = screen.getByTestId("mock-file-viewer").getAttribute("data-instance-id");
    // The id is the sanitized viewer instance id (path with event-name-illegal
    // chars replaced + hash suffix), not the raw path — see viewerInstanceId.
    expect(idA).toBe(viewerInstanceId("/home/user/a.txt"));
    expect(eventNameSafe.test(`terminal-output-${idA}`)).toBe(true);

    act(() => {
      // Re-open a different file WITHOUT closing first (MCP/REST/Explorer can do
      // this). The forwarded id must change so the viewer terminal is rebuilt
      // rather than reusing the previous file's session.
      useFileViewerStore.getState().openFileViewer("/home/user/b.txt");
    });
    rerender(<FileViewerOverlay />);
    const idB = screen.getByTestId("mock-file-viewer").getAttribute("data-instance-id");
    expect(idB).toBe(viewerInstanceId("/home/user/b.txt"));
    expect(eventNameSafe.test(`terminal-output-${idB}`)).toBe(true);
    expect(idB).not.toBe(idA);
  });
});
