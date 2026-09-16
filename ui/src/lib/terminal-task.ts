import i18n from "@/i18n";
import { getCommandStatusIconKind } from "./command-status-icon";
import type { TerminalInstance } from "@/stores/terminal-store";
import type { StatusIconGlyph } from "./activity-markers";

export type TaskState = "idle" | "running" | "waiting" | "ended";
export type TaskResult = "success" | "failure" | "interrupted";
export type ObservationState = "confirmed" | "unknown" | "stale";

/** Adapter input. Missing state explicitly reports an observation failure. */
export interface TaskObservation {
  source: string;
  taskId: string;
  sequence: number;
  state: TaskState | undefined;
  result?: TaskResult;
  resolvesWaiting?: boolean;
  expiresAfter?: number;
  kind?: "input";
}

/** Runtime only; notification history survives observation failures. */
export interface TerminalTask extends TaskObservation {
  observation: ObservationState;
  observedAt: number;
  lastRunningAt?: number;
  notification?: "waiting" | "ended";
  notificationId: number;
}

export function observeTask(
  previous: TerminalTask | undefined,
  input: TaskObservation,
  now: number,
): TerminalTask {
  if (
    input.kind === "input" &&
    previous &&
    (input.source !== previous.source || input.taskId !== previous.taskId)
  )
    return previous;
  const before = previous?.source === input.source ? previous : undefined;
  if (before && input.sequence <= before.sequence) return before;
  const sameTask = before?.taskId === input.taskId;
  if (!input.state) {
    return {
      ...(before ?? input),
      sequence: input.sequence,
      observation: before?.state ? "stale" : "unknown",
      observedAt: before?.observedAt ?? now,
      notificationId: before?.notificationId ?? 0,
    };
  }
  // A closed task cannot be reopened by a late prompt or repeated spinner.
  if (sameTask && before?.state === "ended" && input.state !== "ended") return before;
  const state =
    sameTask && before?.state === "waiting" && input.state === "running" && !input.resolvesWaiting
      ? "waiting"
      : input.state;
  const transition = !!before?.state && (!sameTask || before.state !== state);
  const notification = transition && (state === "waiting" || state === "ended") ? state : undefined;
  return {
    ...input,
    state,
    result:
      state === "ended" ? (input.result ?? (sameTask ? before?.result : undefined)) : undefined,
    observation: "confirmed",
    observedAt: now,
    lastRunningAt: state === "running" ? now : sameTask ? before?.lastRunningAt : undefined,
    notification: notification ?? before?.notification,
    notificationId: (before?.notificationId ?? 0) + (notification ? 1 : 0),
  };
}

export function taskPolicy(
  task: TerminalTask | undefined,
  outputActive: boolean,
  supportedAgent: boolean,
  shellClearException: boolean,
  now = Date.now(),
) {
  const observation: ObservationState =
    task?.observation === "confirmed" &&
    task.expiresAfter !== undefined &&
    now - task.observedAt >= task.expiresAfter
      ? "stale"
      : (task?.observation ?? "unknown");
  const sleepExpired =
    observation === "stale" &&
    task?.state === "running" &&
    now - (task.lastRunningAt ?? 0) >= 60_000;
  const inhibitSleep =
    task?.state === "running"
      ? observation === "confirmed" || (observation === "stale" && !sleepExpired)
      : !supportedAgent && !task?.state && outputActive;
  const clearAllowed =
    (observation === "confirmed" && (task?.state === "idle" || task?.state === "ended")) ||
    (observation === "unknown" && !supportedAgent && shellClearException && !outputActive);
  return {
    state: task?.state,
    result: task?.result,
    observation,
    outputActive,
    inhibitSleep,
    clearAllowed,
    sleepExpired,
  };
}

export function terminalTaskPolicy(instance: TerminalInstance, now = Date.now()) {
  const supported =
    instance.activity?.type === "interactiveApp" &&
    ["Claude", "Codex", "Grok"].includes(instance.activity.name ?? "");
  return taskPolicy(
    instance.task,
    instance.outputActive ?? false,
    supported,
    instance.sessionReady === true &&
      instance.activity?.type === "shell" &&
      instance.livenessConfirmed === true,
    now,
  );
}

export function taskSource(instance: TerminalInstance): string {
  return `${instance.generation ?? 0}:${instance.taskEpoch ?? 0}:${instance.activity?.name ?? "shell"}`;
}

export function taskPresentation(
  task: TerminalTask | undefined,
  now = Date.now(),
): { icon: StatusIconGlyph; color: string; label: string; observation: ObservationState } {
  const { observation } = taskPolicy(task, false, true, false, now);
  let icon: StatusIconGlyph = "?";
  let color = "var(--text-secondary)";
  switch (task?.state) {
    case "idle":
      icon = "—";
      break;
    case "running":
      icon = "⏳";
      color = "var(--yellow)";
      break;
    case "waiting":
      icon = "!";
      color = "var(--yellow)";
      break;
    case "ended":
      icon =
        task.result === "success"
          ? "✓"
          : task.result === "failure"
            ? "✗"
            : task.result === "interrupted"
              ? "⊘"
              : "□";
      color =
        task.result === "success"
          ? "var(--green)"
          : task.result === "failure"
            ? "var(--red)"
            : color;
  }
  const label = i18n.t(`workspace:commandStatus.${getCommandStatusIconKind(icon)}`);
  return {
    icon,
    color,
    label:
      observation === "stale" ? `${label} · ${i18n.t("workspace:commandStatus.stale")}` : label,
    observation,
  };
}
