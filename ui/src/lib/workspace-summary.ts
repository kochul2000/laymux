import type { TerminalInstance, TerminalActivityInfo } from "@/stores/terminal-store";
import type { Notification } from "@/stores/notification-store";

export interface LastCommandInfo {
  command: string;
  exitCode: number | undefined; // undefined = still running
  timestamp: number;
}

export interface TerminalSummaryInfo {
  id: string;
  label: string;
  profile: string;
  cwd: string | null;
  branch: string | null;
  lastCommand: string | undefined;
  lastExitCode: number | undefined;
  lastCommandAt: number | undefined;
  activity: TerminalActivityInfo | undefined;
  outputActive: boolean;
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

export function getBranchForWorkspace(
  terminals: TerminalInstance[],
): string | null {
  const sorted = [...terminals].sort(
    (a, b) => b.lastActivityAt - a.lastActivityAt,
  );
  return sorted[0]?.branch ?? null;
}

export function getCwdForWorkspace(
  terminals: TerminalInstance[],
): string | null {
  const focused = terminals.find((t) => t.isFocused);
  if (focused) return focused.cwd ?? null;

  const sorted = [...terminals].sort(
    (a, b) => b.lastActivityAt - a.lastActivityAt,
  );
  return sorted[0]?.cwd ?? null;
}

export function getPortsForWorkspace(
  terminalPorts: Map<string, number[]>,
): number[] {
  const all = new Set<number>();
  for (const ports of terminalPorts.values()) {
    ports.forEach((p) => all.add(p));
  }
  return [...all].sort((a, b) => a - b);
}

export function getLastCommandForWorkspace(
  terminals: TerminalInstance[],
): LastCommandInfo | null {
  const withCommand = terminals.filter((t) => t.lastCommand);
  if (withCommand.length === 0) return null;

  const sorted = [...withCommand].sort(
    (a, b) => (b.lastCommandAt ?? 0) - (a.lastCommandAt ?? 0),
  );
  const t = sorted[0];
  return {
    command: t.lastCommand!,
    exitCode: t.lastExitCode,
    timestamp: t.lastCommandAt ?? t.lastActivityAt,
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
  workspaceName?: string,
): WorkspaceSummary {
  const wsTerminals = terminals.filter(
    (t) => t.workspaceId === workspaceId,
  );
  const wsNotifications = notifications.filter(
    (n) => n.workspaceId === workspaceId,
  );
  const unread = wsNotifications.filter((n) => n.readAt === null);

  const sortedTerminals = [...wsTerminals].sort(
    (a, b) => b.lastActivityAt - a.lastActivityAt,
  );

  return {
    workspaceId,
    branch: getBranchForWorkspace(wsTerminals),
    cwd: getCwdForWorkspace(wsTerminals),
    ports: getPortsForWorkspace(terminalPorts),
    unreadCount: unread.length,
    latestNotification:
      unread.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null,
    hasUnread: unread.length > 0,
    lastCommand: getLastCommandForWorkspace(wsTerminals),
    terminalCount: wsTerminals.length,
    terminalSummaries: sortedTerminals.map((t) => ({
      id: t.id,
      label: t.label,
      profile: t.profile,
      cwd: t.cwd ?? null,
      branch: t.branch ?? null,
      lastCommand: t.lastCommand,
      lastExitCode: t.lastExitCode,
      lastCommandAt: t.lastCommandAt,
      activity: t.activity,
      outputActive: t.outputActive ?? false,
    })),
  };
}

export function abbreviatePath(cwd: string): string {
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
    return ".../" + parts.slice(-2).join("/");
  }

  return path;
}

export function formatPorts(ports: number[], maxDisplay = 5): string {
  if (ports.length === 0) return "";
  if (ports.length <= maxDisplay) {
    return ports.map((p) => `:${p}`).join("  ");
  }
  const shown = ports.slice(0, maxDisplay).map((p) => `:${p}`).join("  ");
  return `${shown}  +${ports.length - maxDisplay}`;
}

/** Get a display label for terminal activity state. */
export function formatActivity(activity: TerminalActivityInfo | undefined): {
  label: string;
  color: string;
} {
  if (!activity) return { label: "shell", color: "var(--text-secondary)" };
  switch (activity.type) {
    case "shell":
      return { label: "shell", color: "var(--text-secondary)" };
    case "running":
      return { label: "running", color: "var(--yellow)" };
    case "interactiveApp":
      if (activity.name === "Claude") {
        return { label: activity.name, color: "#D97757" };
      }
      return { label: activity.name ?? "app", color: "var(--accent)" };
  }
}

export function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return "방금";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}분 전`;
  return `${Math.floor(diff / 3600000)}시간 전`;
}
