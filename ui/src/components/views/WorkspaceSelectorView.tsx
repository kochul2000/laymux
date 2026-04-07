import { useState, useRef, useCallback, useMemo } from "react";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useGridStore } from "@/stores/grid-store";
import { useNotificationStore } from "@/stores/notification-store";
import { useSettingsStore } from "@/stores/settings-store";
import { sortWorkspaces } from "@/lib/workspace-sort";
import {
  computeWorkspaceSummary,
  computeCommandStatus,
  abbreviatePath,
  mntPathToWindows,
  formatCommand,
  CLAUDE_MSG_TRUNCATE_LEN,
  formatRelativeTime,
  formatActivity,
} from "@/lib/workspace-summary";
import { useTerminalStore } from "@/stores/terminal-store";
import { usePortDetection } from "@/hooks/usePortDetection";
import { NotificationPanel } from "./NotificationPanel";
import { PaneMinimap } from "./PaneMinimap";
import { ViewHeader } from "@/components/ui/ViewHeader";
import type { WorkspacePane } from "@/stores/types";
import { persistSession } from "@/lib/persist-session";

/** Abbreviate profile/view labels to max 3 characters. */
const LABEL_ABBREV: Record<string, string> = {
  PowerShell: "PS",
  WSL: "WSL",
  Ubuntu: "UBT",
  Debian: "DEB",
  Browser: "WEB",
  Empty: "---",
  EmptyView: "---",
};
/** Check if a profile is a Windows-native shell (PowerShell, CMD) that uses Windows paths. */
function isWindowsProfile(profile: string): boolean {
  const lower = profile.toLowerCase();
  return lower.includes("powershell") || lower === "cmd" || lower === "command prompt";
}

function shortLabel(label: string): string {
  return LABEL_ABBREV[label] ?? label.slice(0, 3).toUpperCase();
}

/** 섹션 소제목 라벨 (uppercase, 작은 폰트, 반투명) */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="uppercase tracking-wider"
      style={{
        color: "var(--text-secondary)",
        fontSize: "var(--fs-xs)",
        fontWeight: 500,
        opacity: 0.7,
      }}
    >
      {children}
    </span>
  );
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

interface DropIndicator {
  wsId: string;
  position: "top" | "bottom";
}

interface DragContext {
  enabled: boolean;
  onDragStart: (e: React.DragEvent, wsId: string) => void;
  onDragOver: (e: React.DragEvent, wsId: string) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent, wsId: string) => void;
  onDragEnd: () => void;
}

function WorkspaceItem({
  ws,
  index,
  isActive,
  summary,
  panes,
  canClose,
  pathEllipsis,
  drag,
  dropIndicator,
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
  drag: DragContext;
  dropIndicator: DropIndicator | null;
  onSelect: () => void;
  onClose: () => void;
  onDuplicate: () => void;
  onRename: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const wsDisplay = useSettingsStore((s) => s.workspaceDisplay);

  const cmdInfo = summary.lastCommand;
  const cmdStatus = cmdInfo
    ? computeCommandStatus(cmdInfo.exitCode, cmdInfo.outputActive, cmdInfo.claudeMessage)
    : null;

  return (
    <div
      data-testid={`workspace-item-${ws.id}`}
      data-active={isActive ? "true" : "false"}
      draggable={drag.enabled}
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onDragStart={(e) => drag.onDragStart(e, ws.id)}
      onDragOver={(e) => drag.onDragOver(e, ws.id)}
      onDragLeave={(e) => drag.onDragLeave(e)}
      onDrop={(e) => drag.onDrop(e, ws.id)}
      onDragEnd={drag.onDragEnd}
      className="relative cursor-pointer"
      style={{
        background: isActive ? "var(--accent-08)" : hovered ? "var(--active-bg)" : "transparent",
        borderLeft: isActive ? "3px solid var(--accent)" : "3px solid transparent",
        borderBottom: "1px solid var(--border)",
        boxShadow:
          dropIndicator?.wsId === ws.id
            ? dropIndicator.position === "top"
              ? "inset 0 2px 0 0 var(--accent)"
              : "inset 0 -2px 0 0 var(--accent)"
            : "none",
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
                background: "var(--hover-bg)",
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
                const tCmdStatus = ts.lastCommand
                  ? computeCommandStatus(ts.lastExitCode, ts.outputActive, ts.claudeMessage)
                  : null;
                const actInfo = formatActivity(ts.activity);
                return (
                  <div
                    key={pane.id}
                    className="flex items-center gap-1.5 truncate text-[11px]"
                    style={{
                      paddingLeft: showMinimap && wsDisplay.minimap ? 2 : 18,
                      ...(isFocusedPane
                        ? {
                            background: "var(--accent-12)",
                            borderRadius: "var(--radius-md)",
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
                                  ? "var(--orange-15)"
                                  : "var(--accent-12)"
                                : "var(--active-bg)",
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
                            <bdi>
                              {abbreviatePath(
                                isWindowsProfile(ts.profile) ? mntPathToWindows(ts.cwd) : ts.cwd,
                                pathEllipsis,
                              )}
                            </bdi>
                          </span>
                        </>
                      )}
                      {wsDisplay.result && tCmdStatus?.icon ? (
                        <span
                          data-testid={`pane-cmd-badge-${ts.id}`}
                          className="shrink-0"
                          style={{
                            color: tCmdStatus.color,
                            border: ts.hasUnreadNotification
                              ? "1.5px solid var(--accent)"
                              : "1.5px solid transparent",
                            borderRadius: "var(--radius-md)",
                            width: 16,
                            height: 16,
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            boxSizing: "border-box",
                            fontSize: 10,
                            lineHeight: 1,
                          }}
                        >
                          {tCmdStatus.icon}
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
              // EmptyView or other view types (IssueReporterView, MemoView, etc.)
              return (
                <div
                  key={pane.id}
                  className="flex items-center gap-1.5 truncate text-[11px]"
                  style={{
                    paddingLeft: showMinimap && wsDisplay.minimap ? 2 : 18,
                    ...(isFocusedPane
                      ? {
                          background: "var(--accent-08)",
                          borderRadius: "var(--radius-md)",
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
                      {shortLabel(pane.view.type)}
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
              <bdi>
                {(() => {
                  const cwdSource = summary.terminalSummaries.find((t) => t.cwd);
                  const displayCwd =
                    cwdSource && isWindowsProfile(cwdSource.profile)
                      ? mntPathToWindows(summary.cwd)
                      : summary.cwd;
                  return abbreviatePath(displayCwd, pathEllipsis);
                })()}
              </bdi>
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
            <span data-testid={`cmd-status-${ws.id}`} style={{ color: cmdStatus?.color }}>
              {cmdStatus?.icon}
            </span>
            <span className="truncate" style={{ color: "var(--text-secondary)" }}>
              {formatCommand(
                cmdStatus?.text ?? cmdInfo.command,
                cmdStatus?.text ? CLAUDE_MSG_TRUNCATE_LEN : undefined,
              )}
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
      className="relative flex items-center gap-2 px-1 py-1.5"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setMenuOpen(false);
      }}
      style={{
        border: `1px solid ${isDefault && hovered ? "var(--accent)" : hovered ? "var(--text-secondary)" : "transparent"}`,
        background: hovered ? "var(--accent-08)" : "transparent",
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
                background: "var(--accent-12)",
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
        </span>
      </button>
      {hovered && (
        <button
          data-testid={`layout-menu-${layout.id}`}
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          className={`shrink-0 flex h-4 w-4 cursor-pointer items-center justify-center rounded mx-1 text-[12px] ${menuOpen ? "" : "hover-bg-strong"}`}
          style={{
            background: menuOpen ? "var(--bg-overlay)" : undefined,
            color: "var(--text-secondary)",
            border: "none",
          }}
          title="Layout options"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
            <circle cx="6" cy="2.5" r="1.2" />
            <circle cx="6" cy="6" r="1.2" />
            <circle cx="6" cy="9.5" r="1.2" />
          </svg>
        </button>
      )}

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
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);

  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const removeWorkspace = useWorkspaceStore((s) => s.removeWorkspace);
  const renameWorkspace = useWorkspaceStore((s) => s.renameWorkspace);
  const duplicateWorkspace = useWorkspaceStore((s) => s.duplicateWorkspace);
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace);
  const reorderWorkspaces = useWorkspaceStore((s) => s.reorderWorkspaces);
  const workspaceDisplayOrder = useWorkspaceStore((s) => s.workspaceDisplayOrder);
  const layouts = useWorkspaceStore((s) => s.layouts);
  const renameLayout = useWorkspaceStore((s) => s.renameLayout);
  const removeLayout = useWorkspaceStore((s) => s.removeLayout);
  const duplicateLayout = useWorkspaceStore((s) => s.duplicateLayout);
  const setDefaultLayout = useWorkspaceStore((s) => s.setDefaultLayout);

  const notifications = useNotificationStore((s) => s.notifications);
  const markWorkspaceAsRead = useNotificationStore((s) => s.markWorkspaceAsRead);
  const totalUnread = notifications.filter((n) => n.readAt === null).length;

  const pathEllipsis = useSettingsStore((s) => s.convenience.pathEllipsis);
  const workspaceSortOrder = useSettingsStore((s) => s.workspaceSortOrder);
  const setWorkspaceSortOrder = useSettingsStore((s) => s.setWorkspaceSortOrder);
  const terminalInstances = useTerminalStore((s) => s.instances);
  const listeningPorts = usePortDetection();
  const portNumbers = useMemo(
    () => [...new Set(listeningPorts.map((p) => p.port))].sort((a, b) => a - b),
    [listeningPorts],
  );

  // Build terminal ports map (empty for now — port detection doesn't map to terminals)
  const terminalPorts = useMemo(() => new Map<string, number[]>(), []);

  // Sort workspaces based on current sort order (memoized to avoid re-sorting on every render)
  const sortedWorkspaces = useMemo(
    () => sortWorkspaces(workspaces, workspaceSortOrder, workspaceDisplayOrder, notifications),
    [workspaces, workspaceDisplayOrder, notifications, workspaceSortOrder],
  );

  // Drag and drop handlers (ID-based to avoid index mismatch with sorted lists)
  const dragIdRef = useRef<string | null>(null);
  const dropPositionRef = useRef<"top" | "bottom">("top");

  const handleDragStart = useCallback((e: React.DragEvent, wsId: string) => {
    dragIdRef.current = wsId;
    e.dataTransfer.setData("text/plain", wsId);
    e.dataTransfer.effectAllowed = "move";
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, wsId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const fromId = dragIdRef.current;
    if (!fromId || fromId === wsId) {
      setDropIndicator(null);
      return;
    }
    // Determine top/bottom by mouse Y relative to target midpoint (sort-order agnostic)
    const rect = e.currentTarget.getBoundingClientRect();
    const position = e.clientY < rect.top + rect.height / 2 ? "top" : "bottom";
    dropPositionRef.current = position;
    setDropIndicator((prev) =>
      prev?.wsId === wsId && prev?.position === position ? prev : { wsId, position },
    );
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Ignore leave events when moving to a child element (prevents indicator flicker)
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDropIndicator(null);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent, toId: string) => {
      e.preventDefault();
      const position = dropPositionRef.current;
      setDropIndicator(null);
      const fromId = dragIdRef.current;
      if (fromId !== null && fromId !== toId) {
        reorderWorkspaces(fromId, toId, position);
        persistSession();
      }
      dragIdRef.current = null;
    },
    [reorderWorkspaces],
  );

  const handleDragEnd = useCallback(() => {
    setDropIndicator(null);
    dragIdRef.current = null;
  }, []);

  const isManualSort = workspaceSortOrder === "manual";

  // Drag handlers are stable (useCallback) — this object only re-creates when sort mode
  // or workspaces change. dropIndicator is passed separately to avoid re-creating on every dragOver.
  const dragContext: DragContext = useMemo(
    () => ({
      enabled: isManualSort,
      onDragStart: handleDragStart,
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
      onDragEnd: handleDragEnd,
    }),
    [isManualSort, handleDragStart, handleDragOver, handleDragLeave, handleDrop, handleDragEnd],
  );

  const handleSelectWorkspace = (wsId: string) => {
    markWorkspaceAsRead(wsId);
    // Mark backend notifications as read for this workspace's terminals
    const wsTerminalIds =
      workspaces
        .find((ws) => ws.id === wsId)
        ?.panes.filter((p) => p.view.type === "TerminalView")
        .map((p) => `terminal-${p.id}`) ?? [];
    if (wsTerminalIds.length > 0) {
      import("@/lib/tauri-api").then(({ markNotificationsRead }) =>
        markNotificationsRead(wsTerminalIds).catch(() => {}),
      );
    }
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
      <ViewHeader testId="workspace-selector-header" title="New Workspace" />
      {/* New Workspace: Layout picker */}
      <div className="mt-1 mb-1 shrink-0" data-testid="new-workspace-panel">
        <div className="flex flex-col">
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
        className="mb-1 border-t"
        style={{ borderColor: "var(--border)", opacity: 0.5 }}
      />

      {/* Sort order toggle */}
      <div className="px-2 pb-1 flex items-center justify-between" style={{ borderBottom: "1px solid var(--border)" }}>
        <SectionLabel>Workspaces</SectionLabel>
        <button
          data-testid="sort-order-toggle"
          onClick={() =>
            setWorkspaceSortOrder(workspaceSortOrder === "manual" ? "notification" : "manual")
          }
          className="flex cursor-pointer items-center gap-1 rounded px-1.5 text-[9px]"
          style={{
            color: "var(--text-secondary)",
            background: "var(--active-bg)",
            border: "none",
            opacity: 0.7,
          }}
          title={
            workspaceSortOrder === "manual"
              ? "Sort: Manual (drag to reorder)"
              : "Sort: Notification (most recent first)"
          }
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            {workspaceSortOrder === "manual" ? (
              <>
                <rect x="1" y="1" width="8" height="1.5" rx="0.5" fill="currentColor" />
                <rect x="1" y="4.25" width="8" height="1.5" rx="0.5" fill="currentColor" />
                <rect x="1" y="7.5" width="8" height="1.5" rx="0.5" fill="currentColor" />
              </>
            ) : (
              <>
                <rect x="1" y="1" width="8" height="1.5" rx="0.5" fill="currentColor" />
                <rect x="1" y="4.25" width="6" height="1.5" rx="0.5" fill="currentColor" />
                <rect x="1" y="7.5" width="4" height="1.5" rx="0.5" fill="currentColor" />
              </>
            )}
          </svg>
          {workspaceSortOrder === "manual" ? "Manual" : "Notif"}
        </button>
      </div>

      {/* Workspace list */}
      <div className="flex flex-1 flex-col overflow-y-auto">
        {sortedWorkspaces.map((ws, idx) => {
          const isActive = ws.id === activeWorkspaceId;
          // Compute summary from frontend stores (event-driven, no polling).
          // Include lastCwd from settings as fallback for terminals that haven't
          // emitted OSC 7 yet, or that don't have a session yet (early startup).
          const wsTerminals = ws.panes
            .filter((p) => p.view.type === "TerminalView")
            .map((p) => {
              const termId = `terminal-${p.id}`;
              const inst = terminalInstances.find((t) => t.id === termId);
              if (inst) {
                // Instance exists but no CWD yet — use lastCwd from settings
                if (!inst.cwd && p.view.lastCwd) {
                  return { ...inst, cwd: p.view.lastCwd as string };
                }
                return inst;
              }
              // No instance yet (session not created) — synthesize placeholder
              return {
                id: termId,
                profile: (p.view.profile as string) || "PowerShell",
                syncGroup: ws.id,
                workspaceId: ws.id,
                label: (p.view.profile as string) || "Terminal",
                cwd: (p.view.lastCwd as string) || undefined,
                lastActivityAt: 0,
                isFocused: false,
              };
            });
          const summary = computeWorkspaceSummary(
            ws.id,
            wsTerminals,
            isActive ? terminalPorts : new Map(),
            notifications,
          );
          // Override ports for active workspace
          if (isActive && portNumbers.length > 0) {
            summary.ports = portNumbers;
          }
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
              drag={dragContext}
              dropIndicator={dropIndicator}
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
        {/* Drop zone: empty area below the last workspace item → append to end */}
        {dragContext.enabled && (
          <div
            className="min-h-[40px] flex-1"
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              const lastWs = sortedWorkspaces[sortedWorkspaces.length - 1];
              if (!lastWs || dragIdRef.current === lastWs.id) {
                setDropIndicator(null);
                return;
              }
              dropPositionRef.current = "bottom";
              setDropIndicator((prev) =>
                prev?.wsId === lastWs.id && prev?.position === "bottom"
                  ? prev
                  : { wsId: lastWs.id, position: "bottom" },
              );
            }}
            onDragLeave={() => setDropIndicator(null)}
            onDrop={(e) => {
              e.preventDefault();
              setDropIndicator(null);
              const lastWs = sortedWorkspaces[sortedWorkspaces.length - 1];
              const fromId = dragIdRef.current;
              if (fromId && lastWs && fromId !== lastWs.id) {
                reorderWorkspaces(fromId, lastWs.id, "bottom");
                persistSession();
              }
              dragIdRef.current = null;
            }}
          />
        )}
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
          background: notifBtnHovered ? "var(--active-bg)" : "var(--bg-surface)",
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
