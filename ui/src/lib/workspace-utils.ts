import { useTerminalStore } from "@/stores/terminal-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

/** Resolve the workspace ID for a terminal instance (for notifications). */
export function resolveWorkspaceId(terminalId: string): string {
  const inst = useTerminalStore.getState().instances.find((i) => i.id === terminalId);
  const { workspaces, activeWorkspaceId } = useWorkspaceStore.getState();
  if (inst?.workspaceId) return inst.workspaceId;
  if (inst?.syncGroup) {
    const ws = workspaces.find((w) => w.id === inst.syncGroup);
    if (ws) return ws.id;
  }
  return activeWorkspaceId;
}
