import { describe, it, expect, beforeEach } from "vitest";
import { useFileViewerStore } from "./file-viewer-store";

beforeEach(() => {
  useFileViewerStore.setState({ open: false, path: "", maximized: false });
});

describe("file-viewer-store", () => {
  it("opens with a normalized path", () => {
    const ok = useFileViewerStore.getState().openFileViewer('  "/tmp/a.txt"  ');
    expect(ok).toBe(true);
    const s = useFileViewerStore.getState();
    expect(s.open).toBe(true);
    expect(s.path).toBe("/tmp/a.txt");
    expect(s.maximized).toBe(false);
  });

  it("refuses to open a blank path", () => {
    const ok = useFileViewerStore.getState().openFileViewer("   ");
    expect(ok).toBe(false);
    expect(useFileViewerStore.getState().open).toBe(false);
  });

  it("opens maximized when requested", () => {
    useFileViewerStore.getState().openFileViewer("/tmp/a.txt", { maximized: true });
    expect(useFileViewerStore.getState().maximized).toBe(true);
  });

  it("closes and clears the path", () => {
    useFileViewerStore.getState().openFileViewer("/tmp/a.txt");
    useFileViewerStore.getState().closeFileViewer();
    const s = useFileViewerStore.getState();
    expect(s.open).toBe(false);
    expect(s.path).toBe("");
  });

  it("toggles maximized", () => {
    useFileViewerStore.getState().openFileViewer("/tmp/a.txt");
    useFileViewerStore.getState().toggleMaximized();
    expect(useFileViewerStore.getState().maximized).toBe(true);
    useFileViewerStore.getState().toggleMaximized();
    expect(useFileViewerStore.getState().maximized).toBe(false);
  });

  it("re-opening replaces the path and resets maximized to the new value", () => {
    useFileViewerStore.getState().openFileViewer("/tmp/a.txt", { maximized: true });
    useFileViewerStore.getState().openFileViewer("/tmp/b.txt");
    const s = useFileViewerStore.getState();
    expect(s.path).toBe("/tmp/b.txt");
    expect(s.maximized).toBe(false);
  });

  it("opens an empty viewer (prompt mode) with no path", () => {
    // #283: Ctrl+Shift+O opens the overlay with a blank inline path input
    // instead of a native window.prompt dialog.
    const ok = useFileViewerStore.getState().openEmptyFileViewer();
    expect(ok).toBe(true);
    const s = useFileViewerStore.getState();
    expect(s.open).toBe(true);
    expect(s.path).toBe("");
    expect(s.maximized).toBe(false);
  });

  it("openEmptyFileViewer does not clobber a maximized request", () => {
    useFileViewerStore.getState().openEmptyFileViewer({ maximized: true });
    const s = useFileViewerStore.getState();
    expect(s.open).toBe(true);
    expect(s.path).toBe("");
    expect(s.maximized).toBe(true);
  });

  it("loading a path from the empty viewer fills it in", () => {
    useFileViewerStore.getState().openEmptyFileViewer();
    const ok = useFileViewerStore.getState().openFileViewer("/tmp/c.txt");
    expect(ok).toBe(true);
    const s = useFileViewerStore.getState();
    expect(s.open).toBe(true);
    expect(s.path).toBe("/tmp/c.txt");
  });
});
