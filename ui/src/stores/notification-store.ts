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
}

let notifId = 0;

interface NotificationStoreState {
  notifications: Notification[];

  addNotification: (params: {
    terminalId: string;
    workspaceId: string;
    message: string;
    level?: NotificationLevel;
  }) => void;
  markWorkspaceAsRead: (workspaceId: string) => void;
  markNotificationsAsRead: (ids: string[]) => void;
  getUnreadCount: (workspaceId: string) => number;
  getLatestNotification: (workspaceId: string) => Notification | undefined;
  hasUnreadForTerminal: (terminalId: string) => boolean;
}

export const useNotificationStore = create<NotificationStoreState>()((set, get) => ({
  notifications: [],

  addNotification: ({ terminalId, workspaceId, message, level }) => {
    const now = Date.now();
    const dismissMode = useSettingsStore.getState().convenience.notificationDismiss;
    const activeWsId = useWorkspaceStore.getState().activeWorkspaceId;

    const shouldAutoDismiss =
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
    };
    set((state) => ({
      notifications: [...state.notifications, notification],
    }));
  },

  markWorkspaceAsRead: (workspaceId) => {
    const now = Date.now();
    set((state) => ({
      notifications: state.notifications.map((n) =>
        n.workspaceId === workspaceId && n.readAt === null ? { ...n, readAt: now } : n,
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
