import { getCodexTurnStates, type CodexTurnSnapshot } from "./tauri-api";
import { useTerminalStore, type TerminalInstance } from "@/stores/terminal-store";
import { observeTaskInput, observeTerminalTask } from "./terminal-task-observers";

const POLL_MS = 1000;
const STALE_MS = 6000;

function isCodex(instance: TerminalInstance): boolean {
  return (
    instance.sessionReady !== false &&
    instance.activity?.type === "interactiveApp" &&
    instance.activity.name === "Codex"
  );
}

function sourceKey(turn: CodexTurnSnapshot): string {
  return `${turn.generation}:${turn.selectionKey ?? ""}:${turn.sessionId ?? ""}`;
}

/** One in-flight lookup for all panes. Output events keep their independent state. */
export function subscribeCodexTurnStates(): () => void {
  let disposed = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let epoch = 0;
  const epochs = new Map(
    useTerminalStore.getState().instances.map((instance) => [instance.id, ++epoch]),
  );

  function unknown(id: string) {
    const current = useTerminalStore.getState().instances.find((instance) => instance.id === id);
    if (!current || !isCodex(current)) return;
    observeTerminalTask(id, { source: current.task?.source, state: undefined });
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
    const targets = useTerminalStore.getState().instances.filter(isCodex);
    if (targets.length === 0) return;
    inFlight = true;
    const stamps = new Map(
      targets.map((instance) => [
        instance.id,
        {
          epoch: epochs.get(instance.id) ?? 0,
          inputAt: instance.lastUserInputAt,
          taskEpoch: instance.taskEpoch,
        },
      ]),
    );
    function currentTarget(id: string): TerminalInstance | undefined {
      const current = useTerminalStore.getState().instances.find((instance) => instance.id === id);
      const stamp = stamps.get(id);
      return current &&
        stamp &&
        isCodex(current) &&
        stamp.epoch === (epochs.get(id) ?? 0) &&
        stamp.inputAt === current.lastUserInputAt &&
        stamp.taskEpoch === current.taskEpoch
        ? current
        : undefined;
    }
    let expired = false;
    expiry = setTimeout(() => {
      expired = true;
      if (!disposed) for (const id of stamps.keys()) if (currentTarget(id)) unknown(id);
    }, STALE_MS);
    try {
      const snapshots = await getCodexTurnStates();
      if (disposed || expired) return;
      for (const id of stamps.keys()) {
        const current = currentTarget(id);
        if (!current) continue;
        const snapshot = snapshots[id];
        if (
          snapshot &&
          current.generation !== undefined &&
          snapshot.generation !== current.generation
        )
          continue;
        if (!snapshot || snapshot.state === "unknown") {
          unknown(id);
          continue;
        }
        const source = sourceKey(snapshot);
        const taskId = snapshot.turnId ?? "idle";
        const deferred = current.deferredTaskInput;
        const changedTask = current.task?.source !== source || current.task?.taskId !== taskId;
        useTerminalStore.getState().updateInstanceInfo(id, {
          codexTurn: snapshot,
          ...(changedTask ? { deferredTaskInput: undefined } : {}),
        });
        observeTerminalTask(id, {
          source,
          taskId,
          state:
            snapshot.state === "running" ? "running" : snapshot.state === "idle" ? "idle" : "ended",
          result:
            snapshot.state === "completed"
              ? "success"
              : snapshot.state === "failed"
                ? "failure"
                : snapshot.state === "interrupted"
                  ? "interrupted"
                  : undefined,
        });
        if (
          deferred?.observation &&
          deferred.source === source &&
          deferred.taskId !== taskId &&
          deferred.inputAt === current.lastUserInputAt &&
          snapshot.state === "running"
        )
          observeTaskInput(id, true);
      }
    } catch {
      if (!disposed) for (const id of stamps.keys()) if (currentTarget(id)) unknown(id);
    } finally {
      clearTimeout(expiry);
      expiry = undefined;
      inFlight = false;
      schedule();
    }
  }

  const unsubscribe = useTerminalStore.subscribe((state, before) => {
    const currentById = new Map(state.instances.map((instance) => [instance.id, instance]));
    const oldById = new Map(before.instances.map((instance) => [instance.id, instance]));
    const ids = new Set([...currentById.keys(), ...oldById.keys()]);
    for (const id of ids) {
      const current = currentById.get(id);
      const old = oldById.get(id);
      if (
        !!current !== !!old ||
        (current &&
          old &&
          (isCodex(current) !== isCodex(old) ||
            current.sessionReady !== old.sessionReady ||
            current.taskEpoch !== old.taskEpoch))
      ) {
        if (current) epochs.set(id, ++epoch);
        else epochs.delete(id);
        if (current?.codexTurn)
          useTerminalStore.getState().updateInstanceInfo(id, { codexTurn: undefined });
      }
      if (current && old && isCodex(current) && current.lastUserInputAt !== old.lastUserInputAt) {
        // A submitted local command is not a new task; invalidate in-flight reads only.
        schedule(0);
      }
    }
    if (state.instances.some(isCodex)) schedule(0);
  });
  schedule(0);
  return () => {
    disposed = true;
    unsubscribe();
    clearTimeout(timer);
    clearTimeout(expiry);
  };
}
