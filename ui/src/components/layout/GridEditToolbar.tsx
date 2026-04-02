import { useCallback, useEffect, useState } from "react";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useDockStore } from "@/stores/dock-store";
import { useUiStore } from "@/stores/ui-store";
import type { DockPosition } from "@/stores/types";
import logoSvg from "@/assets/logo.svg";

/** Window control helpers — lazy-loaded to avoid SSR/test issues */
async function getWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

export function GridEditToolbar() {
  const exportAsNewLayout = useWorkspaceStore((s) => s.exportAsNewLayout);
  const exportToLayout = useWorkspaceStore((s) => s.exportToLayout);
  const layouts = useWorkspaceStore((s) => s.layouts);
  const toggleSettingsModal = useUiStore((s) => s.toggleSettingsModal);
  const docks = useDockStore((s) => s.docks);
  const toggleDockVisible = useDockStore((s) => s.toggleDockVisible);
  const layoutMode = useDockStore((s) => s.layoutMode);
  const toggleLayoutMode = useDockStore((s) => s.toggleLayoutMode);

  const [maximized, setMaximized] = useState(false);

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

  const btnBase =
    "cursor-pointer rounded px-2 text-[11px] font-medium transition-colors duration-100";

  const btnH = { height: 22 };

  const btnStyle: React.CSSProperties = {
    ...btnH,
    border: "1px solid rgba(255,255,255,0.08)",
    color: "var(--text-secondary)",
    background: "transparent",
    borderRadius: 2,
  };

  const hoverIn = (e: React.MouseEvent) => {
    (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.06)";
  };
  const hoverOut = (e: React.MouseEvent) => {
    (e.currentTarget as HTMLElement).style.background = "transparent";
  };

  return (
    <div
      data-testid="grid-edit-toolbar"
      className="flex items-center"
      style={{
        height: 28,
        background: "var(--bg-surface)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      {/* Left: App controls (non-draggable) */}
      <div className="flex shrink-0 items-center gap-1.5 px-2">
        <img
          src={logoSvg}
          alt="Laymux"
          style={{ height: 16, width: 16, marginLeft: 4, marginRight: 4 }}
          draggable={false}
        />

        <div
          className="mx-1"
          style={{ width: 1, height: 14, background: "rgba(255,255,255,0.08)" }}
        />

        <button
          data-testid="export-new-btn"
          onClick={() => {
            const name = window.prompt("New layout name:");
            if (name?.trim()) exportAsNewLayout(name.trim());
          }}
          className={btnBase}
          style={btnStyle}
          onMouseEnter={hoverIn}
          onMouseLeave={hoverOut}
        >
          Export New
        </button>
        {layouts.length > 0 && (
          <select
            data-testid="export-overwrite-select"
            className={btnBase}
            style={{ ...btnStyle, cursor: "pointer", minWidth: 90 }}
            defaultValue=""
            onChange={(e) => {
              if (e.target.value) {
                exportToLayout(e.target.value);
                e.target.value = "";
              }
            }}
          >
            <option value="" disabled>
              Overwrite...
            </option>
            {layouts.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Center: Drag region — fills remaining space */}
      <div
        data-tauri-drag-region="true"
        className="min-w-0 flex-1 self-stretch"
        onDoubleClick={handleToggleMaximize}
      />

      {/* Right: Dock toggles + settings + window controls */}
      <div className="flex shrink-0 items-center gap-1 px-1">
        {/* Dock toggles as a compact cross: ◀ [▲▼] ▶ */}
        <div className="flex items-center">
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
          className="flex h-5 cursor-pointer items-center justify-center rounded px-1.5 text-[10px] font-medium"
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

        <div
          className="mx-1"
          style={{ width: 1, height: 14, background: "rgba(255,255,255,0.08)" }}
        />

        <button
          data-testid="settings-gear-btn"
          onClick={toggleSettingsModal}
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-xs"
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
          className="flex h-full w-[46px] cursor-pointer items-center justify-center"
          style={{
            color: "var(--text-secondary)",
            background: "transparent",
            border: "none",
            fontFamily: "'Segoe Fluent Icons', 'Segoe MDL2 Assets'",
            fontSize: 10,
          }}
          title="Minimize"
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "rgba(255,255,255,0.06)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
          }}
        >
          {"\uE921"}
        </button>
        <button
          data-testid="window-maximize"
          onClick={handleToggleMaximize}
          className="flex h-full w-[46px] cursor-pointer items-center justify-center"
          style={{
            color: "var(--text-secondary)",
            background: "transparent",
            border: "none",
            fontFamily: "'Segoe Fluent Icons', 'Segoe MDL2 Assets'",
            fontSize: 10,
          }}
          title={maximized ? "Restore" : "Maximize"}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "rgba(255,255,255,0.06)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
          }}
        >
          {maximized ? "\uE923" : "\uE922"}
        </button>
        <button
          data-testid="window-close"
          onClick={handleClose}
          className="flex h-full w-[46px] cursor-pointer items-center justify-center"
          style={{
            color: "var(--text-secondary)",
            background: "transparent",
            border: "none",
            fontFamily: "'Segoe Fluent Icons', 'Segoe MDL2 Assets'",
            fontSize: 10,
          }}
          title="Close"
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "#c42b1c";
            e.currentTarget.style.color = "#fff";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "var(--text-secondary)";
          }}
        >
          {"\uE8BB"}
        </button>
      </div>
    </div>
  );
}
