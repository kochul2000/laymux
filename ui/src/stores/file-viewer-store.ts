import { create } from "zustand";
import { normalizeViewerPath } from "@/lib/file-viewer";

/**
 * Global file-viewer overlay state. A single floating viewer is shared by every
 * entry point (#277 / #279): the File Explorer "open" action, the global
 * "open anywhere" shortcut, and the MCP `open_file_viewer` tool all funnel
 * through `openFileViewer`. The overlay is rendered once in AppLayout, so it
 * escapes the size of any individual pane (the #277 complaint).
 */
interface FileViewerState {
  /** Whether the floating viewer overlay is visible. */
  open: boolean;
  /** Normalized path of the file being viewed ("" when closed). */
  path: string;
  /**
   * When true the overlay fills the whole app window (the "new window" feel of
   * #277). When false it is a large but centered floating overlay. We render in
   * the existing single Tauri window rather than spawning a second OS window —
   * see docs/architecture/api-contracts.md §15 / the PR notes for the rationale.
   */
  maximized: boolean;
  /**
   * Identity of this store instance, fixed when the module loads. A webview
   * reload or an app restart picks a new one, so `(openEpoch, openRevision)`
   * never repeats across desktop lifetimes (ADR-0291).
   */
  openEpoch: string;
  /**
   * Number of successful `openFileViewer` calls in this epoch. Re-opening the
   * same path still counts: Remote shows an unread dot for every file the PC
   * puts on screen, and an agent re-showing a regenerated file is new to look
   * at. The empty viewer, close and maximize do not count (ADR-0291).
   */
  openRevision: number;

  /**
   * Open the viewer for `path`. Returns false (and does nothing) when the path
   * normalizes to empty, so callers (MCP tool, REST/automation) can report a
   * validation error.
   */
  openFileViewer: (path: string, opts?: { maximized?: boolean }) => boolean;
  /**
   * Open the overlay with no file loaded (#283). The overlay then shows an
   * inline path input field instead of a native `window.prompt`, so the
   * "open anywhere" shortcut (Ctrl+Shift+O) works on every platform and is
   * driveable via the Automation API. Always succeeds. Call `openFileViewer`
   * once the user submits a path.
   */
  openEmptyFileViewer: (opts?: { maximized?: boolean }) => boolean;
  closeFileViewer: () => void;
  toggleMaximized: () => void;
}

export const useFileViewerStore = create<FileViewerState>()((set) => ({
  open: false,
  path: "",
  maximized: false,
  openEpoch: crypto.randomUUID(),
  openRevision: 0,

  openFileViewer: (path, opts) => {
    const normalized = normalizeViewerPath(path);
    if (!normalized) return false;
    set((s) => ({
      open: true,
      path: normalized,
      maximized: opts?.maximized ?? false,
      openRevision: s.openRevision + 1,
    }));
    return true;
  },
  openEmptyFileViewer: (opts) => {
    set({ open: true, path: "", maximized: opts?.maximized ?? false });
    return true;
  },

  closeFileViewer: () => set({ open: false, path: "" }),
  toggleMaximized: () => set((s) => ({ maximized: !s.maximized })),
}));
