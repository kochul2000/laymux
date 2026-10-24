import type { TerminalInstance } from "@/stores/terminal-store";
import { withClaudeTurnResult } from "./claude-turn-result";
import type { TerminalTask } from "./terminal-task";

const mergedCodex = new WeakMap<
  NonNullable<TerminalInstance["task"]>,
  NonNullable<TerminalInstance["task"]>
>();

function withCodexTurnResult(instance: TerminalInstance) {
  const hook = instance.agentHook!;
  const task = hook.task;
  const turn = instance.codexTurn;
  const recorded = heuristicTask(instance);
  if (
    task.state !== "ended" ||
    task.result ||
    recorded?.observation !== "confirmed" ||
    recorded.taskId !== turn?.turnId ||
    !hook.snapshot.turnId ||
    turn?.generation !== hook.snapshot.generation ||
    turn.sessionId !== hook.snapshot.sessionId ||
    turn.turnId !== hook.snapshot.turnId
  )
    return task;
  const result =
    turn.state === "completed"
      ? "success"
      : turn.state === "failed"
        ? "failure"
        : turn.state === "interrupted"
          ? "interrupted"
          : undefined;
  if (!result) return task;
  const cached = mergedCodex.get(task);
  if (cached?.result === result) return cached;
  const next: TerminalTask = { ...task, result };
  mergedCodex.set(task, next);
  return next;
}

export function heuristicTask(instance: TerminalInstance) {
  return (
    instance.heuristicTask ?? (instance.taskDetectionSource !== "hooks" ? instance.task : undefined)
  );
}

/** Raw adapters remain independent; only this function chooses the displayed task. */
export function selectDetectedTask(
  instance: TerminalInstance,
  mode: "heuristic" | "hooks",
  now = Date.now(),
): TerminalInstance {
  const hook = instance.agentHook;
  const usable =
    mode === "hooks" &&
    hook &&
    instance.sessionReady !== false &&
    instance.generation === hook.snapshot.generation &&
    instance.activity?.type === "interactiveApp" &&
    instance.activity.name?.toLowerCase() === hook.snapshot.provider &&
    now - hook.verifiedAt < 6000 &&
    hook.snapshot.observedAtMs >= (instance.lastUserInputAt ?? 0) &&
    (hook.snapshot.state === "idle" ||
      hook.snapshot.state === "ended" ||
      now - hook.snapshot.observedAtMs <= 60000);
  const task = usable
    ? hook.snapshot.provider === "codex"
      ? withCodexTurnResult(instance)
      : withClaudeTurnResult(hook.task, instance.claudeTurns?.hook)
    : withClaudeTurnResult(heuristicTask(instance), instance.claudeTurns?.heuristic);
  const taskDetectionSource = usable ? "hooks" : "heuristic";
  return instance.task === task && instance.taskDetectionSource === taskDetectionSource
    ? instance
    : { ...instance, task, taskDetectionSource };
}
