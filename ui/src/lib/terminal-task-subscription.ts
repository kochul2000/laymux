import { useTerminalStore } from "@/stores/terminal-store";
import { useNotificationStore } from "@/stores/notification-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { sendDesktopNotification } from "@/hooks/useOsNotification";
import { persistSession } from "./persist-session";
import { resolveWorkspaceId } from "./workspace-utils";
import { observeTerminalTask } from "./terminal-task-observers";

/** Sole publisher of automatic task notifications (ADR-0250). */
export function subscribeTerminalTasks(): () => void {
  const unsubscribe = useTerminalStore.subscribe((state, previous) => {
    for (const instance of state.instances) {
      const before = previous.instances.find((entry) => entry.id === instance.id)?.task;
      const task = instance.task;
      if (before?.state === "waiting" && task?.state !== "waiting") {
        const store = useNotificationStore.getState();
        store.markNotificationsAsRead(
          store.notifications
            .filter(
              (entry) =>
                entry.terminalId === instance.id && entry.requiresAction && entry.readAt === null,
            )
            .map((entry) => entry.id),
        );
      }
      if (
        !task?.notification ||
        task.source !== before?.source ||
        task.notificationId === before.notificationId
      )
        continue;
      const waiting = task.notification === "waiting";
      const level = waiting
        ? "info"
        : task.result === "success"
          ? "success"
          : task.result === "failure"
            ? "error"
            : task.result === "interrupted"
              ? "warning"
              : "info";
      const name = instance.activity?.name ?? instance.lastCommand ?? "작업";
      const message = waiting
        ? `${name}: 입력 대기`
        : `${name}: 종료${task.result === "success" ? " (성공)" : task.result === "failure" ? " (실패)" : task.result === "interrupted" ? " (중단)" : " (결과 미관측)"}`;
      const workspaceId = resolveWorkspaceId(instance.id);
      useNotificationStore.getState().addNotification({
        terminalId: instance.id,
        workspaceId,
        message,
        level,
        requiresAction: waiting,
      });
      if (!waiting) void persistSession({ reason: "completion" });
      if (!document.hasFocus() || useWorkspaceStore.getState().activeWorkspaceId !== workspaceId)
        void sendDesktopNotification("Laymux", message);
    }
  });
  const timer = setInterval(() => {
    for (const instance of useTerminalStore.getState().instances) {
      const task = instance.task;
      if (
        task?.observation === "confirmed" &&
        task.expiresAfter !== undefined &&
        Date.now() - task.observedAt >= task.expiresAfter
      ) {
        observeTerminalTask(instance.id, { source: task.source, state: undefined });
      }
    }
  }, 1000);
  return () => {
    unsubscribe();
    clearInterval(timer);
  };
}
