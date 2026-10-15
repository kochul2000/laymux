import { invoke } from "@tauri-apps/api/core";
import { useTerminalStore, type TerminalInstance } from "@/stores/terminal-store";
import { useTerminalDisplayStore } from "@/stores/terminal-display-store";

export type TerminalDisplayContext = Partial<
  Pick<
    TerminalInstance,
    | "title"
    | "cwd"
    | "branch"
    | "activity"
    | "activityMessage"
    | "lastCommand"
    | "lastExitCode"
    | "lastCommandAt"
    | "lastUserInput"
    | "lastUserInputAt"
    | "task"
    | "lastActivityAt"
  >
> & { version: 1; profile: string };

const fields = [
  "title",
  "cwd",
  "branch",
  "activity",
  "activityMessage",
  "lastCommand",
  "lastExitCode",
  "lastCommandAt",
  "lastUserInput",
  "lastUserInputAt",
  "lastActivityAt",
] as const;

/** Display projection only. Never pass this object to operational task policy. */
export function projectTerminalDisplay(
  instance: TerminalInstance,
  history?: TerminalDisplayContext,
): TerminalInstance {
  if (!history || history.profile !== instance.profile) return instance;
  const newerInput = (instance.lastUserInputAt ?? 0) > (history.lastUserInputAt ?? 0);
  const differentActivity =
    instance.activity &&
    history.activity &&
    (instance.activity.type !== history.activity.type ||
      instance.activity.name !== history.activity.name);
  const newerCommand = (instance.lastCommandAt ?? 0) > (history.lastCommandAt ?? 0);
  const fallback = Object.fromEntries(
    fields
      .filter((key) => !Object.hasOwn(instance, key) && history[key] !== undefined)
      .filter((key) => !(differentActivity && (key === "activityMessage" || key === "title")))
      .filter((key) => !(newerCommand && key === "lastExitCode"))
      .map((key) => [key, history[key]]),
  );
  const previousTask = !newerInput && !differentActivity ? history.task : undefined;
  const task =
    previousTask && (!instance.task?.state || instance.task.state === "idle")
      ? { ...previousTask, observation: "stale" as const, notification: undefined }
      : instance.task;
  return {
    ...instance,
    ...fallback,
    lastActivityAt: Math.max(instance.lastActivityAt, history.lastActivityAt ?? 0),
    task,
  };
}

function snapshot(instance: TerminalInstance): TerminalDisplayContext {
  const displayValue = (key: (typeof fields)[number]) => {
    const value = instance[key];
    return typeof value === "string"
      ? Array.from(value)
          .slice(0, key === "lastUserInput" ? 2048 : 512)
          .join("")
      : value;
  };
  return {
    version: 1,
    profile: instance.profile,
    ...Object.fromEntries(fields.map((key) => [key, displayValue(key)])),
    // Notification delivery history and live authority do not cross the GUI.
    task: instance.task
      ? {
          ...instance.task,
          source: instance.task.source.slice(0, 128),
          taskId: instance.task.taskId.slice(0, 128),
          notification: undefined,
          notificationId: 0,
        }
      : undefined,
  };
}
function fingerprint(context: TerminalDisplayContext): string {
  return JSON.stringify({
    ...context,
    lastActivityAt: undefined,
    task: context.task
      ? {
          state: context.task.state,
          result: context.task.result,
          taskId: context.task.taskId,
          source: context.task.source,
        }
      : undefined,
  });
}
function validContext(value: unknown): value is TerminalDisplayContext {
  return (
    !!value &&
    typeof value === "object" &&
    "version" in value &&
    value.version === 1 &&
    "profile" in value &&
    typeof value.profile === "string"
  );
}

let currentSync: { scan: () => void; flush: () => Promise<void> } | undefined;

export function startTerminalDisplayContextSync(): () => void {
  let cancelled = false;
  type Entry = {
    generation: number;
    initializing?: Promise<void>;
    running?: Promise<void>;
    pending?: TerminalDisplayContext;
    timer?: ReturnType<typeof setTimeout>;
    previous?: TerminalInstance;
    queued?: string;
    supported: boolean;
    error?: unknown;
    task?: TerminalInstance["task"];
  };
  const entries = new Map<string, Entry>();
  let catalog = new Map(useTerminalStore.getState().instances.map((i) => [i.id, i]));
  const current = (id: string, entry: Entry) =>
    !cancelled &&
    entries.get(id) === entry &&
    catalog.get(id)?.generation === entry.generation &&
    catalog.get(id)?.sessionReady === true;
  const send = (id: string, entry: Entry) => {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    if (entry.running || !entry.pending || !entry.supported || !current(id, entry)) return;
    entry.running = (async () => {
      while (entry.pending && entry.supported && current(id, entry)) {
        const context = entry.pending;
        entry.pending = undefined;
        try {
          entry.supported = await invoke<boolean>("save_terminal_display_context", {
            id,
            generation: entry.generation,
            context,
          });
          entry.error = undefined;
        } catch (error) {
          entry.error = error;
          break;
        }
      }
    })().finally(() => {
      entry.running = undefined;
    });
  };
  const publish = (id: string, entry: Entry, initial = false) => {
    if (!current(id, entry) || entry.initializing || !entry.supported) return;
    const instance = catalog.get(id)!;
    if (!initial && entry.previous === instance && !entry.error) return;
    entry.previous = instance;
    let history = useTerminalDisplayStore.getState().contexts[id];
    if (!initial && instance.task !== entry.task && instance.task?.state && history?.task) {
      history = { ...history, task: undefined };
    }
    entry.task = instance.task;
    const context = snapshot(projectTerminalDisplay(instance, history));
    if (fingerprint(context) === entry.queued && !entry.error) return;
    entry.queued = fingerprint(context);
    entry.pending = context;
    useTerminalDisplayStore.getState().setContext(id, context);
    if (!entry.timer) entry.timer = setTimeout(() => send(id, entry), 500);
  };
  const scan = () => {
    if (cancelled) return;
    const instances = useTerminalStore.getState().instances;
    catalog = new Map(instances.map((i) => [i.id, i]));
    for (const id of entries.keys()) {
      if (!catalog.has(id)) {
        const removed = entries.get(id);
        if (removed?.timer) clearTimeout(removed.timer);
        entries.delete(id);
        useTerminalDisplayStore.getState().setContext(id, undefined);
      }
    }
    for (const instance of instances) {
      if (!instance.sessionReady || instance.generation === undefined) continue;
      let entry = entries.get(instance.id);
      if (!entry || entry.generation !== instance.generation) {
        if (entry?.timer) clearTimeout(entry.timer);
        entry = { generation: instance.generation, supported: true };
        entries.set(instance.id, entry);
        const initializing = entry;
        initializing.initializing = (async () => {
          try {
            const value = await invoke<unknown>("get_terminal_display_context", {
              id: instance.id,
              generation: initializing.generation,
            });
            if (!current(instance.id, initializing)) return;
            const history =
              validContext(value) && value.profile === instance.profile ? value : undefined;
            useTerminalDisplayStore.getState().setContext(instance.id, history);
            const latest = useTerminalStore.getState().instances.find((i) => i.id === instance.id)!;
            if (
              history?.lastUserInput !== undefined &&
              (history.lastUserInputAt ?? 0) > (latest.lastUserInputAt ?? 0)
            ) {
              // Historical input is not a newly submitted command or task input.
              useTerminalStore.setState((state) => ({
                instances: state.instances.map((i) =>
                  i.id === instance.id && i.generation === initializing.generation
                    ? {
                        ...i,
                        lastUserInput: history.lastUserInput,
                        lastUserInputAt: history.lastUserInputAt,
                      }
                    : i,
                ),
              }));
            }
          } catch (error) {
            initializing.error = error;
          }
        })().finally(() => {
          initializing.initializing = undefined;
          publish(instance.id, initializing, true);
        });
      } else publish(instance.id, entry);
    }
  };
  const sync = {
    scan,
    flush: async () => {
      scan();
      const activeEntries = () =>
        [...entries].filter(([id, entry]) => current(id, entry)).map(([, entry]) => entry);
      while (
        activeEntries().some((e) => e.initializing || e.running || (e.pending && e.supported))
      ) {
        await Promise.all(
          activeEntries().flatMap((e) =>
            [e.initializing, e.running].filter((p): p is Promise<void> => !!p),
          ),
        );
        for (const [id, entry] of entries) send(id, entry);
      }
      const error = [...entries.values()].find((e) => e.error)?.error;
      if (error) throw error;
    },
  };
  currentSync = sync;
  const unsubscribe = useTerminalStore.subscribe(scan);
  scan();
  return () => {
    cancelled = true;
    for (const entry of entries.values()) if (entry.timer) clearTimeout(entry.timer);
    unsubscribe();
    if (currentSync === sync) currentSync = undefined;
  };
}

export async function flushTerminalDisplayContexts(): Promise<void> {
  await currentSync?.flush();
}

export async function loadTerminalDisplayContexts(
  profiles: Record<string, string>,
  isCurrent = () => true,
): Promise<void> {
  const contexts = await invoke<Record<string, unknown>>("load_terminal_display_contexts", {
    profiles,
  });
  if (!isCurrent()) return;
  for (const [id, value] of Object.entries(contexts)) {
    // A mounted terminal has already obtained its exact attach's context.
    if (
      !useTerminalStore.getState().instances.some((i) => i.id === id && i.sessionReady) &&
      validContext(value) &&
      value.profile === profiles[id]
    ) {
      useTerminalDisplayStore.getState().setContext(id, value);
    }
  }
}
