import { create } from "zustand";
// Cross-store reads (getState snapshots) — direction: notification → {workspace, settings, grid}
// Keep this unidirectional to avoid circular dependency issues.
import { useWorkspaceStore } from "./workspace-store";
import { useSettingsStore } from "./settings-store";
import { useGridStore } from "./grid-store";

export type NotificationLevel = "info" | "error" | "warning" | "success";

export interface Notification {
  id: string;
  terminalId: string;
  workspaceId: string;
  message: string;
  level: NotificationLevel;
  createdAt: number;
  readAt: number | null;
  /**
   * When true, this notification represents a state that needs explicit
   * user action (e.g. answering a TUI permission modal). Such alerts are
   * exempt from the auto-dismiss / workspace-mark-read policy so the
   * unread badge stays visible until the user has actually responded.
   * Cleared via `markNotificationsAsRead` with an explicit id list (user
   * click) or by the originator when the underlying state resolves.
   */
  requiresAction?: boolean;
}

let notifId = 0;

interface NotificationStoreState {
  notifications: Notification[];

  addNotification: (params: {
    terminalId: string;
    workspaceId: string;
    message: string;
    level?: NotificationLevel;
    requiresAction?: boolean;
  }) => Notification;
  markWorkspaceAsRead: (workspaceId: string) => void;
  markNotificationsAsRead: (ids: string[]) => void;
  /** Remove notifications by ID. Returns the number of notifications actually removed. */
  removeNotifications: (ids: string[]) => number;
  /**
   * Remove notifications created strictly before `timestamp` (epoch ms).
   * When `readOnly` is true, only already-read notifications (readAt != null)
   * are removed. Returns the number of notifications actually removed.
   */
  clearNotificationsBefore: (timestamp: number, readOnly?: boolean) => number;
  getUnreadCount: (workspaceId: string) => number;
  getLatestNotification: (workspaceId: string) => Notification | undefined;
  hasUnreadForTerminal: (terminalId: string) => boolean;
}

export const useNotificationStore = create<NotificationStoreState>()((set, get) => ({
  notifications: [],

  addNotification: ({ terminalId, workspaceId, message, level, requiresAction }) => {
    const now = Date.now();
    const dismissMode = useSettingsStore.getState().convenience.notificationDismiss;
    const activeWsId = useWorkspaceStore.getState().activeWorkspaceId;

    // requiresAction alerts never auto-dismiss: they exist precisely to
    // grab attention until the user has actually responded (e.g. a Claude
    // permission modal). The default policy auto-clears alerts whose
    // workspace happens to be active right now, which would hide the
    // badge before the user could see it.
    const shouldAutoDismiss =
      !requiresAction &&
      workspaceId === activeWsId &&
      (dismissMode === "workspace" ||
        (dismissMode === "paneFocus" && useGridStore.getState().focusedPaneIndex !== null));

    const notification: Notification = {
      id: `notif-${++notifId}`,
      terminalId,
      workspaceId,
      message,
      level: level ?? "info",
      createdAt: now,
      readAt: shouldAutoDismiss ? now : null,
      ...(requiresAction ? { requiresAction: true } : {}),
    };
    set((state) => ({
      notifications: [...state.notifications, notification],
    }));
    return notification;
  },

  markWorkspaceAsRead: (workspaceId) => {
    const now = Date.now();
    set((state) => ({
      notifications: state.notifications.map((n) =>
        // Skip requiresAction alerts — they only clear via explicit user
        // click (markNotificationsAsRead) or when the originator resolves
        // the underlying state. Otherwise opening the workspace would
        // hide a still-active modal alert.
        n.workspaceId === workspaceId && n.readAt === null && !n.requiresAction
          ? { ...n, readAt: now }
          : n,
      ),
    }));
  },

  markNotificationsAsRead: (ids) => {
    const idSet = new Set(ids);
    const now = Date.now();
    set((state) => ({
      notifications: state.notifications.map((n) =>
        idSet.has(n.id) && n.readAt === null ? { ...n, readAt: now } : n,
      ),
    }));
  },

  removeNotifications: (ids) => {
    const idSet = new Set(ids);
    const before = get().notifications.length;
    const remaining = get().notifications.filter((n) => !idSet.has(n.id));
    const cleared = before - remaining.length;
    if (cleared > 0) {
      set({ notifications: remaining });
    }
    return cleared;
  },

  clearNotificationsBefore: (timestamp, readOnly = false) => {
    const before = get().notifications.length;
    const remaining = get().notifications.filter((n) => {
      const isOlder = n.createdAt < timestamp;
      if (!isOlder) return true;
      // Keep older notifications only if readOnly filter excludes them (still unread).
      if (readOnly && n.readAt === null) return true;
      return false;
    });
    const cleared = before - remaining.length;
    if (cleared > 0) {
      set({ notifications: remaining });
    }
    return cleared;
  },

  getUnreadCount: (workspaceId) => {
    return get().notifications.filter((n) => n.workspaceId === workspaceId && n.readAt === null)
      .length;
  },

  getLatestNotification: (workspaceId) => {
    const notifs = get().notifications.filter((n) => n.workspaceId === workspaceId);
    return notifs.length > 0 ? notifs[notifs.length - 1] : undefined;
  },

  hasUnreadForTerminal: (terminalId) => {
    return get().notifications.some((n) => n.terminalId === terminalId && n.readAt === null);
  },
}));
