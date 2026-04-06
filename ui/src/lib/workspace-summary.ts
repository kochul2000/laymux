import type { TerminalInstance, TerminalActivityInfo } from "@/stores/terminal-store";
import type { Notification } from "@/stores/notification-store";
import type { TerminalSummaryResponse } from "@/lib/tauri-api";
import {
  parseClaudeMode,
  isClaudeIdle,
  isRalphActive,
  type ClaudeMode,
} from "./activity-detection";

export interface LastCommandInfo {
  command: string;
  exitCode: number | undefined; // undefined = still running
  timestamp: number;
  outputActive?: boolean; // true = terminal still producing output (e.g. subprocess running)
  activity?: TerminalActivityInfo; // terminal activity state (shell/running/interactiveApp)
  title?: string; // terminal title — used to detect Claude idle/working via isClaudeIdle()
  claudeMessage?: string; // latest white-● status message from Claude Code output
}

export interface TerminalSummaryInfo {
  id: string;
  label: string;
  profile: string;
  cwd: string | null;
  branch: string | null;
  title: string | undefined;
  lastCommand: string | undefined;
  lastExitCode: number | undefined;
  lastCommandAt: number | undefined;
  activity: TerminalActivityInfo | undefined;
  outputActive: boolean;
  hasUnreadNotification: boolean;
  claudeMessage: string | undefined;
}

export interface WorkspaceSummary {
  workspaceId: string;
  branch: string | null;
  cwd: string | null;
  ports: number[];
  unreadCount: number;
  latestNotification: Notification | null;
  hasUnread: boolean;
  lastCommand: LastCommandInfo | null;
  terminalCount: number;
  terminalSummaries: TerminalSummaryInfo[];
}

export function getBranchForWorkspace(terminals: TerminalInstance[]): string | null {
  const sorted = [...terminals].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return sorted[0]?.branch ?? null;
}

export function getCwdForWorkspace(terminals: TerminalInstance[]): string | null {
  const focused = terminals.find((t) => t.isFocused);
  if (focused) return focused.cwd ?? null;

  const sorted = [...terminals].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return sorted[0]?.cwd ?? null;
}

export function getPortsForWorkspace(terminalPorts: Map<string, number[]>): number[] {
  const all = new Set<number>();
  for (const ports of terminalPorts.values()) {
    ports.forEach((p) => all.add(p));
  }
  return [...all].sort((a, b) => a - b);
}

export function getLastCommandForWorkspace(terminals: TerminalInstance[]): LastCommandInfo | null {
  const withCommand = terminals.filter((t) => t.lastCommand);
  if (withCommand.length === 0) return null;

  const sorted = [...withCommand].sort((a, b) => (b.lastCommandAt ?? 0) - (a.lastCommandAt ?? 0));
  const t = sorted[0];
  return {
    command: t.lastCommand!,
    exitCode: t.lastExitCode,
    timestamp: t.lastCommandAt ?? t.lastActivityAt,
    outputActive: t.outputActive,
    activity: t.activity,
    title: t.title,
    claudeMessage: t.claudeMessage,
  };
}

export function formatCommand(cmd: string, maxLen = 30): string {
  const trimmed = cmd.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(0, maxLen - 1) + "…";
}

export function computeWorkspaceSummary(
  workspaceId: string,
  terminals: TerminalInstance[],
  terminalPorts: Map<string, number[]>,
  notifications: Notification[],
  _workspaceName?: string,
): WorkspaceSummary {
  const wsTerminals = terminals.filter((t) => t.workspaceId === workspaceId);
  const wsNotifications = notifications.filter((n) => n.workspaceId === workspaceId);
  const unread = wsNotifications.filter((n) => n.readAt === null);

  const sortedTerminals = [...wsTerminals].sort((a, b) => b.lastActivityAt - a.lastActivityAt);

  return {
    workspaceId,
    branch: getBranchForWorkspace(wsTerminals),
    cwd: getCwdForWorkspace(wsTerminals),
    ports: getPortsForWorkspace(terminalPorts),
    unreadCount: unread.length,
    latestNotification: unread.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null,
    hasUnread: unread.length > 0,
    lastCommand: getLastCommandForWorkspace(wsTerminals),
    terminalCount: wsTerminals.length,
    terminalSummaries: sortedTerminals.map((t) => ({
      id: t.id,
      label: t.label,
      profile: t.profile,
      cwd: t.cwd ?? null,
      branch: t.branch ?? null,
      title: t.title,
      lastCommand: t.lastCommand,
      lastExitCode: t.lastExitCode,
      lastCommandAt: t.lastCommandAt,
      activity: t.activity,
      outputActive: t.outputActive ?? false,
      hasUnreadNotification: notifications.some((n) => n.terminalId === t.id && n.readAt === null),
      claudeMessage: t.claudeMessage,
    })),
  };
}

/**
 * Compute workspace summary from backend terminal summaries (single source of truth).
 * This replaces the store-based `computeWorkspaceSummary` for WorkspaceSelectorView.
 */
export function computeWorkspaceSummaryFromBackend(
  workspaceId: string,
  backendSummaries: TerminalSummaryResponse[],
  ports: number[] = [],
): WorkspaceSummary {
  // Map backend summaries to TerminalSummaryInfo
  const terminalSummaries: TerminalSummaryInfo[] = backendSummaries.map((s) => ({
    id: s.id,
    label: abbreviateProfile(s.profile),
    profile: s.profile,
    cwd: s.cwd,
    branch: s.branch,
    title: s.title,
    lastCommand: s.lastCommand ?? undefined,
    lastExitCode: s.lastExitCode ?? undefined,
    lastCommandAt: s.lastCommandAt ?? undefined,
    activity: s.activity as TerminalActivityInfo,
    outputActive: s.outputActive,
    hasUnreadNotification: s.unreadNotificationCount > 0,
    claudeMessage: s.claudeMessage ?? undefined,
  }));

  // Workspace-level aggregation
  const branch = backendSummaries.find((s) => s.branch)?.branch ?? null;
  const cwd = backendSummaries.find((s) => s.cwd)?.cwd ?? null;

  // Last command: pick the most recent
  let lastCommand: LastCommandInfo | null = null;
  for (const s of backendSummaries) {
    if (s.lastCommand && s.lastCommandAt != null) {
      if (!lastCommand || s.lastCommandAt > lastCommand.timestamp) {
        lastCommand = {
          command: s.lastCommand,
          exitCode: s.lastExitCode ?? undefined,
          timestamp: s.lastCommandAt,
          outputActive: s.outputActive,
          activity: s.activity as TerminalActivityInfo,
          title: s.title ?? undefined,
          claudeMessage: s.claudeMessage ?? undefined,
        };
      }
    }
  }

  // Unread notification aggregation
  const unreadCount = backendSummaries.reduce((sum, s) => sum + s.unreadNotificationCount, 0);
  let latestNotification: Notification | null = null;
  for (const s of backendSummaries) {
    if (s.latestNotification) {
      if (!latestNotification || s.latestNotification.createdAt > latestNotification.createdAt) {
        latestNotification = {
          id: String(s.latestNotification.id),
          terminalId: s.latestNotification.terminalId,
          workspaceId,
          message: s.latestNotification.message,
          level: s.latestNotification.level as Notification["level"],
          createdAt: s.latestNotification.createdAt,
          readAt: s.latestNotification.readAt,
        };
      }
    }
  }

  return {
    workspaceId,
    branch,
    cwd,
    ports,
    unreadCount,
    latestNotification,
    hasUnread: unreadCount > 0,
    lastCommand,
    terminalCount: backendSummaries.length,
    terminalSummaries,
  };
}

/** Abbreviate a profile name for compact display (3 chars). */
function abbreviateProfile(profile: string): string {
  const lower = profile.toLowerCase();
  if (lower === "powershell" || lower === "ps") return "PS";
  if (lower.startsWith("wsl")) return "WSL";
  if (lower === "cmd" || lower === "command prompt") return "CMD";
  if (profile.length <= 3) return profile;
  return profile.slice(0, 3);
}

/**
 * Abbreviate a file path for display.
 * @param cwd - The raw path string
 * @param ellipsis - "start" (default) truncates the beginning (shows end), "end" truncates the end (shows beginning)
 */
export function abbreviatePath(cwd: string, ellipsis: "start" | "end" = "start"): string {
  let path = cwd;

  // Strip file:// URI prefix (from OSC 7)
  const fileMatch = path.match(/^file:\/\/[^/]*\/(.*)/);
  if (fileMatch) {
    path = fileMatch[1];
  }

  // Strip WSL UNC prefix: //wsl.localhost/Distro/... → /...
  const wslMatch = path.match(/^\/\/wsl\.localhost\/[^/]+(\/.*)/);
  if (wslMatch) {
    path = wslMatch[1];
  }

  // Normalize forward slashes for Windows drive paths: C:/Users → C:\Users
  if (/^[A-Za-z]:\//.test(path)) {
    path = path.replace(/\//g, "\\");
  }

  // Abbreviate Unix/WSL home directory: /home/user/... → ~/...
  const unixHome = path.match(/^\/home\/[^/]+(\/.*)?$/);
  if (unixHome) {
    const rest = unixHome[1] ?? "";
    return rest ? "~" + rest : "~";
  }

  // Abbreviate Windows home directory: C:\Users\name\... → ~/...
  const winHome = path.match(/^[A-Za-z]:\\Users\\[^\\]+(\\.*)?$/);
  if (winHome) {
    const rest = winHome[1] ?? "";
    return rest ? "~" + rest.replace(/\\/g, "/") : "~";
  }

  // Truncate long paths
  if (path.length > 30) {
    const sep = path.includes("/") ? "/" : "\\";
    const parts = path.split(sep);
    if (ellipsis === "end") {
      // Keep beginning, truncate end
      return parts.slice(0, 3).join(sep) + sep + "...";
    }
    // Default: keep end, truncate beginning
    return "..." + sep + parts.slice(-2).join(sep);
  }

  return path;
}

/**
 * Convert a `/mnt/X/...` WSL mount path to a Windows path `X:\...`.
 * Returns the original path unchanged if it's not a `/mnt/X/...` pattern.
 */
export function mntPathToWindows(path: string): string {
  const match = path.match(/^\/mnt\/([a-zA-Z])(\/.*)?$/);
  if (!match) return path;
  const drive = match[1].toUpperCase();
  const tail = match[2] ? match[2].replace(/\//g, "\\") : "\\";
  return `${drive}:${tail}`;
}

export function formatPorts(ports: number[], maxDisplay = 5): string {
  if (ports.length === 0) return "";
  if (ports.length <= maxDisplay) {
    return ports.map((p) => `:${p}`).join("  ");
  }
  const shown = ports
    .slice(0, maxDisplay)
    .map((p) => `:${p}`)
    .join("  ");
  return `${shown}  +${ports.length - maxDisplay}`;
}

/** Get a display label for terminal activity state. */
export function formatActivity(
  activity: TerminalActivityInfo | undefined,
  title?: string,
): {
  label: string;
  color: string;
  claudeMode?: ClaudeMode;
  ralph?: boolean;
} {
  if (!activity) return { label: "shell", color: "var(--text-secondary)" };
  switch (activity.type) {
    case "shell":
      return { label: "shell", color: "var(--text-secondary)" };
    case "running":
      return { label: "running", color: "var(--yellow)" };
    case "interactiveApp": {
      if (activity.name === "Claude") {
        const mode = parseClaudeMode(title, activity);
        const ralph = isRalphActive(title);
        return { label: "Claude", color: "#D97757", claudeMode: mode, ralph };
      }
      return { label: activity.name ?? "app", color: "var(--accent)" };
    }
  }
}

export interface CommandStatus {
  icon: string; // "⏳" | "✓" | "✗"
  color: string; // CSS color value
  text?: string; // display text override (e.g., Claude ● message)
}

/**
 * Compute final command status display from raw terminal states.
 *
 * Each system writes its own raw state independently:
 *   - OSC 133;D → exitCode (shell owns this)
 *   - OSC 0/2  → title (used for Claude idle/working detection)
 *   - activity  → shell/running/interactiveApp
 *
 * This function is the single place that collapses them into ✓/⏳/✗.
 */
export function computeCommandStatus(
  exitCode: number | undefined,
  outputActive: boolean | undefined,
  activity: TerminalActivityInfo | undefined,
  title: string | undefined,
  claudeMessage?: string,
): CommandStatus {
  // Interactive app: Claude uses title idle detection, others always ⏳
  if (activity?.type === "interactiveApp") {
    if (activity.name === "Claude" && title && isClaudeIdle(title)) {
      return { icon: "✓", color: "var(--green)", text: claudeMessage };
    }
    if (activity.name === "Claude") {
      return { icon: "⏳", color: "var(--yellow)", text: claudeMessage };
    }
    return { icon: "⏳", color: "var(--yellow)" };
  }

  // Shell command
  if (exitCode === undefined) return { icon: "⏳", color: "var(--yellow)" };
  if (outputActive) return { icon: "⏳", color: "var(--yellow)" };
  if (activity?.type === "running") return { icon: "⏳", color: "var(--yellow)" };
  return exitCode === 0 ? { icon: "✓", color: "var(--green)" } : { icon: "✗", color: "var(--red)" };
}

export function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return "방금";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}분 전`;
  return `${Math.floor(diff / 3600000)}시간 전`;
}
