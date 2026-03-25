import type { Notification } from "@/stores/notification-store";

export interface NotificationNavTarget {
  workspaceId: string;
  terminalId: string;
  notificationIds: string[];
}

/**
 * Find the navigation target for notification-based pane navigation.
 *
 * - "recent": most recent unread notification first (descending by createdAt)
 * - "oldest": oldest unread notification first (ascending by createdAt)
 *
 * Consecutive notifications from the same terminal (in sorted order) are
 * grouped together so they can all be consumed in one navigation step.
 */
export function findNotificationNavTarget(
  notifications: Notification[],
  direction: "recent" | "oldest",
): NotificationNavTarget | null {
  const unread = notifications.filter((n) => n.navigatedAt === null);
  if (unread.length === 0) return null;

  const sorted = [...unread].sort((a, b) =>
    direction === "recent" ? b.createdAt - a.createdAt : a.createdAt - b.createdAt,
  );

  const first = sorted[0];
  const targetTerminalId = first.terminalId;

  // Collect consecutive notifications from the same terminal
  const ids: string[] = [first.id];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].terminalId === targetTerminalId) {
      ids.push(sorted[i].id);
    } else {
      break;
    }
  }

  return {
    workspaceId: first.workspaceId,
    terminalId: first.terminalId,
    notificationIds: ids,
  };
}
