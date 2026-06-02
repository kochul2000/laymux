import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useFileViewerStore } from "@/stores/file-viewer-store";
import { useSettingsStore } from "@/stores/settings-store";
import { FileViewer } from "@/components/ui/FileViewer";
import { FocusInput } from "@/components/ui/FormControls";
import { resolveViewer } from "@/lib/file-viewer";

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

  const defaultProfile = useSettingsStore((s) => s.defaultProfile);
  const feSettings = useSettingsStore((s) => s.fileExplorer);
  const extensionViewers = useSettingsStore((s) => s.fileExplorer.extensionViewers);

  // Empty-path "open anywhere" mode (#283): the overlay is open but no file is
  // loaded yet, so we show an inline path input field at the top instead of a
  // native window.prompt (unreliable on WebView2, not driveable via the
  // Automation API). Submitting a non-blank path loads it in the same viewer.
  // The input is uncontrolled (read via ref on submit) so we don't need to
  // mirror keystrokes into React state — this also keeps the focus effect free
  // of setState (react-hooks/set-state-in-effect).
  const promptMode = open && path === "";
  const pathInputRef = useRef<HTMLInputElement>(null);

  // Focus the field each time we (re)enter prompt mode. Keying the input by
  // `promptMode` (below) remounts it empty, so no draft reset is needed.
  useEffect(() => {
    if (promptMode) pathInputRef.current?.focus();
  }, [promptMode]);

  const submitPath = () => {
    // openFileViewer normalizes and rejects blank input, so a blank submit
    // simply keeps the overlay in prompt mode.
    openFileViewer(pathInputRef.current?.value ?? "");
  };

  // When the file is shown via an external command (e.g. .txt→vi, video→mpv),
  // FileViewer renders a live TerminalView. In that mode Esc and a backdrop
  // click must NOT dismiss the overlay: Esc belongs to the terminal app (leaving
  // vi insert mode, quitting less/mpv) and a stray backdrop click would discard
  // an in-progress session. The user closes such viewers with the explicit ✕
  // button instead. Built-in web viewers (text/image/binary) keep the
  // convenient Esc / backdrop dismiss.
  const isTerminalViewer = open && resolveViewer(path, extensionViewers).viewerType === "terminal";

  // Esc closes the (web) viewer globally while it is open.
  useEffect(() => {
    if (!open || isTerminalViewer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeFileViewer();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, isTerminalViewer, closeFileViewer]);

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
          {promptMode ? (
            <div className="flex flex-1 items-center gap-2">
              <FocusInput
                key="file-viewer-path-input"
                ref={pathInputRef}
                defaultValue=""
                autoFocus
                onKeyDown={(e) => {
                  // Enter submits; Escape is handled by the global handler below
                  // so we let it bubble (it closes the overlay).
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitPath();
                  }
                }}
                placeholder="Open file (absolute path)…"
                spellCheck={false}
                autoComplete="off"
                aria-label="File path"
                data-testid="file-viewer-overlay-path-input"
              />
              <button
                onClick={submitPath}
                className="hover-bg-strong rounded px-2 py-1 text-xs"
                style={{
                  color: "var(--text-primary)",
                  border: "1px solid var(--border)",
                  cursor: "pointer",
                }}
                data-testid="file-viewer-overlay-path-submit"
              >
                Load
              </button>
            </div>
          ) : (
            <span
              className="flex-1 truncate text-xs"
              style={{ color: "var(--text-primary)" }}
              data-testid="file-viewer-overlay-path"
            >
              {path}
            </span>
          )}
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
        <div className="min-h-0 flex-1 overflow-auto">
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
              profile={defaultProfile}
              // Key the viewer terminal by path so re-opening a different file
              // (MCP/REST/Explorer can swap `path` without closing first) rebuilds
              // the TerminalView instead of reusing the previous file's session.
              // The session-spawn effect keys off instanceId, so a fresh id tears
              // down the old PTY and runs the new startup command. Web viewers
              // ignore the id, so this is harmless for them.
              viewerInstanceId={`global-file-viewer:${path}`}
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
