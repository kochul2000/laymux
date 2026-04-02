import { useState } from "react";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useGridStore } from "@/stores/grid-store";
import { useNotificationStore } from "@/stores/notification-store";
import { useTerminalStore } from "@/stores/terminal-store";
import { useSettingsStore } from "@/stores/settings-store";
import {
  computeWorkspaceSummary,
  abbreviatePath,
  formatCommand,
  formatRelativeTime,
  formatActivity,
} from "@/lib/workspace-summary";
import { NotificationPanel } from "./NotificationPanel";
import { PaneMinimap } from "./PaneMinimap";
import type { WorkspacePane } from "@/stores/types";

/** Abbreviate profile/view labels to max 3 characters. */
const LABEL_ABBREV: Record<string, string> = {
  PowerShell: "PS",
  WSL: "WSL",
  Ubuntu: "UBT",
  Debian: "DEB",
  Browser: "WEB",
  Empty: "---",
};
function shortLabel(label: string): string {
  return LABEL_ABBREV[label] ?? label.slice(0, 3).toUpperCase();
}

function CountBadge({ count, testId }: { count: number; testId?: string }) {
  return (
    <span
      data-testid={testId}
      className="inline-flex shrink-0 items-center justify-center rounded text-[12px] font-semibold"
      style={{
        background: "var(--accent)",
        color: "var(--bg-base)",
        width: 14,
        height: 14,
        lineHeight: 1,
      }}
    >
      {count}
    </span>
  );
}

function WorkspaceItem({
  ws,
  index,
  isActive,
  summary,
  panes,
  canClose,
  pathEllipsis,
  onSelect,
  onClose,
  onDuplicate,
  onRename,
}: {
  ws: { id: string; name: string };
  index: number;
  isActive: boolean;
  summary: ReturnType<typeof computeWorkspaceSummary>;
  panes: WorkspacePane[];
  canClose: boolean;
  pathEllipsis: "start" | "end";
  onSelect: () => void;
  onClose: () => void;
  onDuplicate: () => void;
  onRename: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const wsDisplay = useSettingsStore((s) => s.workspaceDisplay);

  const cmdInfo = summary.lastCommand;
  const cmdIcon = cmdInfo
    ? cmdInfo.exitCode === undefined
      ? "⏳"
      : cmdInfo.exitCode === 0
        ? "✓"
        : "✗"
    : null;
  const cmdColor = cmdInfo
    ? cmdInfo.exitCode === undefined
      ? "var(--yellow)"
      : cmdInfo.exitCode === 0
        ? "var(--green)"
        : "var(--red)"
    : undefined;

  return (
    <div
      data-testid={`workspace-item-${ws.id}`}
      data-active={isActive ? "true" : "false"}
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="relative mb-0.5 cursor-pointer rounded py-2"
      style={{
        background: isActive
          ? "rgba(137,180,250,0.08)"
          : hovered
            ? "rgba(255,255,255,0.03)"
            : "transparent",
        borderLeft: isActive ? "3px solid var(--accent)" : "3px solid transparent",
        paddingLeft: isActive ? 9 : 9,
        paddingRight: 10,
      }}
    >
      {/* Row 1: Index + Workspace name + terminal count + badge + close */}
      <div data-testid={`ws-row-1-${ws.id}`} className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 truncate">
          {/* Keyboard shortcut index */}
          <span
            className="shrink-0 text-[10px] font-medium"
            style={{
              color: isActive ? "var(--accent)" : "var(--text-primary)",
              opacity: isActive ? 0.9 : 0.6,
              minWidth: 10,
            }}
            title={
              index < 9 ? `Ctrl+Alt+${index + 1}` : index === 8 ? "Ctrl+Alt+9 (last)" : undefined
            }
          >
            {index < 9 ? index + 1 : ""}
          </span>
          <span
            data-testid={`workspace-name-${ws.id}`}
            className="truncate text-sm font-medium"
            style={{ color: isActive ? "var(--text-primary)" : "var(--text-secondary)" }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              onRename();
            }}
          >
            {ws.name}
          </span>
          {summary.terminalCount > 0 && (
            <span
              data-testid={`terminal-count-${ws.id}`}
              className="shrink-0 rounded px-1.5 text-[9px]"
              style={{
                color: "var(--text-secondary)",
                background: "rgba(255,255,255,0.06)",
                opacity: 0.7,
              }}
            >
              {summary.terminalCount}
            </span>
          )}
        </span>
        <span className="flex items-center gap-1">
          {summary.unreadCount > 0 && (
            <CountBadge count={summary.unreadCount} testId={`unread-badge-${ws.id}`} />
          )}
          {hovered && (
            <>
              <button
                data-testid={`workspace-duplicate-${ws.id}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onDuplicate();
                }}
                className="shrink-0 cursor-pointer rounded p-0.5 leading-none opacity-50 hover:opacity-100"
                style={{
                  color: "var(--text-secondary)",
                  background: "transparent",
                  border: "none",
                }}
                title="Duplicate workspace (Ctrl+Alt+D)"
              >
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                  <rect
                    x="0.5"
                    y="2.5"
                    width="7"
                    height="7"
                    rx="1"
                    stroke="currentColor"
                    strokeWidth="1"
                  />
                  <rect
                    x="3"
                    y="0.5"
                    width="7"
                    height="7"
                    rx="1"
                    stroke="currentColor"
                    strokeWidth="1"
                  />
                </svg>
              </button>
              <button
                data-testid={`workspace-rename-${ws.id}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onRename();
                }}
                className="shrink-0 cursor-pointer rounded p-0.5 leading-none opacity-50 hover:opacity-100"
                style={{
                  color: "var(--text-secondary)",
                  background: "transparent",
                  border: "none",
                }}
                title="Rename workspace (Ctrl+Alt+R)"
              >
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                  <path
                    d="M7.5 1.5l2 2-6 6H1.5v-2z"
                    stroke="currentColor"
                    strokeWidth="1"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              {canClose && (
                <button
                  data-testid={`workspace-close-${ws.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose();
                  }}
                  className="shrink-0 cursor-pointer rounded p-0.5 leading-none opacity-50 hover:opacity-100 hover:text-[var(--red)]"
                  style={{
                    color: "var(--text-secondary)",
                    background: "transparent",
                    border: "none",
                  }}
                  title="Close workspace (Ctrl+Alt+W)"
                >
                  <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                    <path
                      d="M2.5 2.5l6 6M8.5 2.5l-6 6"
                      stroke="currentColor"
                      strokeWidth="1.2"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              )}
            </>
          )}
        </span>
      </div>

      {/* Per-pane summaries */}
      {panes.length >= 1 ? (
        <div data-testid={`ws-row-2-${ws.id}`} className="mt-1 flex flex-col gap-0.5">
          {(() => {
            const showMinimap = panes.length >= 1;
            const minimapPanes = panes.map((p) => ({ x: p.x, y: p.y, w: p.w, h: p.h }));
            const gridFocused = isActive ? useGridStore.getState().focusedPaneIndex : null;
            return panes.map((pane, paneIdx) => {
              const paneIndex = showMinimap ? paneIdx : -1;
              const isFocusedPane = isActive && gridFocused === paneIdx;
              if (pane.view.type === "TerminalView") {
                const termId = `terminal-${pane.id}`;
                const ts = summary.terminalSummaries.find((t) => t.id === termId);
                if (!ts) return null;
                const tCmdIcon = ts.lastCommand
                  ? ts.lastExitCode === undefined
                    ? "⏳"
                    : ts.lastExitCode === 0
                      ? "✓"
                      : "✗"
                  : null;
                const tCmdColor = ts.lastCommand
                  ? ts.lastExitCode === undefined
                    ? "var(--yellow)"
                    : ts.lastExitCode === 0
                      ? "var(--green)"
                      : "var(--red)"
                  : undefined;
                const actInfo = formatActivity(ts.activity, ts.title);
                return (
                  <div
                    key={pane.id}
                    className="flex items-center gap-1.5 truncate text-[11px]"
                    style={{
                      paddingLeft: showMinimap && wsDisplay.minimap ? 2 : 18,
                      ...(isFocusedPane
                        ? {
                            background: "rgba(137,180,250,0.12)",
                            borderRadius: 3,
                            filter: "brightness(1.3)",
                          }
                        : {}),
                    }}
                  >
                    {showMinimap && wsDisplay.minimap && (
                      <span
                        className="shrink-0"
                        data-testid={`pane-minimap-${termId}`}
                        style={{ opacity: isFocusedPane ? 1 : 0.5 }}
                      >
                        <PaneMinimap
                          panes={minimapPanes}
                          highlightIndex={paneIndex}
                          width={18}
                          height={12}
                        />
                      </span>
                    )}
                    <div className="flex min-w-0 flex-1 items-center gap-1 truncate">
                      {wsDisplay.environment && (
                        <span
                          className="shrink-0 font-medium"
                          style={{ color: "var(--text-secondary)", opacity: isActive ? 0.9 : 0.7 }}
                        >
                          {shortLabel(ts.label)}
                        </span>
                      )}
                      {wsDisplay.activity && (
                        <span
                          data-testid={`terminal-activity-${ts.id}`}
                          className="shrink-0 rounded px-1 text-[9px]"
                          style={{
                            color: actInfo.color,
                            background:
                              ts.activity?.type === "interactiveApp"
                                ? ts.activity?.name === "Claude"
                                  ? "rgba(217,119,87,0.15)"
                                  : "rgba(137,180,250,0.12)"
                                : "rgba(255,255,255,0.04)",
                            minWidth: 52,
                            textAlign: "center",
                            display: "inline-block",
                            opacity: isActive ? 1 : 0.7,
                          }}
                        >
                          {actInfo.label}
                          {ts.outputActive ? "" : ""}
                        </span>
                      )}
                      {wsDisplay.path && ts.branch && (
                        <>
                          <span style={{ color: "var(--text-secondary)", opacity: 0.3 }}>·</span>
                          <span
                            className="shrink-0"
                            style={{ color: "var(--green)", opacity: isActive ? 1 : 0.7 }}
                          >
                            {ts.branch}
                          </span>
                        </>
                      )}
                      {wsDisplay.path && ts.cwd && (
                        <>
                          <span style={{ color: "var(--text-secondary)", opacity: 0.3 }}>·</span>
                          <span
                            className="truncate"
                            style={{
                              color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
                              opacity: isActive ? 0.7 : 0.5,
                              ...(pathEllipsis === "start"
                                ? { direction: "rtl", textAlign: "left" }
                                : {}),
                            }}
                          >
                            {abbreviatePath(ts.cwd, pathEllipsis)}
                          </span>
                        </>
                      )}
                      {wsDisplay.result && tCmdIcon ? (
                        <span
                          data-testid={`pane-cmd-badge-${ts.id}`}
                          className="shrink-0"
                          style={{
                            color: tCmdColor,
                            border: ts.hasUnreadNotification
                              ? "1.5px solid var(--accent)"
                              : "1.5px solid transparent",
                            borderRadius: 3,
                            padding: "0 1px",
                            lineHeight: 1,
                          }}
                        >
                          {tCmdIcon}
                        </span>
                      ) : wsDisplay.result && ts.hasUnreadNotification ? (
                        <span
                          data-testid={`pane-notif-dot-${ts.id}`}
                          className="shrink-0"
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: "50%",
                            background: "var(--accent)",
                            display: "inline-block",
                          }}
                        />
                      ) : null}
                    </div>
                  </div>
                );
              }
              if (pane.view.type === "BrowserPreviewView") {
                const url = (pane.view.url as string) ?? "";
                const shortUrl = url.replace(/^https?:\/\//, "");
                return (
                  <div
                    key={pane.id}
                    className="flex items-center gap-1.5 truncate text-[11px]"
                    style={{
                      paddingLeft: showMinimap && wsDisplay.minimap ? 2 : 18,
                      ...(isFocusedPane
                        ? {
                            background: "rgba(137,180,250,0.12)",
                            borderRadius: 3,
                            filter: "brightness(1.3)",
                          }
                        : {}),
                    }}
                  >
                    {showMinimap && wsDisplay.minimap && (
                      <span
                        className="shrink-0"
                        data-testid={`pane-minimap-browser-${pane.id}`}
                        style={{ opacity: isFocusedPane ? 1 : 0.5 }}
                      >
                        <PaneMinimap
                          panes={minimapPanes}
                          highlightIndex={paneIndex}
                          width={18}
                          height={12}
                        />
                      </span>
                    )}
                    <div className="flex min-w-0 flex-1 items-center gap-1 truncate">
                      {wsDisplay.environment && (
                        <span
                          className="shrink-0 font-medium"
                          style={{ color: "var(--text-secondary)", opacity: isActive ? 0.9 : 0.7 }}
                        >
                          {shortLabel("Browser")}
                        </span>
                      )}
                      {wsDisplay.activity && (
                        <span
                          className="shrink-0 rounded px-1 text-[9px]"
                          style={{
                            color: "var(--cyan, #94e2d5)",
                            background: "rgba(255,255,255,0.04)",
                            minWidth: 52,
                            textAlign: "center",
                            display: "inline-block",
                            opacity: isActive ? 1 : 0.7,
                          }}
                        >
                          preview
                        </span>
                      )}
                      {wsDisplay.path && shortUrl && (
                        <>
                          <span style={{ color: "var(--text-secondary)", opacity: 0.3 }}>·</span>
                          <span
                            className="truncate"
                            style={{
                              color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
                              opacity: isActive ? 0.7 : 0.5,
                            }}
                          >
                            {shortUrl}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                );
              }
              // EmptyView or other view types
              return (
                <div
                  key={pane.id}
                  className="flex items-center gap-1.5 truncate text-[11px]"
                  style={{
                    paddingLeft: showMinimap && wsDisplay.minimap ? 2 : 18,
                    ...(isFocusedPane
                      ? {
                          background: "rgba(137,180,250,0.08)",
                          borderRadius: 3,
                          color: "var(--text-primary)",
                        }
                      : {}),
                  }}
                >
                  {showMinimap && wsDisplay.minimap && (
                    <span
                      className="shrink-0"
                      data-testid={`pane-minimap-empty-${pane.id}`}
                      style={{ opacity: isFocusedPane ? 1 : 0.5 }}
                    >
                      <PaneMinimap
                        panes={minimapPanes}
                        highlightIndex={paneIndex}
                        width={18}
                        height={12}
                      />
                    </span>
                  )}
                  <div className="flex min-w-0 flex-1 items-center gap-1 truncate">
                    <span
                      className="shrink-0 font-medium"
                      style={{ color: "var(--text-secondary)", opacity: 0.4 }}
                    >
                      {shortLabel("Empty")}
                    </span>
                  </div>
                </div>
              );
            });
          })()}
        </div>
      ) : (
        /* Row 2: Branch + CWD (no views or inactive) — always rendered */
        <div
          data-testid={`ws-row-2-${ws.id}`}
          className="mt-0.5 flex items-center gap-1.5 truncate text-xs"
          style={{ paddingLeft: 18, minHeight: "1.25rem" }}
        >
          {summary.branch && <span style={{ color: "var(--green)" }}>{summary.branch}</span>}
          {summary.branch && summary.cwd && (
            <span style={{ color: "var(--text-secondary)", opacity: 0.3 }}>·</span>
          )}
          {summary.cwd && (
            <span
              className="truncate"
              style={{
                color: "var(--text-secondary)",
                opacity: 0.5,
                ...(pathEllipsis === "start" ? { direction: "rtl", textAlign: "left" } : {}),
              }}
            >
              {abbreviatePath(summary.cwd, pathEllipsis)}
            </span>
          )}
        </div>
      )}

      {/* Row 3: Last command OR notification — always rendered */}
      <div
        data-testid={`ws-row-3-${ws.id}`}
        className="mt-0.5 truncate text-xs"
        style={{ paddingLeft: 18, minHeight: "1.25rem" }}
      >
        {cmdInfo ? (
          <span className="flex items-center gap-1">
            <span data-testid={`cmd-status-${ws.id}`} style={{ color: cmdColor }}>
              {cmdIcon}
            </span>
            <span className="truncate" style={{ color: "var(--text-secondary)" }}>
              {formatCommand(cmdInfo.command)}
            </span>
            <span style={{ color: "var(--text-secondary)", opacity: 0.4 }}>
              · {formatRelativeTime(cmdInfo.timestamp)}
            </span>
          </span>
        ) : summary.latestNotification ? (
          <span
            className="italic"
            style={{
              color:
                summary.latestNotification.level === "error"
                  ? "var(--red)"
                  : summary.latestNotification.level === "success"
                    ? "var(--green)"
                    : summary.latestNotification.level === "warning"
                      ? "var(--yellow)"
                      : "var(--accent)",
            }}
          >
            &ldquo;{summary.latestNotification.message}&rdquo;
          </span>
        ) : null}
      </div>
    </div>
  );
}

function LayoutCard({
  layout,
  isDefault,
  canDelete,
  onClick,
  onRename,
  onDuplicate,
  onDelete,
  onSetDefault,
}: {
  layout: { id: string; name: string; panes: { x: number; y: number; w: number; h: number }[] };
  isDefault: boolean;
  canDelete: boolean;
  onClick: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onSetDefault: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const minimapPanes = layout.panes.map((p) => ({ x: p.x, y: p.y, w: p.w, h: p.h }));

  return (
    <div
      data-testid={`layout-card-${layout.id}`}
      className="relative flex items-center gap-2 rounded px-2 py-1.5"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setMenuOpen(false);
      }}
      style={{
        border: `1px solid ${isDefault && hovered ? "var(--accent)" : hovered ? "var(--text-secondary)" : "transparent"}`,
        background: hovered ? "rgba(137,180,250,0.08)" : "transparent",
        transition: "all 0.15s",
        opacity: hovered ? 1 : 0.85,
      }}
    >
      {/* Clickable area — creates workspace */}
      <button
        data-testid={`layout-create-${layout.id}`}
        onClick={onClick}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
        style={{ background: "transparent", border: "none", padding: 0 }}
      >
        {/* Layout minimap */}
        <span className="ml-0.5 shrink-0">
          <svg width={24} height={16} viewBox="0 0 24 16" xmlns="http://www.w3.org/2000/svg">
            {minimapPanes.map((pane, i) => {
              const m = 1.5; // inner margin
              const iw = 24 - m * 2;
              const ih = 16 - m * 2;
              return (
                <rect
                  key={i}
                  x={m + pane.x * iw}
                  y={m + pane.y * ih}
                  width={pane.w * iw}
                  height={pane.h * ih}
                  fill={isDefault ? "var(--accent)" : "var(--text-secondary)"}
                  fillOpacity={hovered ? 0.7 : 0.45}
                  stroke={isDefault ? "var(--accent)" : "var(--text-secondary)"}
                  strokeWidth={0.7}
                  strokeOpacity={hovered ? 0.8 : 0.5}
                />
              );
            })}
            <rect
              x={0.5}
              y={0.5}
              width={23}
              height={15}
              fill="none"
              stroke={isDefault ? "var(--accent)" : "var(--text-secondary)"}
              strokeWidth={1.2}
              rx={1.5}
              strokeOpacity={hovered ? 1 : 0.65}
            />
          </svg>
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1">
          <span
            className="truncate text-[11px] font-medium"
            style={{ color: isDefault && hovered ? "var(--accent)" : "var(--text-primary)" }}
          >
            {layout.name}
          </span>
          {isDefault && (
            <span
              className="shrink-0 rounded-sm px-1 text-[8px] uppercase tracking-wider"
              style={{
                color: "var(--accent)",
                background: "rgba(137,180,250,0.12)",
                lineHeight: "14px",
              }}
            >
              default
            </span>
          )}
          {hovered && isDefault && (
            <span
              className="shrink-0 text-[9px]"
              style={{ color: "var(--text-secondary)", opacity: 0.6, marginLeft: 2 }}
            >
              Ctrl+Alt+N
            </span>
          )}
          {hovered && (
            <button
              data-testid={`layout-menu-${layout.id}`}
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((v) => !v);
              }}
              className="shrink-0 flex h-4 w-4 cursor-pointer items-center justify-center rounded text-[10px]"
              style={{
                background: menuOpen ? "var(--bg-overlay)" : "transparent",
                color: "var(--text-secondary)",
                border: "none",
                marginLeft: 2,
              }}
              title="Layout options"
            >
              ⋯
            </button>
          )}
        </span>
      </button>

      {/* Context menu */}
      {menuOpen && (
        <div
          data-testid={`layout-context-menu-${layout.id}`}
          className="absolute right-0 top-full z-30 mt-1 flex flex-col rounded py-1"
          style={{
            background: "var(--bg-overlay)",
            border: "1px solid var(--border)",
            minWidth: 120,
          }}
        >
          <button
            onClick={() => {
              onRename();
              setMenuOpen(false);
            }}
            className="cursor-pointer px-3 py-1 text-left text-[11px]"
            style={{ color: "var(--text-primary)", background: "transparent", border: "none" }}
          >
            Rename
          </button>
          <button
            onClick={() => {
              onDuplicate();
              setMenuOpen(false);
            }}
            className="cursor-pointer px-3 py-1 text-left text-[11px]"
            style={{ color: "var(--text-primary)", background: "transparent", border: "none" }}
          >
            Duplicate
          </button>
          {!isDefault && (
            <button
              onClick={() => {
                onSetDefault();
                setMenuOpen(false);
              }}
              className="cursor-pointer px-3 py-1 text-left text-[11px]"
              style={{ color: "var(--text-primary)", background: "transparent", border: "none" }}
            >
              Set as Default
            </button>
          )}
          {canDelete && (
            <button
              onClick={() => {
                onDelete();
                setMenuOpen(false);
              }}
              className="cursor-pointer px-3 py-1 text-left text-[11px]"
              style={{ color: "var(--red)", background: "transparent", border: "none" }}
            >
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function WorkspaceSelectorView() {
  const [showNotifPanel, setShowNotifPanel] = useState(false);
  const [notifBtnHovered, setNotifBtnHovered] = useState(false);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const removeWorkspace = useWorkspaceStore((s) => s.removeWorkspace);
  const renameWorkspace = useWorkspaceStore((s) => s.renameWorkspace);
  const duplicateWorkspace = useWorkspaceStore((s) => s.duplicateWorkspace);
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace);
  const layouts = useWorkspaceStore((s) => s.layouts);
  const renameLayout = useWorkspaceStore((s) => s.renameLayout);
  const removeLayout = useWorkspaceStore((s) => s.removeLayout);
  const duplicateLayout = useWorkspaceStore((s) => s.duplicateLayout);
  const setDefaultLayout = useWorkspaceStore((s) => s.setDefaultLayout);

  const notifications = useNotificationStore((s) => s.notifications);
  const markWorkspaceAsRead = useNotificationStore((s) => s.markWorkspaceAsRead);
  const totalUnread = notifications.filter((n) => n.readAt === null).length;

  const terminalInstances = useTerminalStore((s) => s.instances);
  const pathEllipsis = useSettingsStore((s) => s.convenience.pathEllipsis);
  const terminalPorts = new Map<string, number[]>();

  const handleSelectWorkspace = (wsId: string) => {
    markWorkspaceAsRead(wsId);
    setActiveWorkspace(wsId);
  };

  const handleCreateWithLayout = (layoutId: string) => {
    const layout = layouts.find((l) => l.id === layoutId);
    const baseName = layout?.name ?? "Workspace";
    addWorkspace(`${baseName} ${workspaces.length + 1}`, layoutId);
    // Auto-switch to newly created workspace
    const newWs = useWorkspaceStore.getState().workspaces;
    const created = newWs[newWs.length - 1];
    if (created) setActiveWorkspace(created.id);
  };

  return (
    <div data-testid="workspace-selector" className="flex h-full flex-col">
      {/* New Workspace: Layout picker */}
      <div className="mx-2 mt-2 mb-1 shrink-0" data-testid="new-workspace-panel">
        <p
          className="mb-1.5 text-[10px] font-medium uppercase tracking-wider"
          style={{ color: "var(--text-secondary)", opacity: 0.5 }}
        >
          New Workspace
        </p>
        <div className="flex flex-col gap-1">
          {layouts.map((layout, i) => (
            <LayoutCard
              key={layout.id}
              layout={layout}
              isDefault={i === 0}
              canDelete={layouts.length > 1}
              onClick={() => handleCreateWithLayout(layout.id)}
              onRename={() => {
                const name = window.prompt("Rename layout:", layout.name);
                if (name?.trim()) renameLayout(layout.id, name.trim());
              }}
              onDuplicate={() => duplicateLayout(layout.id, `${layout.name} Copy`)}
              onDelete={() => removeLayout(layout.id)}
              onSetDefault={() => setDefaultLayout(layout.id)}
            />
          ))}
        </div>
      </div>

      {/* Separator between creation panel and list */}
      <div
        className="mx-2 my-1.5 border-t"
        style={{ borderColor: "var(--border)", opacity: 0.5 }}
      />

      {/* Workspace list */}
      <div className="flex-1 overflow-y-auto px-1.5 py-0.5">
        {workspaces.map((ws, idx) => {
          const isActive = ws.id === activeWorkspaceId;
          const summary = computeWorkspaceSummary(
            ws.id,
            terminalInstances,
            terminalPorts,
            notifications,
            ws.name,
          );
          return (
            <WorkspaceItem
              key={ws.id}
              ws={ws}
              index={idx}
              isActive={isActive}
              summary={summary}
              panes={ws.panes}
              canClose={workspaces.length > 1}
              pathEllipsis={pathEllipsis}
              onSelect={() => handleSelectWorkspace(ws.id)}
              onClose={() => removeWorkspace(ws.id)}
              onDuplicate={() => {
                duplicateWorkspace(ws.id);
                const updated = useWorkspaceStore.getState().workspaces;
                const newWs = updated[updated.length - 1];
                if (newWs) setActiveWorkspace(newWs.id);
              }}
              onRename={() => {
                const newName = window.prompt("Rename workspace:", ws.name);
                if (newName?.trim()) renameWorkspace(ws.id, newName.trim());
              }}
            />
          );
        })}
      </div>

      {/* #6: Show Notifications — improved contrast, unread count, hover */}
      <button
        data-testid="toggle-notification-panel"
        onClick={() => setShowNotifPanel((v) => !v)}
        onMouseEnter={() => setNotifBtnHovered(true)}
        onMouseLeave={() => setNotifBtnHovered(false)}
        className="flex w-full shrink-0 cursor-pointer items-center gap-2 p-2 text-left text-xs"
        style={{
          borderTop: "1px solid var(--border)",
          color: notifBtnHovered ? "var(--text-primary)" : "var(--text-secondary)",
          background: notifBtnHovered ? "rgba(255,255,255,0.03)" : "var(--bg-surface)",
          transition: "all 0.15s",
        }}
      >
        <span>{showNotifPanel ? "Hide Notifications" : "Notifications"}</span>
        {totalUnread > 0 && <CountBadge count={totalUnread} />}
      </button>

      {showNotifPanel && (
        <div className="overflow-y-auto" style={{ minHeight: "80px", maxHeight: "200px" }}>
          <NotificationPanel />
        </div>
      )}
    </div>
  );
}
