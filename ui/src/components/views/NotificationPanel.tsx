import { useNotificationStore, type NotificationLevel } from "@/stores/notification-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useTerminalStore } from "@/stores/terminal-store";
import { formatRelativeTime } from "@/lib/workspace-summary";
import { ViewShell } from "@/components/ui/ViewShell";
import { ViewHeader } from "@/components/ui/ViewHeader";
import { ViewBody } from "@/components/ui/ViewBody";

const levelColorMap: Record<NotificationLevel, string> = {
  error: "var(--red)",
  success: "var(--green)",
  warning: "var(--yellow)",
  info: "var(--text-primary)",
};

interface NotificationPanelProps {
  workspaceId?: string;
}

export function NotificationPanel({ workspaceId }: NotificationPanelProps = {}) {
  const allNotifications = useNotificationStore((s) => s.notifications);
  const notifications = workspaceId
    ? allNotifications.filter((n) => n.workspaceId === workspaceId)
    : allNotifications;
  const markWorkspaceAsRead = useNotificationStore((s) => s.markWorkspaceAsRead);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const terminalInstances = useTerminalStore((s) => s.instances);

  // Reverse for newest-first, then stable-sort unread above read
  const sorted = [...notifications].reverse().sort((a, b) => {
    const aUnread = a.readAt === null ? 0 : 1;
    const bUnread = b.readAt === null ? 0 : 1;
    return aUnread - bUnread;
  });
  const workspaceIds = [...new Set(sorted.map((n) => n.workspaceId))];

  return (
    <ViewShell testId="notification-panel" style={{ color: "var(--text-primary)" }}>
      <ViewHeader className="justify-between px-2" testId="notification-header">
        <span className="text-sm font-medium">Notifications</span>
      </ViewHeader>

      <ViewBody>
        {sorted.length === 0 ? (
          <div
            className="flex h-full items-center justify-center"
            style={{ color: "var(--text-secondary)" }}
          >
            <p className="text-xs">No notifications</p>
          </div>
        ) : (
          <div className="flex flex-col">
            {workspaceIds.map((wsId) => {
              const wsNotifs = sorted.filter((n) => n.workspaceId === wsId);
              const hasUnread = wsNotifs.some((n) => n.readAt === null);
              return (
                <div key={wsId}>
                  <div
                    className="flex items-center justify-between px-3 py-1"
                    style={{
                      background: "var(--bg-surface)",
                      borderBottom: "1px solid var(--border)",
                    }}
                  >
                    <span
                      className="text-xs font-medium"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      {workspaces.find((w) => w.id === wsId)?.name ?? wsId}
                    </span>
                    {hasUnread && (
                      <button
                        data-testid={`mark-read-${wsId}`}
                        onClick={() => markWorkspaceAsRead(wsId)}
                        className="cursor-pointer text-xs"
                        style={{
                          color: "var(--accent)",
                          background: "none",
                          border: "none",
                        }}
                      >
                        Mark read
                      </button>
                    )}
                  </div>
                  {wsNotifs.map((n) => {
                    const terminal = terminalInstances.find((t) => t.id === n.terminalId);
                    return (
                      <div
                        key={n.id}
                        data-testid={`notification-item-${n.id}`}
                        data-read={n.readAt !== null ? "true" : "false"}
                        className="flex items-start gap-2 px-3 py-1.5"
                        style={{
                          borderBottom: "1px solid var(--border)",
                          opacity: n.readAt !== null ? 0.6 : 1,
                        }}
                      >
                        {/* Terminal label */}
                        <span
                          className="w-14 shrink-0 truncate text-xs"
                          style={{ color: "var(--text-secondary)" }}
                        >
                          [{terminal?.label ?? "?"}]
                        </span>

                        {/* Message with level color */}
                        <span
                          className="flex-1 truncate text-xs"
                          style={{ color: levelColorMap[n.level] }}
                        >
                          {n.message}
                        </span>

                        {/* Relative time */}
                        <span
                          className="shrink-0 text-xs"
                          style={{ color: "var(--text-secondary)" }}
                        >
                          {formatRelativeTime(n.createdAt)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </ViewBody>
    </ViewShell>
  );
}
