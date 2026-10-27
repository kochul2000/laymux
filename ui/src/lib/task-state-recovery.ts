import { useTerminalStore } from "@/stores/terminal-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { requestTaskStateRefresh } from "./task-state-refresh";

export const TASK_STATE_RECOVERY_MS = 60_000;

export function refreshWorkspaceTaskStates(workspaceId: string): void {
  requestTaskStateRefresh(
    useTerminalStore
      .getState()
      .instances.filter((i) => i.workspaceId === workspaceId)
      .map((i) => i.id),
  );
}

/** Desktop and Remote focus both reach the host stores. Hidden panes also get a sweep. */
export function subscribeTaskStateRecovery(): () => void {
  const terminals = useTerminalStore.subscribe((state, before) => {
    const previous = new Map(before.instances.map((i) => [i.id, i]));
    requestTaskStateRefresh(
      state.instances
        .filter((i) => {
          const old = previous.get(i.id);
          return (
            (i.isFocused && !old?.isFocused) ||
            (i.sessionReady === true && old?.sessionReady !== true)
          );
        })
        .map((i) => i.id),
    );
  });
  const workspaces = useWorkspaceStore.subscribe((state, before) => {
    if (state.activeWorkspaceId !== before.activeWorkspaceId)
      refreshWorkspaceTaskStates(state.activeWorkspaceId);
  });
  const refresh = () =>
    requestTaskStateRefresh(useTerminalStore.getState().instances.map((i) => i.id));
  const foreground = () => {
    if (!document.hidden) refresh();
  };
  document.addEventListener("visibilitychange", foreground);
  const timer = setInterval(refresh, TASK_STATE_RECOVERY_MS);
  refresh();
  return () => {
    terminals();
    workspaces();
    document.removeEventListener("visibilitychange", foreground);
    clearInterval(timer);
  };
}
