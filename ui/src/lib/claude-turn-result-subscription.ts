import { beginClaudeTurns, getClaudeTurnResults, type ClaudeTurnOutcome } from "./tauri-api";
import { useTerminalStore, type TerminalInstance } from "@/stores/terminal-store";
import {
  claudeTurnKey,
  claudeTurnPending,
  type ClaudeTurn,
  type ClaudeTurnSource,
} from "./claude-turn-result";
import { heuristicTask } from "./terminal-task-detection";
import type { TerminalTask } from "./terminal-task";

const POLL_MS = 1000;
/** A result not appended this long after the end is given up (ADR-0340). */
const RESULT_WINDOW_MS = 10_000;
const SOURCES: ClaudeTurnSource[] = ["heuristic", "hook"];

function isClaude(instance: TerminalInstance) {
  return (
    instance.sessionReady !== false &&
    instance.activity?.type === "interactiveApp" &&
    instance.activity.name === "Claude"
  );
}

function sourceTask(
  instance: TerminalInstance,
  source: ClaudeTurnSource,
): TerminalTask | undefined {
  return source === "hook" ? instance.agentHook?.task : heuristicTask(instance);
}

/** Any change here means a result read no longer describes that task. */
function stamp(instance: TerminalInstance, source: ClaudeTurnSource): string {
  const task = sourceTask(instance, source);
  return [
    instance.generation,
    instance.taskEpoch,
    instance.lastUserInputAt,
    task?.source,
    task?.taskId,
    task?.sequence,
  ].join("\u0000");
}

function find(id: string) {
  return useTerminalStore.getState().instances.find((entry) => entry.id === id);
}

function setTurn(id: string, source: ClaudeTurnSource, turn: ClaudeTurn | undefined) {
  const turns = { ...find(id)?.claudeTurns, [source]: turn };
  useTerminalStore.getState().updateInstanceInfo(id, { claudeTurns: turns });
}

function currentTurn(id: string, source: ClaudeTurnSource, key: string) {
  const turn = find(id)?.claudeTurns?.[source];
  return turn?.key === key ? turn : undefined;
}

function pendingLookup(instance: TerminalInstance) {
  return SOURCES.some((source) =>
    claudeTurnPending(sourceTask(instance, source), instance.claudeTurns?.[source]),
  );
}

interface Target {
  id: string;
  source: ClaudeTurnSource;
  key: string;
}

/**
 * ADR-0340: when a Claude task starts, record its transcript baseline; when it
 * ends without a result, read the result appended after that baseline. The
 * heuristic and hook tasks each get their own turn, and the result stays raw
 * state that task selection applies to the displayed one.
 */
export function subscribeClaudeTurnResults(): () => void {
  let disposed = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const beginning = new Map<string, Target>();

  function begin() {
    if (beginning.size === 0) return;
    const targets = [...beginning.values()];
    beginning.clear();
    const settle = (recorded: string[]) => {
      if (disposed) return;
      for (const { id, source, key } of targets) {
        const turn = currentTurn(id, source, key);
        if (!turn || turn.tracked !== undefined) continue;
        const tracked = recorded.includes(`${id}\u0000${key}`);
        setTurn(id, source, { ...turn, tracked, settled: turn.settled || !tracked });
      }
    };
    beginClaudeTurns(targets.map(({ id, key }) => ({ terminalId: id, key })))
      .then((recorded) =>
        settle(recorded.map(({ terminalId, key }) => `${terminalId}\u0000${key}`)),
      )
      .catch(() => settle([]));
  }

  function observe(instances: TerminalInstance[]) {
    const now = Date.now();
    for (const instance of instances) {
      if (!isClaude(instance)) {
        if (instance.claudeTurns)
          useTerminalStore.getState().updateInstanceInfo(instance.id, { claudeTurns: undefined });
        continue;
      }
      for (const source of SOURCES) {
        const task = sourceTask(instance, source);
        const turn = instance.claudeTurns?.[source];
        if (!task) continue;
        const key = claudeTurnKey(task);
        if ((task.state === "running" || task.state === "waiting") && turn?.key !== key) {
          setTurn(instance.id, source, { key, settled: false });
          beginning.set(`${instance.id}\u0000${source}`, { id: instance.id, source, key });
        } else if (task.state === "ended" && turn?.key === key && turn.endedAt === undefined) {
          // A task that ended with its own result needs nothing more.
          setTurn(instance.id, source, {
            ...turn,
            endedAt: now,
            settled: turn.settled || !!task.result,
          });
        }
      }
    }
    begin();
    if (instances.some(pendingLookup)) schedule();
  }

  function schedule(delay = POLL_MS) {
    if (disposed || inFlight || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void poll();
    }, delay);
  }

  function apply({ id, source, key }: Target, outcome: ClaudeTurnOutcome) {
    if (outcome === "pending") return;
    const turn = currentTurn(id, source, key);
    if (!turn || turn.settled) return;
    const result =
      outcome === "success" || outcome === "failure" || outcome === "interrupted"
        ? outcome
        : undefined;
    setTurn(id, source, { ...turn, result, settled: true });
  }

  async function poll() {
    if (disposed || inFlight) return;
    const now = Date.now();
    const targets: (Target & { stamp: string })[] = [];
    for (const instance of useTerminalStore.getState().instances) {
      for (const source of SOURCES) {
        const turn = instance.claudeTurns?.[source];
        if (!turn || turn.tracked !== true) continue;
        if (!claudeTurnPending(sourceTask(instance, source), turn)) continue;
        if (now - (turn.endedAt ?? now) > RESULT_WINDOW_MS) {
          setTurn(instance.id, source, { ...turn, settled: true });
          continue;
        }
        targets.push({ id: instance.id, source, key: turn.key, stamp: stamp(instance, source) });
      }
    }
    if (targets.length === 0) return;
    inFlight = true;
    try {
      const results = await getClaudeTurnResults(
        targets.map(({ id, key }) => ({ terminalId: id, key })),
      );
      if (disposed) return;
      const outcomes = Object.fromEntries(
        results.map(({ terminalId, key, outcome }) => [`${terminalId}\u0000${key}`, outcome]),
      );
      for (const target of targets) {
        const current = find(target.id);
        // A new prompt or task since the request makes the read stale.
        if (!current || stamp(current, target.source) !== target.stamp) continue;
        apply(target, outcomes[`${target.id}\u0000${target.key}`] ?? "unknown");
      }
    } catch {
      // A failed read keeps the turn pending until its window closes.
    } finally {
      inFlight = false;
      if (useTerminalStore.getState().instances.some(pendingLookup)) schedule();
    }
  }

  const unsubscribe = useTerminalStore.subscribe((state) => observe(state.instances));
  observe(useTerminalStore.getState().instances);
  return () => {
    disposed = true;
    unsubscribe();
    clearTimeout(timer);
  };
}
