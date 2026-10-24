import type { TerminalInstance } from "@/stores/terminal-store";
import type { TerminalTask } from "./terminal-task";

const completed = new WeakMap<TerminalTask, TerminalTask>();
const running = new WeakMap<TerminalTask, TerminalTask>();

/** A Grok Stop gate does not prove completion: correlate the committed turn. */
export function withGrokTurnResult(instance: TerminalInstance): TerminalTask {
  const hook = instance.agentHook!;
  const task = hook.task;
  const record = instance.grokTurn;
  if (
    !task.result &&
    record?.status === "ended" &&
    record.generation === hook.snapshot.generation &&
    record.sessionId === hook.snapshot.sessionId &&
    !!record.turnId &&
    record.turnId === hook.snapshot.turnId
  ) {
    const cached = completed.get(task);
    if (cached?.state === "ended" && cached.result === record.result) return cached;
    const transition = task.state !== "ended" && task.lastRunningAt !== undefined;
    const next: TerminalTask = {
      ...task,
      state: "ended",
      result: record.result,
      notification: transition ? "ended" : task.notification,
      notificationId: task.notificationId + (transition ? 1 : 0),
    };
    completed.set(task, next);
    return next;
  }
  // A synthetic completion can advance the displayed notification counter.
  // A subsequent running snapshot must not republish old waiting/end history.
  if (task.state === "running" && task.notification) {
    let next = running.get(task);
    if (!next) {
      next = { ...task, notification: undefined };
      running.set(task, next);
    }
    return next;
  }
  return task;
}
