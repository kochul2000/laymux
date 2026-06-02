import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useFileViewerStore } from "@/stores/file-viewer-store";
import { useSettingsStore } from "@/stores/settings-store";
import { FileViewer } from "@/components/ui/FileViewer";

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

  const defaultProfile = useSettingsStore((s) => s.defaultProfile);
  const feSettings = useSettingsStore((s) => s.fileExplorer);

  // Esc closes the viewer globally while it is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeFileViewer();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closeFileViewer]);

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
        onClick={closeFileViewer}
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
          <span
            className="flex-1 truncate text-xs"
            style={{ color: "var(--text-primary)" }}
            data-testid="file-viewer-overlay-path"
          >
            {path}
          </span>
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
          <FileViewer
            path={path}
            profile={defaultProfile}
            viewerInstanceId="global-file-viewer"
            isFocused
            bodyStyle={bodyStyle}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
