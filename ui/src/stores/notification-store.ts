import { create } from "zustand";

export type NotificationLevel = "info" | "error" | "warning" | "success";

export interface Notification {
  id: string;
  terminalId: string;
  workspaceId: string;
  message: string;
  level: NotificationLevel;
  createdAt: number;
  readAt: number | null;
  /** Set when consumed via notification navigation (Ctrl+Alt+Arrow). Independent of readAt. */
  navigatedAt: number | null;
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
  markNotificationsNavigated: (ids: string[]) => void;
  getUnreadCount: (workspaceId: string) => number;
  getLatestNotification: (workspaceId: string) => Notification | undefined;
}

export const useNotificationStore = create<NotificationStoreState>()(
  (set, get) => ({
    notifications: [],

    addNotification: ({ terminalId, workspaceId, message, level }) => {
      const notification: Notification = {
        id: `notif-${++notifId}`,
        terminalId,
        workspaceId,
        message,
        level: level ?? "info",
        createdAt: Date.now(),
        readAt: null,
        navigatedAt: null,
      };
      set((state) => ({
        notifications: [...state.notifications, notification],
      }));
    },

    markWorkspaceAsRead: (workspaceId) => {
      const now = Date.now();
      set((state) => ({
        notifications: state.notifications.map((n) =>
          n.workspaceId === workspaceId && n.readAt === null
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

    markNotificationsNavigated: (ids) => {
      const idSet = new Set(ids);
      const now = Date.now();
      set((state) => ({
        notifications: state.notifications.map((n) =>
          idSet.has(n.id) && n.navigatedAt === null
            ? { ...n, navigatedAt: now, readAt: n.readAt ?? now }
            : n,
        ),
      }));
    },

    getUnreadCount: (workspaceId) => {
      return get().notifications.filter(
        (n) => n.workspaceId === workspaceId && n.readAt === null,
      ).length;
    },

    getLatestNotification: (workspaceId) => {
      const notifs = get().notifications.filter(
        (n) => n.workspaceId === workspaceId,
      );
      return notifs.length > 0 ? notifs[notifs.length - 1] : undefined;
    },
  }),
);
