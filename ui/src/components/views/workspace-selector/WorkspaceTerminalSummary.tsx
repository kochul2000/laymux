import { useSettingsStore, type WorkspaceLastInputMode } from "@/stores/settings-store";
import type { WorkspacePane } from "@/stores/types";
import {
  computeCommandStatus,
  getStatusDisplaySettings,
  getTerminalLastInput,
  shortWorkspaceLabel,
  abbreviatePath,
  isWindowsProfile,
  mntPathToWindows,
  formatCommand,
  ACTIVITY_MSG_TRUNCATE_LEN,
  type TerminalSummaryInfo,
} from "@/lib/workspace-summary";
import { PaneMinimap } from "../PaneMinimap";
import { TerminalActivityChip } from "@/components/ui/TerminalActivityChip";
import { CommandStatusIcon } from "@/components/ui/CommandStatusIcon";
import { ExitFade } from "@/components/ui/ExitFade";

/** Workspace selector와 터미널 이동 대상이 공유하는 pane 표시 내용. */
export function WorkspaceTerminalSummary({
  terminal: ts,
  minimapPanes,
  paneIndex,
  isActive,
  isFocusedPane = false,
  pathEllipsis,
  lastInputMode = "workspaceLatest",
}: {
  terminal: TerminalSummaryInfo;
  minimapPanes: Pick<WorkspacePane, "x" | "y" | "w" | "h">[];
  paneIndex: number;
  isActive: boolean;
  isFocusedPane?: boolean;
  pathEllipsis: "start" | "end";
  lastInputMode?: WorkspaceLastInputMode;
}) {
  const wsDisplay = useSettingsStore((s) => s.workspaceSelector.display);
  const claudeSettings = useSettingsStore((s) => s.claude);
  const codexSettings = useSettingsStore((s) => s.codex);
  const grokSettings = useSettingsStore((s) => s.grok);
  const paneStatusSettings = getStatusDisplaySettings(
    ts.activity,
    claudeSettings,
    codexSettings,
    grokSettings,
  );
  const tCmdStatus = computeCommandStatus(
    ts.lastExitCode,
    ts.outputActive,
    ts.activityMessage,
    ts.activity,
    ts.title,
    paneStatusSettings.mode,
    paneStatusSettings.delimiter,
    ts.codexTurn,
    ts.task,
  );
  const lastInput = getTerminalLastInput(ts);
  return (
    <div className="workspace-terminal-summary flex min-w-0 flex-1 items-start gap-1.5">
      {minimapPanes.length > 0 && wsDisplay.minimap && (
        <span
          className={`${lastInputMode === "perPane" ? "mt-0.5 " : ""}shrink-0`}
          data-testid={`pane-minimap-${ts.id}`}
          style={{ opacity: isFocusedPane ? 1 : 0.5 }}
        >
          <PaneMinimap panes={minimapPanes} highlightIndex={paneIndex} width={18} height={12} />
        </span>
      )}
      <div
        className={`flex min-w-0 flex-1 ${
          lastInputMode === "perPane" ? "flex-col gap-px" : "items-center"
        }`}
      >
        <div
          data-testid={`pane-primary-${ts.id}`}
          className="flex min-w-0 items-center gap-1 truncate"
        >
          <div className="flex min-w-0 flex-1 items-center gap-1 truncate">
            {wsDisplay.environment && (
              <span
                className="shrink-0 font-medium"
                style={{
                  color: "var(--text-secondary)",
                  opacity: isActive ? 0.9 : 0.7,
                }}
              >
                {shortWorkspaceLabel(ts.label)}
              </span>
            )}
            {wsDisplay.activity && (
              <TerminalActivityChip
                testId={`terminal-activity-${ts.id}`}
                activity={ts.activity}
                className="mr-1"
                dimmed={!isActive}
              />
            )}
            {wsDisplay.path && ts.branch && (
              <>
                <span
                  className="shrink-0"
                  style={{
                    color: "var(--green)",
                    opacity: isActive ? 1 : 0.7,
                  }}
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
                    color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
                    opacity: isActive ? 0.7 : 0.5,
                    ...(pathEllipsis === "start" ? { direction: "rtl", textAlign: "left" } : {}),
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
          </div>
          {wsDisplay.result && tCmdStatus?.icon ? (
            <span
              data-testid={`pane-cmd-badge-${ts.id}`}
              className="ml-auto shrink-0"
              style={{
                color: tCmdStatus.color,
                border: ts.hasUnreadNotification
                  ? "1.5px solid var(--accent)"
                  : "1.5px solid transparent",
                borderRadius: "var(--radius-md)",
                minWidth: 16,
                gap: 3,
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
              <CommandStatusIcon status={tCmdStatus.icon} label={tCmdStatus.label} />
            </span>
          ) : (
            // Rendered as a standalone ExitFade (not a ternary branch) so the
            // dot can fade out when the alert clears instead of unmounting
            // instantly. Hidden while a cmd badge owns the slot.
            <ExitFade
              show={!!(wsDisplay.result && ts.hasUnreadNotification)}
              data-testid={`pane-notif-dot-${ts.id}`}
              className="ml-auto shrink-0"
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
        {lastInputMode === "perPane" && (
          <div
            data-testid={`pane-last-input-${ts.id}`}
            className="min-w-0 truncate font-bold"
            title={lastInput}
            style={{
              minHeight: "1rem",
              color: "var(--text-secondary)",
              opacity: lastInput ? (isActive ? 0.8 : 0.6) : 0,
            }}
          >
            {lastInput ? formatCommand(lastInput, ACTIVITY_MSG_TRUNCATE_LEN) : "\u00a0"}
          </div>
        )}
      </div>
    </div>
  );
}
