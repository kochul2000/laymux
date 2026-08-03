import { useCallback, useEffect, useState } from "react";
import { useDockStore } from "@/stores/dock-store";
import { useUiStore } from "@/stores/ui-store";
import { useFileViewerStore } from "@/stores/file-viewer-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useRemoteAccessStore } from "@/stores/remote-access-store";
import type { DockPosition } from "@/stores/types";
import { WidgetSlot } from "@/components/widgets/WidgetSlot";
import { SleepPreventionToggle } from "./SleepPreventionToggle";
import logoSvg from "@/assets/logo.svg";

/**
 * Width the window drag region keeps no matter how many widgets are placed.
 * Without it a full top bar would leave nothing to grab the window by.
 */
const MIN_DRAG_REGION_PX = 80;

/** Window control helpers — lazy-loaded to avoid SSR/test issues */
async function getWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

export function GridEditToolbar() {
  const toggleSettingsModal = useUiStore((s) => s.toggleSettingsModal);
  const toggleRemoteAccessModal = useUiStore((s) => s.toggleRemoteAccessModal);
  const openEmptyFileViewer = useFileViewerStore((s) => s.openEmptyFileViewer);
  const remote = useSettingsStore((s) => s.remote);
  const remoteAccessStatus = useRemoteAccessStore((s) => s.status);
  const docks = useDockStore((s) => s.docks);
  const toggleDockVisible = useDockStore((s) => s.toggleDockVisible);
  const widgets = useSettingsStore((s) => s.widgets);
  const layoutMode = useDockStore((s) => s.layoutMode);
  const toggleLayoutMode = useDockStore((s) => s.toggleLayoutMode);

  const [maximized, setMaximized] = useState(false);
  const remoteEnabled = remoteAccessStatus?.effectiveEnabled ?? remote.enabled;
  const remoteTokenConfigured =
    remoteAccessStatus?.authTokenConfigured ?? remote.authToken.trim().length > 0;
  const remoteButtonColor = remoteEnabled
    ? remoteTokenConfigured
      ? "var(--accent)"
      : "var(--claude)"
    : "var(--text-secondary)";
  const remoteButtonTitle = remoteEnabled
    ? remoteTokenConfigured
      ? "Remote Access"
      : "Remote Access (token missing)"
    : "Remote Access (disabled)";

  useEffect(() => {
    getWindow()
      .then((w) => w.isMaximized().then(setMaximized))
      .catch(() => {});
  }, []);

  const handleMinimize = useCallback(() => {
    getWindow()
      .then((w) => w.minimize())
      .catch(() => {});
  }, []);

  const handleToggleMaximize = useCallback(() => {
    getWindow()
      .then((w) => w.toggleMaximize().then(() => w.isMaximized().then(setMaximized)))
      .catch(() => {});
  }, []);

  const handleClose = useCallback(() => {
    getWindow()
      .then((w) => w.close())
      .catch(() => {});
  }, []);

  /** Dock position icons: rectangle with highlighted edge showing dock location */
  const dockIcons: Record<DockPosition, React.ReactNode> = {
    left: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <rect x="1" y="1" width="12" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
        <rect x="1" y="1" width="4" height="12" rx="1" fill="currentColor" opacity="0.5" />
      </svg>
    ),
    top: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <rect x="1" y="1" width="12" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
        <rect x="1" y="1" width="12" height="4" rx="1" fill="currentColor" opacity="0.5" />
      </svg>
    ),
    bottom: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <rect x="1" y="1" width="12" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
        <rect x="1" y="9" width="12" height="4" rx="1" fill="currentColor" opacity="0.5" />
      </svg>
    ),
    right: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <rect x="1" y="1" width="12" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
        <rect x="9" y="1" width="4" height="12" rx="1" fill="currentColor" opacity="0.5" />
      </svg>
    ),
  };

  return (
    <div
      data-testid="grid-edit-toolbar"
      className="ui-toolbar"
      style={{
        background: "var(--bg-surface)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      {/* Left: App controls (non-draggable). Clips from its far end rather than
          pushing the window controls off the bar (ADR-0123). */}
      <div className="flex min-w-0 items-center gap-1.5 overflow-hidden px-2">
        <img
          src={logoSvg}
          alt="Laymux"
          className="shrink-0"
          style={{ height: 16, width: 16, marginLeft: 4, marginRight: 4 }}
          draggable={false}
        />
      </div>

      {/* Left widget slot — shrinks before the drag region does */}
      <WidgetSlot slot={{ surface: "topBar", side: "left" }} instances={widgets.topBar.left} />

      {/* Center: Drag region. It shares the free space with the two slots but
          keeps `MIN_DRAG_REGION_PX` no matter how full they are, so a crowded
          top bar costs widgets rather than the ability to move the window
          (ADR-0105). Double-click to maximize lives here, not on the slots. */}
      <div
        data-tauri-drag-region="true"
        className="self-stretch"
        style={{ flex: "1 1 0%", minWidth: MIN_DRAG_REGION_PX }}
        onDoubleClick={handleToggleMaximize}
      />

      {/* Right widget slot — sits left of the control cluster: widgets inform,
          the buttons beyond act. */}
      <WidgetSlot slot={{ surface: "topBar", side: "right" }} instances={widgets.topBar.right} />

      {/* Right: Dock toggles + settings. Right-aligned inside a clipping box, so
          a narrow bar sheds the dock cross first and keeps the controls nearest
          the window buttons — never the window buttons themselves (ADR-0123). */}
      <div className="flex min-w-0 items-center justify-end gap-1 overflow-hidden px-1">
        {/* Dock toggles as a compact cross: ◀ [▲▼] ▶ */}
        <div className="flex shrink-0 items-center">
          {(["left", "top", "bottom", "right"] as DockPosition[]).map((pos) => {
            const dock = docks.find((d) => d.position === pos);
            const isVisible = dock?.visible ?? true;
            return (
              <button
                key={pos}
                data-testid={`dock-toggle-${pos}`}
                onClick={() => toggleDockVisible(pos)}
                className="flex h-5 w-5 cursor-pointer items-center justify-center text-[11px] leading-none"
                style={{
                  color: isVisible
                    ? "var(--text-primary)"
                    : "var(--text-muted, var(--text-secondary))",
                  opacity: isVisible ? 0.9 : 0.3,
                  background: "transparent",
                  border: "none",
                }}
                title={`${pos} dock (${isVisible ? "visible" : "hidden"})`}
              >
                {dockIcons[pos]}
              </button>
            );
          })}
        </div>

        <button
          data-testid="dock-layout-mode-toggle"
          onClick={toggleLayoutMode}
          className="flex h-5 shrink-0 cursor-pointer items-center justify-center rounded px-1.5 text-[10px] font-medium"
          style={{
            color: "var(--text-secondary)",
            background: "transparent",
            border: "1px solid var(--border)",
          }}
          title={
            layoutMode === "horizontal"
              ? "Horizontal layout (click to switch)"
              : "Vertical layout (click to switch)"
          }
        >
          {layoutMode === "horizontal" ? "H" : "V"}
        </button>

        <div className="ui-sep" />

        <button
          data-testid="file-viewer-btn"
          onClick={() => openEmptyFileViewer()}
          className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded"
          style={{
            color: "var(--text-secondary)",
            background: "transparent",
            border: "none",
            fontFamily: "'Segoe Fluent Icons', 'Segoe MDL2 Assets'",
            fontSize: "var(--fs-xs)",
          }}
          title="Open File Viewer (Ctrl+Shift+O)"
        >
          {"\uE8A5"}
        </button>

        <SleepPreventionToggle />

        <button
          data-testid="remote-access-btn"
          onClick={toggleRemoteAccessModal}
          className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded"
          style={{
            color: remoteButtonColor,
            background: "transparent",
            border: "none",
            fontFamily: "'Segoe Fluent Icons', 'Segoe MDL2 Assets'",
            fontSize: "var(--fs-xs)",
            opacity: remoteEnabled ? 1 : 0.65,
          }}
          title={remoteButtonTitle}
          aria-label="Remote Access"
        >
          {"\uE703"}
        </button>

        <button
          data-testid="settings-gear-btn"
          onClick={toggleSettingsModal}
          className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-xs"
          style={{
            color: "var(--text-secondary)",
            background: "transparent",
            border: "none",
          }}
          title="Settings (Ctrl+,)"
        >
          &#9881;
        </button>
      </div>

      {/* Window controls — Windows 11 standard: 46px wide, 32px tall */}
      <div className="flex h-full shrink-0">
        <button
          data-testid="window-minimize"
          onClick={handleMinimize}
          className="hover-bg flex h-full w-[46px] cursor-pointer items-center justify-center"
          style={{
            color: "var(--text-secondary)",
            border: "none",
            fontFamily: "'Segoe Fluent Icons', 'Segoe MDL2 Assets'",
            fontSize: "var(--fs-xs)",
          }}
          title="Minimize"
        >
          {"\uE921"}
        </button>
        <button
          data-testid="window-maximize"
          onClick={handleToggleMaximize}
          className="hover-bg flex h-full w-[46px] cursor-pointer items-center justify-center"
          style={{
            color: "var(--text-secondary)",
            border: "none",
            fontFamily: "'Segoe Fluent Icons', 'Segoe MDL2 Assets'",
            fontSize: "var(--fs-xs)",
          }}
          title={maximized ? "Restore" : "Maximize"}
        >
          {maximized ? "\uE923" : "\uE922"}
        </button>
        <button
          data-testid="window-close"
          onClick={handleClose}
          className="hover-bg-danger flex h-full w-[46px] cursor-pointer items-center justify-center"
          style={{
            color: "var(--text-secondary)",
            border: "none",
            fontFamily: "'Segoe Fluent Icons', 'Segoe MDL2 Assets'",
            fontSize: "var(--fs-xs)",
          }}
          title="Close"
        >
          {"\uE8BB"}
        </button>
      </div>
    </div>
  );
}
