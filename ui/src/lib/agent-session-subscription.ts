import { getAgentSessionStates, type AgentSessionState } from "./tauri-api";
import { useTerminalStore, type TerminalInstance } from "@/stores/terminal-store";
import { observeTerminalTask } from "./terminal-task-observers";
import { heuristicTask } from "./terminal-task-detection";
import type { TaskState } from "./terminal-task";
import { useSettingsStore } from "@/stores/settings-store";
import { onTaskStateRefresh } from "./task-state-refresh";

const POLL_MS = 1000;

function recordedAgent(instance: TerminalInstance): "Claude" | "Grok" | undefined {
  if (instance.sessionReady === false || instance.activity?.type !== "interactiveApp") return;
  const { name } = instance.activity;
  return name === "Claude" || name === "Grok" ? name : undefined;
}

/** Any change here means the read no longer describes the current task. */
function stamp(instance: TerminalInstance): string {
  const task = heuristicTask(instance);
  return [
    instance.generation,
    instance.taskEpoch,
    instance.lastUserInputAt,
    recordedAgent(instance),
    task?.source,
    task?.sequence,
  ].join(":");
}

/**
 * ADR-0321: Claude and Grok record their task state in their own session
 * files. While no title confirms a pane's state (after a re-attach, after a
 * hook expires, or a Grok turn end, which its title never reports), the
 * record supplies it. The record keeps that state until the title or input
 * reports again.
 */
export function subscribeAgentSessionStates(): () => void {
  let disposed = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Heuristic task sequence this subscription last wrote, per terminal.
  const owned = new Map<string, number>();
  const requested = new Set<string>();

  function needsRecord(instance: TerminalInstance, now: number): boolean {
    if (!recordedAgent(instance)) return false;
    if (
      recordedAgent(instance) === "Grok" &&
      useSettingsStore.getState().grok.stateDetection === "hooks"
    )
      return true;
    const task = heuristicTask(instance);
    if (!task || task.observation !== "confirmed") return true;
    if (task.expiresAfter !== undefined && now - task.observedAt >= task.expiresAfter) return true;
    return owned.get(instance.id) === task.sequence;
  }

  function apply(instance: TerminalInstance, record: AgentSessionState) {
    if (recordedAgent(instance) === "Grok") {
      const before = instance.grokTurn;
      if (
        !before ||
        before.generation !== record.generation ||
        before.sessionId !== record.sessionId ||
        before.turnId !== record.turnId ||
        before.status !== record.status ||
        before.result !== record.result
      ) {
        useTerminalStore.getState().updateInstanceInfo(instance.id, { grokTurn: record });
      }
    }
    // A dialog's own detector owns waiting; the record cannot resolve it later.
    if (record.status === "waiting") return;
    const task = heuristicTask(instance);
    if (task?.state === "waiting") return;
    const state: TaskState =
      record.status === "running"
        ? "running"
        : record.status === "ended" || task?.state === "running" || task?.state === "ended"
          ? "ended"
          : "idle";
    const result = record.status === "ended" ? record.result : undefined;
    if (
      task &&
      owned.get(instance.id) === task.sequence &&
      task.state === state &&
      task.result === result
    )
      return;
    const starts = state === "running" && task?.state !== "running";
    observeTerminalTask(instance.id, {
      taskId: starts ? String((task?.sequence ?? 0) + 1) : task?.taskId,
      state,
      result,
    });
    const written = useTerminalStore.getState().instances.find((entry) => entry.id === instance.id);
    const sequence = written && heuristicTask(written)?.sequence;
    if (sequence !== undefined) owned.set(instance.id, sequence);
  }

  function schedule(delay = POLL_MS) {
    if (disposed || inFlight || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void poll();
    }, delay);
  }

  async function poll() {
    if (disposed || inFlight) return;
    const now = Date.now();
    const targets = useTerminalStore
      .getState()
      .instances.filter(
        (instance) =>
          needsRecord(instance, now) || (recordedAgent(instance) && requested.has(instance.id)),
      );
    if (targets.length === 0) return;
    for (const target of targets) requested.delete(target.id);
    inFlight = true;
    const stamps = new Map(targets.map((instance) => [instance.id, stamp(instance)]));
    try {
      const records = await getAgentSessionStates(
        targets.filter((instance) => recordedAgent(instance) === "Claude").map(({ id }) => id),
        targets.filter((instance) => recordedAgent(instance) === "Grok").map(({ id }) => id),
      );
      if (disposed) return;
      for (const [id, before] of stamps) {
        const current = useTerminalStore.getState().instances.find((entry) => entry.id === id);
        const record = records[id];
        if (!current || !record || stamp(current) !== before) continue;
        if (current.generation !== undefined && record.generation !== current.generation) continue;
        apply(current, record);
      }
    } catch {
      // A failed read keeps the current state; the title still observes.
    } finally {
      inFlight = false;
      schedule(requested.size ? 0 : POLL_MS);
    }
  }

  const unsubscribe = useTerminalStore.subscribe((state) => {
    for (const id of owned.keys())
      if (!state.instances.some((instance) => instance.id === id)) owned.delete(id);
    const now = Date.now();
    if (state.instances.some((instance) => needsRecord(instance, now))) schedule(0);
  });
  schedule(0);
  const unsubscribeSettings = useSettingsStore.subscribe((state, previous) => {
    if (state.grok.stateDetection !== previous.grok.stateDetection) schedule(0);
  });
  const stopRefresh = onTaskStateRefresh((ids) => {
    for (const i of useTerminalStore.getState().instances)
      if (ids.includes(i.id) && recordedAgent(i)) requested.add(i.id);
    if (!requested.size) return;
    clearTimeout(timer);
    timer = undefined;
    schedule(0);
  });
  return () => {
    disposed = true;
    unsubscribe();
    unsubscribeSettings();
    stopRefresh();
    clearTimeout(timer);
  };
}
