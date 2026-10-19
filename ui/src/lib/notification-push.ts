import { invoke } from "@tauri-apps/api/core";
import { useNotificationStore, type Notification } from "@/stores/notification-store";

export interface NotificationPushEvent {
  notificationId: string;
  revision: 1 | 2;
  category: "waiting" | "failure" | "complete" | "general";
  body?: string;
}

function category(notification: Notification): NotificationPushEvent["category"] {
  return (
    notification.category ??
    (notification.requiresAction
      ? "waiting"
      : notification.level === "error"
        ? "failure"
        : notification.level === "success"
          ? "complete"
          : "general")
  );
}

/** Subscribe only to future transitions. Initial lists and auto-read arrivals
 * are deliberately different from an explicit user read (ADR-0344). */
export function subscribeNotificationPush(
  send: (event: NotificationPushEvent) => Promise<unknown> = (event) =>
    invoke("publish_notification_push", { event }),
): () => void {
  const queue: NotificationPushEvent[] = [];
  let running = false;
  let stopped = false;
  async function drain() {
    if (running) return;
    running = true;
    try {
      while (!stopped && queue.length) {
        const event = queue.shift()!;
        try {
          await send(event);
        } catch {
          /* Remote failure cannot block local notifications. */
        }
      }
    } finally {
      running = false;
    }
  }
  function enqueue(notification: Notification, revision: 1 | 2) {
    // Finite backlog; Cloud has its own durable delivery/retry queue.
    if (queue.length >= 256) queue.shift();
    queue.push({
      notificationId: notification.id,
      revision,
      category: category(notification),
      ...(revision === 1 ? { body: [...notification.message].slice(0, 500).join("") } : {}),
    });
    void drain();
  }
  const unsubscribe = useNotificationStore.subscribe((state, previous) => {
    const before = new Map(previous.notifications.map((n) => [n.id, n]));
    const after = new Map(state.notifications.map((n) => [n.id, n]));
    for (const notification of state.notifications) {
      const prior = before.get(notification.id);
      if (!prior) enqueue(notification, 1);
      else if (prior.readAt === null && notification.readAt !== null) enqueue(notification, 2);
    }
    for (const notification of previous.notifications) {
      if (!after.has(notification.id)) enqueue(notification, 2);
    }
  });
  return () => {
    stopped = true;
    queue.length = 0;
    unsubscribe();
  };
}
