import { useTerminalStore } from "@/stores/terminal-store";
import { isClaudeWorkingTitle } from "./claude-activity-handler";
import { isGrokWorkingTitle } from "./grok-activity-handler";
import { taskSource, type TaskObservation } from "./terminal-task";

export function observeTerminalTask(
  id: string,
  input: Omit<TaskObservation, "source" | "sequence" | "taskId"> &
    Partial<Pick<TaskObservation, "source" | "taskId">>,
) {
  const store = useTerminalStore.getState();
  const instance = store.instances.find((entry) => entry.id === id);
  if (!instance) return;
  store.observeTask(id, {
    ...input,
    source: input.source ?? taskSource(instance),
    taskId: input.taskId ?? instance.task?.taskId ?? "0",
    sequence: (instance.task?.sequence ?? 0) + 1,
  });
}

/** Only call for a newly received title, never for a cached store read. */
export function observeTaskTitle(id: string, title: string) {
  const instance = useTerminalStore.getState().instances.find((entry) => entry.id === id);
  if (!instance || instance.activity?.type !== "interactiveApp") return;
  const { name } = instance.activity;
  if (name !== "Claude" && name !== "Grok") return;
  const task = instance.task;
  const working = name === "Claude" ? isClaudeWorkingTitle(title) : isGrokWorkingTitle(title);
  const idle = name === "Claude" && title.startsWith("✳");
  // A modal remains authoritative until its own detector resolves it.
  if (task?.state === "waiting") return;
  const starts = working && task?.state !== "running";
  observeTerminalTask(id, {
    taskId: starts ? String((task?.sequence ?? 0) + 1) : task?.taskId,
    state: working
      ? "running"
      : idle
        ? task?.state === "running" || task?.state === "ended"
          ? "ended"
          : "idle"
        : undefined,
    expiresAfter: working ? 6000 : undefined,
  });
}

/** The output adapter supplies a scoped observation, never a message marker. */
export function observeTaskInput(id: string, pending: boolean) {
  const instance = useTerminalStore.getState().instances.find((entry) => entry.id === id);
  if (!instance || !["Claude", "Codex"].includes(instance.activity?.name ?? "")) return;
  if (pending === (instance.task?.state === "waiting")) return;
  if (instance.task?.state === "ended") return;
  observeTerminalTask(id, {
    kind: "input",
    source: instance.task?.source ?? taskSource(instance),
    state: pending ? "waiting" : "running",
    resolvesWaiting: !pending,
    // A resolved Claude modal needs a fresh title; the old ✳ is not completion.
    expiresAfter: instance.activity?.name === "Claude" && !pending ? 6000 : undefined,
  });
}
