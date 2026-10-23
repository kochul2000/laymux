import { useWorkspaceStore } from "@/stores/workspace-store";
import { useUiStore } from "@/stores/ui-store";
import { useDockStore } from "@/stores/dock-store";
import { switchActiveWorkspace } from "./workspace-transition";
import { WORKSPACE_CLOSE_GRACE_MS } from "./workspace-close-timing";

export { WORKSPACE_CLOSE_GRACE_MS } from "./workspace-close-timing";
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** The host owns deadlines, even when a selector unmounts or Remote disconnects. */
export function requestWorkspaceClose(id: string): boolean {
  const state = useWorkspaceStore.getState();
  if (state.pendingWorkspaceCloses.some((item) => item.id === id)) return true;
  const workspace = state.workspaces.find((ws) => ws.id === id);
  if (!workspace) return false;
  const remaining = state.getOrderedWorkspaces().filter((ws) => ws.id !== id);
  const hidden = useUiStore.getState().hiddenWorkspaceIds;
  const landing = remaining.find((ws) => !hidden.has(ws.id));
  if (!landing) return false;
  if (state.activeWorkspaceId === id) {
    switchActiveWorkspace(landing.id, {
      preserveDockFocus: useDockStore.getState().focusedDock !== null,
    });
  }
  const pending = { id, name: workspace.name, expiresAt: Date.now() + WORKSPACE_CLOSE_GRACE_MS };
  useWorkspaceStore.setState((current) => ({
    pendingWorkspaceCloses: [...current.pendingWorkspaceCloses, pending],
  }));
  clearTimeout(timers.get(id));
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id);
      // A reset/reload or a restore followed by a new close must not let an old
      // deadline remove a different request that happens to have the same id.
      if (useWorkspaceStore.getState().pendingWorkspaceCloses.includes(pending)) {
        useWorkspaceStore.getState().removeWorkspace(id);
      }
    }, WORKSPACE_CLOSE_GRACE_MS),
  );
  return true;
}

export function restoreWorkspaceClose(id: string): boolean {
  const state = useWorkspaceStore.getState();
  const pending = state.pendingWorkspaceCloses.find((item) => item.id === id);
  if (!pending || pending.expiresAt <= Date.now()) return false;
  clearTimeout(timers.get(id));
  timers.delete(id);
  useWorkspaceStore.setState({
    pendingWorkspaceCloses: state.pendingWorkspaceCloses.filter((item) => item.id !== id),
  });
  return true;
}
