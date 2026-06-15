import { create } from "zustand";

/**
 * Global state for the inline workspace-rename overlay (#339).
 *
 * Native `window.prompt` does not work on Windows/WebView2 (same root cause
 * #283 fixed for the file viewer), so the `workspace.rename` shortcut and the
 * in-app rename buttons funnel through this store instead. A single overlay is
 * rendered once at the app root (see RenameWorkspaceOverlay) and shown whenever
 * `targetId` is set. Because it is an in-app input — not a native dialog — it
 * works on every platform and is driveable via the Automation API.
 *
 * This is transient UI state, not user configuration: it lives in memory only
 * and is never persisted to settings.json.
 */
interface RenameWorkspaceState {
  /** Workspace id currently being renamed, or null when the overlay is closed. */
  targetId: string | null;
  /** The workspace's current name, used to seed the input field. */
  currentName: string;

  /** Open the rename overlay for the given workspace. */
  openRename: (id: string, currentName: string) => void;
  /** Close the rename overlay without applying a change. */
  closeRename: () => void;
}

export const useRenameWorkspaceStore = create<RenameWorkspaceState>()((set) => ({
  targetId: null,
  currentName: "",

  openRename: (id, currentName) => set({ targetId: id, currentName }),
  closeRename: () => set({ targetId: null, currentName: "" }),
}));
