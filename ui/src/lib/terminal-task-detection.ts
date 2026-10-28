import type { TerminalInstance } from "@/stores/terminal-store";
import { withClaudeTurnResult } from "./claude-turn-result";
import { withGrokTurnResult } from "./grok-turn-result";
import type { TerminalTask } from "./terminal-task";

const staleHooks = new WeakMap<TerminalTask, TerminalTask>();

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
  const fallback = withClaudeTurnResult(heuristicTask(instance), instance.claudeTurns?.heuristic);
  const hookStale =
    hook &&
    (now - hook.verifiedAt >= 6000 ||
      ((hook.task.state === "running" || hook.task.state === "waiting") &&
        now - hook.snapshot.observedAtMs > 60000));
  const turn = instance.codexTurn;
  const recordedScopeMatches =
    hook?.snapshot.provider !== "codex" ||
    !turn ||
    fallback?.taskId !== turn.turnId ||
    (turn.generation === hook.snapshot.generation &&
      turn.sessionId === hook.snapshot.sessionId &&
      (!hook.snapshot.turnId || turn.turnId === hook.snapshot.turnId));
  const newerFallback =
    hook &&
    fallback?.observation === "confirmed" &&
    fallback.observedAt > hook.snapshot.observedAtMs &&
    (fallback.expiresAfter === undefined || now - fallback.observedAt < fallback.expiresAfter) &&
    recordedScopeMatches &&
    (hook.task.state !== "waiting" || fallback.state === "waiting" || fallback.state === "ended");
  const usable =
    mode === "hooks" &&
    hook &&
    instance.sessionReady !== false &&
    instance.generation === hook.snapshot.generation &&
    instance.activity?.type === "interactiveApp" &&
    instance.activity.name?.toLowerCase() === hook.snapshot.provider &&
    (now - hook.verifiedAt < 6000 || hook.snapshot.verifiedAtMs !== undefined) &&
    hook.snapshot.observedAtMs >= (instance.lastUserInputAt ?? 0) &&
    (hook.snapshot.verifiedAtMs !== undefined ||
      hook.snapshot.state === "idle" ||
      hook.snapshot.state === "ended" ||
      now - hook.snapshot.observedAtMs <= 60000) &&
    !(hookStale && newerFallback);
  let task = usable
    ? hook.snapshot.provider === "codex"
      ? withCodexTurnResult(instance)
      : hook.snapshot.provider === "grok"
        ? withGrokTurnResult(instance)
        : withClaudeTurnResult(hook.task, instance.claudeTurns?.hook)
    : fallback;
  if (
    usable &&
    task &&
    (now - hook.verifiedAt >= 6000 ||
      ((task.state === "running" || task.state === "waiting") &&
        now - hook.snapshot.observedAtMs > 60000))
  ) {
    let stale = staleHooks.get(task);
    if (!stale) {
      stale = { ...task, observation: "stale" };
      staleHooks.set(task, stale);
    }
    task = stale;
  }
  const taskDetectionSource = usable ? "hooks" : "heuristic";
  return instance.task === task && instance.taskDetectionSource === taskDetectionSource
    ? instance
    : { ...instance, task, taskDetectionSource };
}
