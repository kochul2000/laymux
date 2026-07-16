import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useGridStore } from "@/stores/grid-store";
import { useDockStore } from "@/stores/dock-store";
import { useNotificationStore } from "@/stores/notification-store";
import { useSettingsStore } from "@/stores/settings-store";
import { sortWorkspaces } from "@/lib/workspace-sort";
import {
  computeWorkspaceSummary,
  computeCommandStatus,
  abbreviatePath,
  mntPathToWindows,
  isWindowsProfile,
  formatCommand,
  ACTIVITY_MSG_TRUNCATE_LEN,
  formatRelativeTime,
  formatActivity,
} from "@/lib/workspace-summary";
import { useTerminalStore } from "@/stores/terminal-store";
import { usePortDetection } from "@/hooks/usePortDetection";
import { NotificationPanel } from "./NotificationPanel";
import { PaneMinimap } from "./PaneMinimap";
import { ViewHeader } from "@/components/ui/ViewHeader";
import { ExitFade } from "@/components/ui/ExitFade";
import type { WorkspacePane } from "@/stores/types";
import type { TerminalActivityInfo } from "@/stores/terminal-store";
import { persistSession } from "@/lib/persist-session";
import { useUiStore } from "@/stores/ui-store";
import { useRenameWorkspaceStore } from "@/stores/rename-workspace-store";
import { getPaneDragData, isPaneDrag } from "@/lib/pane-dnd";
import { markNotificationsRead } from "@/lib/tauri-api";
import { computePaneNumbers } from "@/lib/pane-numbers";
import { deriveHiddenItems, findNextVisibleWorkspaceId } from "@/lib/hidden-items";
import { setWorkspaceHiddenWithFallback } from "@/lib/hidden-item-actions";
import { HiddenItemsShelf } from "./workspace-selector/HiddenItemsShelf";
import { UndoSnackbar } from "@/components/ui/UndoSnackbar";

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
function getStatusDisplaySettings(
  activity: TerminalActivityInfo | undefined,
  claudeSettings: ReturnType<typeof useSettingsStore.getState>["claude"],
  codexSettings: ReturnType<typeof useSettingsStore.getState>["codex"],
): {
  mode: "bullet" | "title" | "title-bullet" | "bullet-title" | undefined;
  delimiter: string | undefined;
} {
  if (activity?.type !== "interactiveApp") {
    return { mode: undefined, delimiter: undefined };
  }
  if (activity.name === "Claude") {
    return {
      mode: claudeSettings.statusMessageMode,
      delimiter: claudeSettings.statusMessageDelimiter,
    };
  }
  if (activity.name === "Codex") {
    return {
      mode: codexSettings.statusMessageMode,
      delimiter: codexSettings.statusMessageDelimiter,
    };
  }
  return { mode: undefined, delimiter: undefined };
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

// 배지는 최소 폭 14px(1~2자리는 정사각형 유지)이고, 세 자리 이상이면 콘텐츠 폭만큼 가로로 늘어난다.
// 폭이 과도하게 커지지 않도록 표시 문자열이 길수록 폰트를 줄인다(높이는 14px 고정 유지).
// 인덱스 = 표시 문자열 길이(1~4+), 값 = 해당 길이용 폰트 크기.
// fontSize 값은 회귀 테스트(WorkspaceSelectorView.test.tsx)가 검증하므로 값 변경 시 함께 갱신한다.
const COUNT_BADGE_FONT_SIZE_BY_LENGTH = ["10px", "10px", "9.5px", "8.5px", "7.5px"] as const;

function getCountBadgeFontSize(countText: string): string {
  const idx = Math.min(countText.length, COUNT_BADGE_FONT_SIZE_BY_LENGTH.length - 1);
  return COUNT_BADGE_FONT_SIZE_BY_LENGTH[idx];
}

function CountBadge({ count, testId }: { count: number; testId?: string }) {
  const countText = count > 999 ? "999+" : String(count);
  return (
    <span
      data-testid={testId}
      className="workspace-count-badge"
      style={{
        fontSize: getCountBadgeFontSize(countText),
      }}
    >
      {countText}
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

type HiddenUndoItem =
  | { kind: "workspace"; id: string; name: string; paneIds: string[]; nonce: number }
  | { kind: "pane"; id: string; name: string; nonce: number };

/** Eye icon (visible state) — 11x11 */
function EyeIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 11 11" fill="none">
      <path
        d="M1 5.5C1 5.5 3 2 5.5 2C8 2 10 5.5 10 5.5C10 5.5 8 9 5.5 9C3 9 1 5.5 1 5.5Z"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinejoin="round"
      />
      <circle cx="5.5" cy="5.5" r="1.5" stroke="currentColor" strokeWidth="1" />
    </svg>
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
  drag,
  dropIndicator,
  isPaneDropTarget,
  onPaneDragOver,
  onPaneDragLeave,
  onPaneDrop,
  hiddenPaneIds,
  canHideWorkspace,
  onSelect,
  onClose,
  onDuplicate,
  onRename,
  onHidePane,
  onHideWorkspace,
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
  // Pane 을 이 워크스페이스 위로 끌어왔는지(하이라이트용)와 그 drop 핸들러 (issue #380).
  isPaneDropTarget: boolean;
  onPaneDragOver: (e: React.DragEvent, wsId: string) => void;
  onPaneDragLeave: (e: React.DragEvent) => void;
  onPaneDrop: (e: React.DragEvent, wsId: string) => void;
  hiddenPaneIds: Set<string>;
  canHideWorkspace: boolean;
  onSelect: () => void;
  onClose: () => void;
  onDuplicate: () => void;
  onRename: () => void;
  onHidePane: (paneId: string) => void;
  onHideWorkspace: () => void;
}) {
  const { t } = useTranslation("workspace");
  const [hovered, setHovered] = useState(false);
  const wsDisplay = useSettingsStore((s) => s.workspaceSelector.display);
  const claudeSettings = useSettingsStore((s) => s.claude);
  const codexSettings = useSettingsStore((s) => s.codex);

  const cmdInfo = summary.lastCommand;
  const cmdStatusSettings = getStatusDisplaySettings(
    cmdInfo?.activity,
    claudeSettings,
    codexSettings,
  );
  const cmdStatus = cmdInfo
    ? computeCommandStatus(
        cmdInfo.exitCode,
        cmdInfo.outputActive,
        cmdInfo.activityMessage,
        cmdInfo.activity,
        cmdInfo.title,
        cmdStatusSettings.mode,
        cmdStatusSettings.delimiter,
      )
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
      onDragOver={(e) => {
        // Pane 드래그(이동)와 워크스페이스 재정렬 드래그를 같은 항목에서 모두 받는다.
        // pane MIME 가 실려 있으면 이동 경로, 아니면 기존 재정렬 경로.
        if (isPaneDrag(e)) onPaneDragOver(e, ws.id);
        else drag.onDragOver(e, ws.id);
      }}
      onDragLeave={(e) => {
        onPaneDragLeave(e);
        drag.onDragLeave(e);
      }}
      onDrop={(e) => {
        if (isPaneDrag(e)) onPaneDrop(e, ws.id);
        else drag.onDrop(e, ws.id);
      }}
      onDragEnd={drag.onDragEnd}
      className="workspace-item-animated relative shrink-0 cursor-pointer"
      style={{
        background: isPaneDropTarget
          ? "var(--accent-12)"
          : isActive
            ? "var(--accent-08)"
            : hovered
              ? "var(--active-bg)"
              : "transparent",
        borderLeft: isActive ? "3px solid var(--accent)" : "3px solid transparent",
        borderBottom: "1px solid var(--border)",
        boxShadow: isPaneDropTarget
          ? "inset 0 0 0 2px var(--accent)"
          : dropIndicator?.wsId === ws.id
            ? dropIndicator.position === "top"
              ? "inset 0 2px 0 0 var(--accent)"
              : "inset 0 -2px 0 0 var(--accent)"
            : "none",
        paddingLeft: 9,
        paddingRight: 10,
      }}
    >
      <div className="workspace-item-content">
        {/* Row 1: Index + Workspace name + terminal count + badge + close */}
        <div data-testid={`ws-row-1-${ws.id}`} className="flex items-center justify-between">
          <span className="flex min-w-0 items-center gap-1.5 truncate">
            <span className="flex min-w-0 items-center gap-1.5 truncate">
              <span
                className="shrink-0 text-[10px] font-medium"
                style={{
                  color: isActive ? "var(--accent)" : "var(--text-primary)",
                  opacity: isActive ? 0.9 : 0.6,
                  minWidth: 10,
                }}
                title={
                  index < 9
                    ? `Ctrl+Alt+${index + 1}`
                    : index === 8
                      ? "Ctrl+Alt+9 (last)"
                      : undefined
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
          </span>
          <span className="flex items-center gap-1">
            <ExitFade show={summary.unreadCount > 0} className="workspace-count-badge-frame">
              <CountBadge count={summary.unreadCount} testId={`unread-badge-${ws.id}`} />
            </ExitFade>
            <button
              type="button"
              data-testid={`workspace-hide-${ws.id}`}
              onClick={(e) => {
                e.stopPropagation();
                onHideWorkspace();
              }}
              disabled={!canHideWorkspace}
              className="hidden-item-action-btn workspace-quick-hide hover-bg cursor-pointer"
              aria-label={t("hiddenItems.hideFromList")}
              title={
                !canHideWorkspace
                  ? t("hiddenItems.lastWorkspace")
                  : isActive
                    ? t("hiddenItems.hideAndMove")
                    : t("hiddenItems.hideFromList")
              }
            >
              <EyeIcon size={12} />
            </button>
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
                  title={t("item.duplicateWorkspace")}
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
                  title={t("item.renameWorkspace")}
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
                    title={t("item.closeWorkspace")}
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
              const paneIndexById = new Map(panes.map((pane, index) => [pane.id, index]));
              const paneNumbers = computePaneNumbers(panes);
              const panesByNumber = [...panes].sort(
                (a, b) => (paneNumbers.get(a.id) ?? 0) - (paneNumbers.get(b.id) ?? 0),
              );
              const gridFocused = isActive ? useGridStore.getState().focusedPaneIndex : null;
              return panesByNumber
                .filter((pane) => !hiddenPaneIds.has(pane.id))
                .map((pane) => {
                  // 표시 순서와 달리 focus/minimap은 WorkspacePane[] 원본 인덱스를 사용한다.
                  const paneIndex = paneIndexById.get(pane.id) ?? -1;
                  const isFocusedPane = isActive && gridFocused === paneIndex;
                  if (pane.view.type === "TerminalView") {
                    const termId = `terminal-${pane.id}`;
                    const ts = summary.terminalSummaries.find((t) => t.id === termId);
                    if (!ts) return null;
                    const paneStatusSettings = getStatusDisplaySettings(
                      ts.activity,
                      claudeSettings,
                      codexSettings,
                    );
                    const tCmdStatus =
                      ts.lastCommand || ts.activity?.type === "interactiveApp"
                        ? computeCommandStatus(
                            ts.lastExitCode,
                            ts.outputActive,
                            ts.activityMessage,
                            ts.activity,
                            ts.title,
                            paneStatusSettings.mode,
                            paneStatusSettings.delimiter,
                          )
                        : null;
                    const actInfo = formatActivity(ts.activity);
                    return (
                      <div
                        key={pane.id}
                        data-testid={`pane-row-${pane.id}`}
                        className="workspace-pane-row flex items-center gap-1.5 truncate text-[11px]"
                        style={{
                          paddingLeft: showMinimap && wsDisplay.minimap ? 0 : 18,
                          ...(isFocusedPane
                            ? {
                                background: "var(--accent-12)",
                                borderRadius: "var(--radius-md)",
                                filter: "brightness(1.3)",
                              }
                            : {}),
                        }}
                      >
                        <div className="flex min-w-0 flex-1 items-center gap-1.5 truncate">
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
                                style={{
                                  color: "var(--text-secondary)",
                                  opacity: isActive ? 0.9 : 0.7,
                                }}
                              >
                                {shortLabel(ts.label)}
                              </span>
                            )}
                            {wsDisplay.activity && (
                              <span
                                data-testid={`terminal-activity-${ts.id}`}
                                className="shrink-0 rounded px-1 mr-1 text-[9px]"
                                style={{
                                  color: actInfo.color,
                                  background:
                                    ts.activity?.type === "interactiveApp"
                                      ? ts.activity?.name === "Claude"
                                        ? "var(--orange-15)"
                                        : "var(--accent-12)"
                                      : "var(--active-bg)",
                                  minWidth: 40,
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
                                <span
                                  className="truncate"
                                  style={{
                                    color: isActive
                                      ? "var(--text-primary)"
                                      : "var(--text-secondary)",
                                    opacity: isActive ? 0.7 : 0.5,
                                    ...(pathEllipsis === "start"
                                      ? { direction: "rtl", textAlign: "left" }
                                      : {}),
                                  }}
                                >
                                  <bdi>
                                    {abbreviatePath(
                                      isWindowsProfile(ts.profile)
                                        ? mntPathToWindows(ts.cwd)
                                        : ts.cwd,
                                      pathEllipsis,
                                    )}
                                  </bdi>
                                </span>
                              </>
                            )}
                          </div>
                          {wsDisplay.result && tCmdStatus?.icon ? (
                            <span
                              data-testid={`pane-cmd-badge-${ts.id}`}
                              className="shrink-0 ml-auto"
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
                                // Fade the accent ring as the unread alert clears (focus/input),
                                // matching the badge/dot fade (issue #365 follow-up).
                                transition: "border-color 200ms ease",
                              }}
                            >
                              {tCmdStatus.icon}
                            </span>
                          ) : (
                            // Rendered as a standalone ExitFade (not a ternary branch) so the
                            // dot can fade out when the alert clears instead of unmounting
                            // instantly. Hidden while a cmd badge owns the slot.
                            <ExitFade
                              show={!!(wsDisplay.result && ts.hasUnreadNotification)}
                              data-testid={`pane-notif-dot-${ts.id}`}
                              className="shrink-0 ml-auto"
                              style={{
                                width: 6,
                                height: 6,
                                borderRadius: "50%",
                                background: "var(--accent)",
                                display: "inline-block",
                              }}
                            />
                          )}
                        </div>
                        <button
                          type="button"
                          data-testid={`pane-hide-${pane.id}`}
                          className="hidden-item-action-btn pane-quick-hide hover-bg cursor-pointer"
                          aria-label={t("hiddenItems.hideFromList")}
                          title={t("hiddenItems.hidePaneDescription")}
                          onClick={(e) => {
                            e.stopPropagation();
                            onHidePane(pane.id);
                          }}
                        >
                          <EyeIcon size={12} />
                        </button>
                      </div>
                    );
                  }
                  // EmptyView or other view types (IssueReporterView, MemoView, etc.)
                  return (
                    <div
                      key={pane.id}
                      data-testid={`pane-row-${pane.id}`}
                      className="workspace-pane-row flex items-center gap-1.5 truncate text-[11px]"
                      style={{
                        paddingLeft: showMinimap && wsDisplay.minimap ? 0 : 18,
                        ...(isFocusedPane
                          ? {
                              background: "var(--accent-08)",
                              borderRadius: "var(--radius-md)",
                              color: "var(--text-primary)",
                            }
                          : {}),
                      }}
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-1.5 truncate">
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
                      <button
                        type="button"
                        data-testid={`pane-hide-${pane.id}`}
                        className="hidden-item-action-btn pane-quick-hide hover-bg cursor-pointer"
                        aria-label={t("hiddenItems.hideFromList")}
                        title={t("hiddenItems.hidePaneDescription")}
                        onClick={(e) => {
                          e.stopPropagation();
                          onHidePane(pane.id);
                        }}
                      >
                        <EyeIcon size={12} />
                      </button>
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
                  cmdStatus?.text ? ACTIVITY_MSG_TRUNCATE_LEN : undefined,
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
  onOverwrite,
}: {
  layout: { id: string; name: string; panes: { x: number; y: number; w: number; h: number }[] };
  isDefault: boolean;
  canDelete: boolean;
  onClick: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onSetDefault: () => void;
  onOverwrite: () => void;
}) {
  const { t } = useTranslation("workspace");
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const minimapPanes = layout.panes.map((p) => ({ x: p.x, y: p.y, w: p.w, h: p.h }));

  useEffect(() => {
    if (!menuOpen) return;
    const handleDismiss = (e: Event) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setHovered(false);
      }
    };
    document.addEventListener("mousedown", handleDismiss, true);
    document.addEventListener("focusin", handleDismiss, true);
    return () => {
      document.removeEventListener("mousedown", handleDismiss, true);
      document.removeEventListener("focusin", handleDismiss, true);
    };
  }, [menuOpen]);

  return (
    <div
      ref={cardRef}
      data-testid={`layout-card-${layout.id}`}
      className="relative flex items-center gap-2 px-1 py-1.5"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        if (!menuOpen) {
          setHovered(false);
        }
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
              {t("layout.default")}
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
          title={t("layout.options")}
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
              onOverwrite();
              setMenuOpen(false);
            }}
            className="cursor-pointer px-3 py-1 text-left text-[11px]"
            style={{ color: "var(--text-primary)", background: "transparent", border: "none" }}
            title={t("layout.overwriteTitle")}
          >
            {t("layout.overwrite")}
          </button>
          <button
            onClick={() => {
              onRename();
              setMenuOpen(false);
            }}
            className="cursor-pointer px-3 py-1 text-left text-[11px]"
            style={{ color: "var(--text-primary)", background: "transparent", border: "none" }}
            title={t("layout.renameTitle")}
          >
            {t("layout.rename")}
          </button>
          <button
            onClick={() => {
              onDuplicate();
              setMenuOpen(false);
            }}
            className="cursor-pointer px-3 py-1 text-left text-[11px]"
            style={{ color: "var(--text-primary)", background: "transparent", border: "none" }}
            title={t("layout.duplicateTitle")}
          >
            {t("layout.duplicate")}
          </button>
          {!isDefault && (
            <button
              onClick={() => {
                onSetDefault();
                setMenuOpen(false);
              }}
              className="cursor-pointer px-3 py-1 text-left text-[11px]"
              style={{ color: "var(--text-primary)", background: "transparent", border: "none" }}
              title={t("layout.setDefaultTitle")}
            >
              {t("layout.setDefault")}
            </button>
          )}
          {canDelete && (
            <button
              onClick={() => {
                if (window.confirm(t("layout.deleteConfirm", { name: layout.name }))) {
                  onDelete();
                }
                setMenuOpen(false);
              }}
              className="cursor-pointer px-3 py-1 text-left text-[11px]"
              style={{ color: "var(--red)", background: "transparent", border: "none" }}
              title={t("layout.deleteTitle")}
            >
              {t("layout.delete")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function WorkspaceSelectorView() {
  const { t } = useTranslation("workspace");
  const [showNotifPanel, setShowNotifPanel] = useState(false);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);
  // 어떤 워크스페이스 위로 pane 을 끌어왔는지(이동 drop 타겟 하이라이트, issue #380).
  const [paneDropWsId, setPaneDropWsId] = useState<string | null>(null);
  const [undoItem, setUndoItem] = useState<HiddenUndoItem | null>(null);
  const undoNonceRef = useRef(0);
  const hiddenChipRef = useRef<HTMLButtonElement>(null);
  const dismissUndo = useCallback(() => setUndoItem(null), []);

  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const removeWorkspace = useWorkspaceStore((s) => s.removeWorkspace);
  const duplicateWorkspace = useWorkspaceStore((s) => s.duplicateWorkspace);
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace);
  const movePaneToWorkspace = useWorkspaceStore((s) => s.movePaneToWorkspace);
  const reorderWorkspaces = useWorkspaceStore((s) => s.reorderWorkspaces);
  const workspaceDisplayOrder = useWorkspaceStore((s) => s.workspaceDisplayOrder);
  const layouts = useWorkspaceStore((s) => s.layouts);
  const renameLayout = useWorkspaceStore((s) => s.renameLayout);
  const removeLayout = useWorkspaceStore((s) => s.removeLayout);
  const duplicateLayout = useWorkspaceStore((s) => s.duplicateLayout);
  const setDefaultLayout = useWorkspaceStore((s) => s.setDefaultLayout);
  const exportToLayout = useWorkspaceStore((s) => s.exportToLayout);

  const notifications = useNotificationStore((s) => s.notifications);
  const totalUnread = notifications.filter((n) => n.readAt === null).length;

  const hiddenPaneIds = useUiStore((s) => s.hiddenPaneIds);
  const hiddenWorkspaceIds = useUiStore((s) => s.hiddenWorkspaceIds);
  const hiddenShelfOpen = useUiStore((s) => s.hiddenShelfOpen);
  const setHiddenShelfOpen = useUiStore((s) => s.setHiddenShelfOpen);
  const setPaneHidden = useUiStore((s) => s.setPaneHidden);
  const setWorkspaceHidden = useUiStore((s) => s.setWorkspaceHidden);
  const restoreAllHidden = useUiStore((s) => s.restoreAllHidden);

  const pathEllipsis = useSettingsStore((s) => s.workspaceSelector.pathEllipsis);
  const workspaceSortOrder = useSettingsStore((s) => s.workspaceSelector.sortOrder);
  const setWorkspaceSelector = useSettingsStore((s) => s.setWorkspaceSelector);
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

  const hiddenItems = useMemo(
    () => deriveHiddenItems({ workspaces: sortedWorkspaces, hiddenWorkspaceIds, hiddenPaneIds }),
    [sortedWorkspaces, hiddenWorkspaceIds, hiddenPaneIds],
  );
  const selectorWorkspaces = useMemo(() => {
    if (!hiddenItems.validHiddenWorkspaceIds.has(activeWorkspaceId)) {
      return hiddenItems.visibleWorkspaces;
    }
    // An external raw-state write may temporarily flag the active workspace.
    // Keep it rendered until the global coordinator moves or restores it.
    return sortedWorkspaces.filter(
      (workspace) =>
        workspace.id === activeWorkspaceId ||
        !hiddenItems.validHiddenWorkspaceIds.has(workspace.id),
    );
  }, [activeWorkspaceId, hiddenItems, sortedWorkspaces]);
  const paneDetailsById = useMemo(() => {
    const details = new Map<string, { label?: string; cwd?: string }>();
    for (const workspace of workspaces) {
      for (const pane of workspace.panes) {
        const instance = terminalInstances.find((item) => item.id === `terminal-${pane.id}`);
        details.set(pane.id, {
          label: instance?.label ?? (pane.view.profile as string | undefined),
          cwd: instance?.cwd ?? (pane.view.lastCwd as string | undefined),
        });
      }
    }
    return details;
  }, [terminalInstances, workspaces]);

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

  // -- Pane → workspace 이동 drop (issue #380) --
  // PaneGrid 컨트롤바의 드래그 핸들에서 시작된 pane 드래그를 워크스페이스 항목 위로
  // 드롭하면 그 워크스페이스로 pane 을 이동한다. 워크스페이스 재정렬과 달리 sort 모드와
  // 무관하게 항상 동작한다.
  const handlePaneDragOver = useCallback((e: React.DragEvent, wsId: string) => {
    // preventDefault 를 호출해야 drop 이 허용된다(HTML5 DnD 규약).
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setPaneDropWsId((prev) => (prev === wsId ? prev : wsId));
  }, []);

  const handlePaneDragLeave = useCallback((e: React.DragEvent) => {
    // 자식 요소로 이동하는 leave 는 무시(하이라이트 깜빡임 방지).
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setPaneDropWsId(null);
  }, []);

  const handlePaneDrop = useCallback(
    (e: React.DragEvent, wsId: string) => {
      e.preventDefault();
      setPaneDropWsId(null);
      const paneId = getPaneDragData(e);
      if (paneId) {
        movePaneToWorkspace(paneId, wsId);
        persistSession();
      }
    },
    [movePaneToWorkspace],
  );

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
    // UI dismissal is NOT done here: entering the workspace funnels through
    // setActiveWorkspace, and AppLayout's focus effect performs the read-marking
    // per the active dismiss mode (ADR 0010, issue #365). Doing markWorkspaceAsRead
    // here would ignore paneFocus/manual modes and re-scatter dismissal into an
    // input handler — exactly what made dismissal key/device-dependent.
    // Backend (OS-native) notification state is a separate concern synced below.
    const wsTerminalIds =
      workspaces
        .find((ws) => ws.id === wsId)
        ?.panes.filter((p) => p.view.type === "TerminalView")
        .map((p) => `terminal-${p.id}`) ?? [];
    if (wsTerminalIds.length > 0) {
      markNotificationsRead(wsTerminalIds).catch(() => {});
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

  const handleHideWorkspace = (workspaceId: string) => {
    const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) return;
    const result = setWorkspaceHiddenWithFallback(workspaceId, true);
    if (result.blocked) return;
    undoNonceRef.current += 1;
    setUndoItem({
      kind: "workspace",
      id: workspace.id,
      name: workspace.name,
      paneIds: workspace.panes.map((pane) => pane.id),
      nonce: undoNonceRef.current,
    });
  };

  const handleHidePane = (paneId: string) => {
    for (const workspace of workspaces) {
      const pane = workspace.panes.find((candidate) => candidate.id === paneId);
      if (!pane) continue;
      const paneNumber = computePaneNumbers(workspace.panes).get(pane.id) ?? 1;
      setPaneHidden(pane.id, true);
      undoNonceRef.current += 1;
      setUndoItem({
        kind: "pane",
        id: pane.id,
        name: `${workspace.name} · #${paneNumber}`,
        nonce: undoNonceRef.current,
      });
      return;
    }
  };

  const handleCloseHiddenShelf = () => {
    setHiddenShelfOpen(false);
    hiddenChipRef.current?.focus();
  };

  return (
    <div data-testid="workspace-selector" className="relative flex h-full flex-col">
      <ViewHeader testId="workspace-selector-header" title={t("newWorkspace")} />
      {/* New Workspace: Layout picker */}
      <div className="shrink-0" data-testid="new-workspace-panel">
        <div className="flex flex-col">
          {layouts.map((layout, i) => (
            <LayoutCard
              key={layout.id}
              layout={layout}
              isDefault={i === 0}
              canDelete={layouts.length > 1}
              onClick={() => handleCreateWithLayout(layout.id)}
              onRename={() => {
                const name = window.prompt(t("layout.renamePrompt"), layout.name);
                if (name?.trim()) renameLayout(layout.id, name.trim());
              }}
              onDuplicate={() => duplicateLayout(layout.id, `${layout.name} Copy`)}
              onDelete={() => removeLayout(layout.id)}
              onSetDefault={() => setDefaultLayout(layout.id)}
              onOverwrite={() => exportToLayout(layout.id)}
            />
          ))}
        </div>
      </div>

      {/* Separator between creation panel and list */}
      <div className="mb-1 border-t" style={{ borderColor: "var(--border)", opacity: 0.5 }} />

      {/* Sort order toggle */}
      <div
        className="px-2 pb-1 flex items-center justify-between"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <SectionLabel>{t("workspaces")}</SectionLabel>
        <span className="flex items-center gap-1">
          {hiddenItems.count > 0 && (
            <button
              ref={hiddenChipRef}
              type="button"
              data-testid="hidden-items-chip"
              aria-expanded={hiddenShelfOpen}
              aria-controls="hidden-items-shelf"
              onClick={() => setHiddenShelfOpen(!hiddenShelfOpen)}
              className="hover-bg flex cursor-pointer items-center gap-1 rounded px-1.5 text-[9px]"
              style={{
                color: "var(--yellow)",
                background: hiddenShelfOpen ? "var(--accent-12)" : "var(--active-bg)",
                border: "1px solid transparent",
              }}
            >
              {t("hiddenItems.chip", { count: hiddenItems.count })}
            </button>
          )}
          <button
            data-testid="sort-order-toggle"
            onClick={() =>
              setWorkspaceSelector({
                sortOrder: workspaceSortOrder === "manual" ? "notification" : "manual",
              })
            }
            className="flex cursor-pointer items-center gap-1 rounded px-1.5 text-[9px]"
            style={{
              color: "var(--text-secondary)",
              background: "var(--active-bg)",
              border: "none",
              opacity: 0.7,
            }}
            title={
              workspaceSortOrder === "manual" ? t("sort.manualTitle") : t("sort.notificationTitle")
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
            {workspaceSortOrder === "manual" ? t("sort.manual") : t("sort.notification")}
          </button>
        </span>
      </div>

      {/* Workspace list */}
      <div data-testid="workspace-list" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {selectorWorkspaces.map((ws, idx) => {
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
          // Compute hidden pane IDs for this workspace
          const wsHiddenPaneIds = new Set(
            [...hiddenPaneIds].filter((id) => ws.panes.some((p) => p.id === id)),
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
              drag={dragContext}
              dropIndicator={dropIndicator}
              isPaneDropTarget={paneDropWsId === ws.id}
              onPaneDragOver={handlePaneDragOver}
              onPaneDragLeave={handlePaneDragLeave}
              onPaneDrop={handlePaneDrop}
              hiddenPaneIds={wsHiddenPaneIds}
              canHideWorkspace={
                !isActive ||
                findNextVisibleWorkspaceId({
                  orderedWorkspaces: sortedWorkspaces,
                  activeWorkspaceId,
                  hiddenWorkspaceIds,
                }) !== null
              }
              onSelect={() => handleSelectWorkspace(ws.id)}
              onClose={() => removeWorkspace(ws.id)}
              onDuplicate={() => {
                const result = duplicateWorkspace(ws.id);
                if (result) {
                  // Replay hide state (workspace + per-pane) so the duplicate
                  // mirrors the source's hidden selections. See issue #218.
                  useUiStore
                    .getState()
                    .propagateHiddenOnDuplicate(
                      ws.id,
                      result.newWorkspaceId,
                      result.paneIdMap,
                      true,
                    );
                  setActiveWorkspace(result.newWorkspaceId);
                }
              }}
              onRename={() => {
                // Inline overlay instead of window.prompt (#339) — native
                // prompt does not work on Windows/WebView2.
                useRenameWorkspaceStore.getState().openRename(ws.id, ws.name);
              }}
              onHidePane={handleHidePane}
              onHideWorkspace={() => handleHideWorkspace(ws.id)}
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
              const lastWs = selectorWorkspaces[selectorWorkspaces.length - 1];
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
              const lastWs = selectorWorkspaces[selectorWorkspaces.length - 1];
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

      {hiddenShelfOpen && hiddenItems.count > 0 && (
        <HiddenItemsShelf
          items={hiddenItems}
          paneDetailsById={paneDetailsById}
          onClose={handleCloseHiddenShelf}
          onRestoreAll={() => {
            restoreAllHidden();
            setUndoItem(null);
          }}
          onRestoreWorkspace={(item, open) => {
            setWorkspaceHidden(
              item.workspace.id,
              false,
              item.workspace.panes.map((pane) => pane.id),
            );
            if (open) handleSelectWorkspace(item.workspace.id);
          }}
          onRestorePane={(item, focus) => {
            setPaneHidden(item.pane.id, false);
            if (focus) {
              handleSelectWorkspace(item.workspace.id);
              useGridStore.getState().setFocusedPane(item.paneIndex);
              useDockStore.getState().setFocusedDock(null);
            }
          }}
        />
      )}

      {/* #6: Notifications section header — matches Workspaces section style */}
      <div
        data-testid="toggle-notification-panel"
        onClick={() => setShowNotifPanel((v) => !v)}
        className="hover-bg flex shrink-0 cursor-pointer items-center justify-between px-2 pt-1 pb-1"
        style={{ borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)" }}
      >
        <SectionLabel>{showNotifPanel ? t("hideNotifications") : t("notifications")}</SectionLabel>
        <ExitFade show={totalUnread > 0} className="workspace-count-badge-frame">
          <CountBadge count={totalUnread} />
        </ExitFade>
      </div>

      {showNotifPanel && (
        <div
          className="empty-view-scroll overflow-y-auto"
          style={{ minHeight: "80px", maxHeight: "200px" }}
        >
          <NotificationPanel embedded />
        </div>
      )}
      {undoItem && (
        <UndoSnackbar
          key={undoItem.nonce}
          message={t("hiddenItems.hiddenMessage", { name: undoItem.name })}
          actionLabel={t("hiddenItems.undo")}
          onDismiss={dismissUndo}
          onAction={() => {
            if (undoItem.kind === "workspace") {
              setWorkspaceHidden(undoItem.id, false, undoItem.paneIds);
            } else {
              setPaneHidden(undoItem.id, false);
            }
            setUndoItem(null);
          }}
        />
      )}
    </div>
  );
}
