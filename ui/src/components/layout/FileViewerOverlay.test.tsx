import { render, screen, act, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { FileViewerOverlay } from "./FileViewerOverlay";
import { useFileViewerStore } from "@/stores/file-viewer-store";
import { useSettingsStore } from "@/stores/settings-store";

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
      extensionViewers: [{ extensions: [ext], command: "vi" }],
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

  it("does NOT close on Escape for a terminal (external command) viewer", () => {
    // .txt is configured to open in `vi` — Escape must reach the terminal app
    // (e.g. leave vi insert mode), not dismiss the overlay.
    useTerminalViewerFor(".txt");
    act(() => {
      useFileViewerStore.getState().openFileViewer("/home/user/a.txt");
    });
    render(<FileViewerOverlay />);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(useFileViewerStore.getState().open).toBe(true);
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
    // The viewer body now renders the loaded file; the input is gone.
    expect(screen.getByTestId("mock-file-viewer")).toBeInTheDocument();
    expect(screen.queryByTestId("file-viewer-overlay-path-input")).not.toBeInTheDocument();
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

  it("does not show the inline input once a file is loaded", () => {
    act(() => {
      useFileViewerStore.getState().openFileViewer("/home/user/a.txt");
    });
    render(<FileViewerOverlay />);
    expect(screen.queryByTestId("file-viewer-overlay-path-input")).not.toBeInTheDocument();
    expect(screen.getByTestId("mock-file-viewer")).toBeInTheDocument();
  });

  it("forwards a per-path viewer instance id so a new path remounts the viewer terminal", () => {
    act(() => {
      useFileViewerStore.getState().openFileViewer("/home/user/a.txt");
    });
    const { rerender } = render(<FileViewerOverlay />);
    const idA = screen.getByTestId("mock-file-viewer").getAttribute("data-instance-id");
    expect(idA).toContain("/home/user/a.txt");

    act(() => {
      // Re-open a different file WITHOUT closing first (MCP/REST/Explorer can do
      // this). The forwarded id must change so the viewer terminal is rebuilt
      // rather than reusing the previous file's session.
      useFileViewerStore.getState().openFileViewer("/home/user/b.txt");
    });
    rerender(<FileViewerOverlay />);
    const idB = screen.getByTestId("mock-file-viewer").getAttribute("data-instance-id");
    expect(idB).toContain("/home/user/b.txt");
    expect(idB).not.toBe(idA);
  });
});
