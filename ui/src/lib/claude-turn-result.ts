import type { TerminalInstance } from "@/stores/terminal-store";
import type { TaskResult, TerminalTask } from "./terminal-task";

/**
 * ADR-0340: a Claude transcript result bound to one task. Raw state only; the
 * task selection function is the single place that applies it.
 */
export interface ClaudeTurn {
  /** `claudeTurnKey` of the task this baseline belongs to. */
  key: string;
  /** The backend recorded a baseline; undefined while the request is in flight. */
  tracked?: boolean;
  endedAt?: number;
  result?: TaskResult;
  /** No further lookup: a result was filled or none can be. */
  settled: boolean;
}

/** Heuristic and hook observations are separate tasks, each with its own turn. */
export type ClaudeTurnSource = "heuristic" | "hook";
export type ClaudeTurns = Partial<Record<ClaudeTurnSource, ClaudeTurn>>;

export function claudeTurnKey(task: Pick<TerminalTask, "source" | "taskId">): string {
  return `${task.source}\u0000${task.taskId}`;
}

/** The turn still owes its task a result. */
export function claudeTurnPending(task: TerminalTask | undefined, turn: ClaudeTurn | undefined) {
  return (
    !!task &&
    !!turn &&
    task.state === "ended" &&
    !task.result &&
    !turn.settled &&
    turn.tracked !== false &&
    turn.key === claudeTurnKey(task)
  );
}

/** The displayed task still owes a result from either turn. */
export function claudeTurnsPending(instance: TerminalInstance) {
  const task = instance.task;
  return (
    claudeTurnPending(task, instance.claudeTurns?.heuristic) ||
    claudeTurnPending(task, instance.claudeTurns?.hook)
  );
}

const merged = new WeakMap<TerminalTask, TerminalTask>();

/** Fill an ended task's missing result from the turn bound to the same key. */
export function withClaudeTurnResult(
  task: TerminalTask | undefined,
  turn: ClaudeTurn | undefined,
): TerminalTask | undefined {
  if (!task || !turn?.result || task.state !== "ended" || task.result) return task;
  if (turn.key !== claudeTurnKey(task)) return task;
  const cached = merged.get(task);
  if (cached?.result === turn.result) return cached;
  const next = { ...task, result: turn.result };
  merged.set(task, next);
  return next;
}
