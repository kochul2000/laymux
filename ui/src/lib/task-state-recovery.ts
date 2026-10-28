import { invoke } from "@tauri-apps/api/core";
import { onTaskStateRefresh } from "./task-state-refresh";
import { useTerminalStore } from "@/stores/terminal-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { requestTaskStateRefresh } from "./task-state-refresh";

export function refreshWorkspaceTaskStates(workspaceId: string): void {
  requestTaskStateRefresh(
    useTerminalStore
      .getState()
      .instances.filter((i) => i.workspaceId === workspaceId)
      .map((i) => i.id),
  );
}

/** Desktop and Remote focus both reach the host stores; no periodic whole-app sweep. */
export function subscribeTaskStateRecovery(): () => void {
  const stopActivity = onTaskStateRefresh((ids) => {
    void invoke("request_terminal_activity_refresh", { ids: [...ids] }).catch(() => {});
  });
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
  const refresh = () => refreshWorkspaceTaskStates(useWorkspaceStore.getState().activeWorkspaceId);
  const foreground = () => {
    if (!document.hidden) refresh();
  };
  document.addEventListener("visibilitychange", foreground);
  refresh();
  return () => {
    stopActivity();
    terminals();
    workspaces();
    document.removeEventListener("visibilitychange", foreground);
  };
}
