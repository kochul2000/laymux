import { useSettingsStore } from "@/stores/settings-store";
import { useTerminalStore } from "@/stores/terminal-store";
import { getAgentHookStates, type HookProvider } from "./agent-hooks-api";

/** Bounded verification lease; a stalled backend never pins hook state. */
export function subscribeAgentHookStates(): () => void {
  let disposed = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const providers = () =>
    (["claude", "codex"] as HookProvider[]).filter(
      (p) => useSettingsStore.getState()[p].stateDetection === "hooks",
    );
  function schedule(delay = 2000) {
    if (disposed || inFlight || timer !== undefined || !providers().length) return;
    timer = setTimeout(() => {
      timer = undefined;
      void poll();
    }, delay);
  }
  async function poll() {
    if (disposed || inFlight) return;
    const selected = providers();
    if (!selected.length) return;
    inFlight = true;
    const stamps = new Map(
      useTerminalStore
        .getState()
        .instances.map((i) => [i.id, `${i.generation}:${i.taskEpoch}:${i.lastUserInputAt}`]),
    );
    try {
      const states = await getAgentHookStates(selected);
      if (disposed) return;
      for (const current of useTerminalStore.getState().instances) {
        if (
          stamps.get(current.id) !==
          `${current.generation}:${current.taskEpoch}:${current.lastUserInputAt}`
        )
          continue;
        const snapshot = states[current.id];
        const enabled = snapshot && providers().includes(snapshot.provider);
        useTerminalStore.getState().observeAgentHook(current.id, enabled ? snapshot : undefined);
      }
    } catch {
      if (!disposed)
        for (const instance of useTerminalStore.getState().instances)
          useTerminalStore.getState().observeAgentHook(instance.id, undefined);
    } finally {
      inFlight = false;
      schedule();
    }
  }
  const settings = useSettingsStore.subscribe((state, previous) => {
    if (
      state.claude.stateDetection !== previous.claude.stateDetection ||
      state.codex.stateDetection !== previous.codex.stateDetection
    ) {
      useTerminalStore.getState().refreshTaskDetection();
      schedule(0);
    }
  });
  schedule(0);
  return () => {
    disposed = true;
    settings();
    clearTimeout(timer);
  };
}
