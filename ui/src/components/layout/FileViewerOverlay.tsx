import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useFileViewerStore } from "@/stores/file-viewer-store";
import { useSettingsStore } from "@/stores/settings-store";
import { FileViewer } from "@/components/ui/FileViewer";
import { FocusInput } from "@/components/ui/FormControls";
import { resolveViewer, viewerInstanceId } from "@/lib/file-viewer";

/**
 * The single global floating file viewer (#277 / #279). It is rendered once at
 * the app root and shown whenever `useFileViewerStore.open` is true — from the
 * File Explorer, the global "open anywhere" shortcut, or the MCP
 * `open_file_viewer` tool. Because it is a portal overlay rather than pane
 * content, it is no longer limited to a pane's size (the #277 complaint).
 */
export function FileViewerOverlay() {
  const open = useFileViewerStore((s) => s.open);
  const path = useFileViewerStore((s) => s.path);
  const maximized = useFileViewerStore((s) => s.maximized);
  const closeFileViewer = useFileViewerStore((s) => s.closeFileViewer);
  const toggleMaximized = useFileViewerStore((s) => s.toggleMaximized);
  const openFileViewer = useFileViewerStore((s) => s.openFileViewer);

  const feSettings = useSettingsStore((s) => s.fileExplorer);
  const extensionViewers = useSettingsStore((s) => s.fileExplorer.extensionViewers);

  // Persistent address bar (#327 / #326): the path input at the top is always
  // shown. With no file loaded yet ("open anywhere" mode, #283) it starts empty
  // and autofocused; once a file is open it shows the current path and the user
  // can type another path + Enter to navigate without closing first (#326).
  // The input is uncontrolled (read via ref on submit) and keyed by `path`, so
  // an external path swap (MCP/REST/Explorer) remounts it with the new value —
  // no keystroke mirroring into React state is needed.
  const promptMode = open && path === "";
  const pathInputRef = useRef<HTMLInputElement>(null);

  // Focus the field each time we (re)enter prompt mode. Once a file is loaded
  // the bar must NOT steal focus (terminal viewers own the keyboard), so this
  // only fires for the empty prompt session.
  useEffect(() => {
    if (promptMode) pathInputRef.current?.focus();
  }, [promptMode]);

  const submitPath = () => {
    // openFileViewer normalizes and rejects blank input; `maximized` is carried
    // over so navigating from a maximized viewer stays maximized.
    const ok = openFileViewer(pathInputRef.current?.value ?? "", { maximized });
    if (pathInputRef.current) {
      // Sync the bar with the store: on success this shows the normalized path,
      // on a blank/invalid submit it restores the currently loaded path (or
      // stays empty in prompt mode). On success also release the keyboard so
      // the opened viewer (e.g. a terminal app) gets it.
      // Note: when the submit changes `path`, the keyed input remounts and these
      // writes hit the detached old node (harmless — the new node mounts with the
      // new path, unfocused). They only matter when NO remount happens: a blank /
      // invalid submit (restore the bar) or re-submitting the same path (blur).
      pathInputRef.current.value = useFileViewerStore.getState().path;
      if (ok) pathInputRef.current.blur();
    }
  };

  const onPathInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitPath();
      return;
    }
    if (e.key === "Escape" && !promptMode) {
      // While a file is loaded, Escape in the bar only reverts the draft to the
      // current path and blurs — it must not close the overlay. The global
      // Escape handler already skips this case (it ignores Escape whose target
      // is the loaded-mode address bar), so we just do the revert here. In
      // prompt mode there is nothing to revert, so Escape falls through to the
      // global handler and closes.
      e.preventDefault();
      if (pathInputRef.current) {
        pathInputRef.current.value = path;
        pathInputRef.current.blur();
      }
    }
  };

  // When the file is shown via an external command (e.g. .txt→vi, video→mpv),
  // FileViewer renders a live TerminalView. A stray backdrop click should still
  // not discard that session; Escape, however, is the viewer-wide close gesture.
  const isTerminalViewer = open && resolveViewer(path, extensionViewers).viewerType === "terminal";

  // Esc closes the viewer globally while it is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Loaded-file address bar Escape reverts the draft instead of closing.
      if (e.target === pathInputRef.current && !promptMode) return;
      e.preventDefault();
      closeFileViewer();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, promptMode, closeFileViewer]);

  if (!open) return null;

  const bodyStyle: React.CSSProperties = {
    paddingTop: feSettings.paddingTop,
    paddingRight: feSettings.paddingRight,
    paddingBottom: feSettings.paddingBottom,
    paddingLeft: feSettings.paddingLeft,
    fontFamily: feSettings.fontFamily || "inherit",
    fontSize: feSettings.fontSize,
  };

  const panelSize = maximized ? "w-screen h-screen rounded-none" : "w-[90vw] h-[90vh]";

  return createPortal(
    <div
      data-testid="file-viewer-overlay"
      data-screenshot-occluder="true"
      className="fixed inset-0 flex items-center justify-center"
      style={{ zIndex: 9997 }}
    >
      <div
        data-testid="file-viewer-overlay-backdrop"
        className="absolute inset-0"
        style={{ background: "var(--backdrop-heavy)" }}
        onClick={isTerminalViewer ? undefined : closeFileViewer}
      />
      <div
        className={`relative z-10 flex flex-col overflow-hidden shadow-2xl ${maximized ? "" : "rounded-lg"} ${panelSize}`}
        style={{
          background: "var(--bg-surface, #181825)",
          border: "1px solid var(--border, #333)",
        }}
      >
        <div
          className="flex items-center px-3 py-2"
          style={{ borderBottom: "1px solid var(--border)" }}
        >
          <div className="flex flex-1 items-center gap-2">
            <FocusInput
              // Keyed by path: an external swap (MCP/REST/Explorer) remounts the
              // uncontrolled input with the new path as its value.
              key={`file-viewer-path-input:${path}`}
              ref={pathInputRef}
              defaultValue={path}
              autoFocus={promptMode}
              onKeyDown={onPathInputKeyDown}
              placeholder="Open file (absolute path)…"
              spellCheck={false}
              autoComplete="off"
              aria-label="File path"
              data-testid="file-viewer-overlay-path-input"
            />
            <button
              type="button"
              onClick={submitPath}
              className="hover-bg-strong rounded px-2 py-1 text-xs"
              style={{
                color: "var(--text-primary)",
                border: "1px solid var(--border)",
                cursor: "pointer",
              }}
              data-testid="file-viewer-overlay-path-submit"
            >
              Open
            </button>
          </div>
          <button
            onClick={toggleMaximized}
            className="hover-bg-strong ml-2 flex h-6 w-6 items-center justify-center rounded text-xs"
            style={{ color: "var(--text-secondary)", border: "none", cursor: "pointer" }}
            title={maximized ? "Restore" : "Maximize (fill window)"}
            data-testid="file-viewer-overlay-maximize"
          >
            {maximized ? "🗗" : "🗖"}
          </button>
          <button
            onClick={closeFileViewer}
            className="hover-bg-strong ml-1 flex h-6 w-6 items-center justify-center rounded text-sm"
            style={{ color: "var(--text-secondary)", border: "none", cursor: "pointer" }}
            title="Close (Esc)"
            data-testid="file-viewer-overlay-close"
          >
            &#10005;
          </button>
        </div>
        <div
          className="flex min-h-0 flex-1 overflow-auto"
          style={{ background: "var(--bg-surface, #181825)" }}
        >
          {promptMode ? (
            <div
              className="flex h-full items-center justify-center px-6 text-center text-xs"
              style={{ color: "var(--text-secondary)" }}
              data-testid="file-viewer-overlay-empty"
            >
              Enter an absolute file path above and press Enter to open it here.
            </div>
          ) : (
            <FileViewer
              path={path}
              // Key the viewer terminal by path so re-opening a different file
              // (MCP/REST/Explorer can swap `path` without closing first) rebuilds
              // the TerminalView instead of reusing the previous file's session.
              // The session-spawn effect keys off instanceId, so a fresh id tears
              // down the old PTY and runs the new startup command. Web viewers
              // ignore the id, so this is harmless for them.
              viewerInstanceId={viewerInstanceId(path)}
              isFocused
              bodyStyle={bodyStyle}
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
